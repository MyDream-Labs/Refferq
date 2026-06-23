import { NextRequest, NextResponse } from 'next/server';
import { Prisma, TransactionStatus, UserStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';

type AdminRefundTransaction = Prisma.TransactionGetPayload<{
  include: {
    affiliate: {
      select: {
        id: true;
        userId: true;
      };
    };
  };
}>;

type ReversalTransactionResult = {
  transactionRefunded: boolean;
  commissionReversed: boolean;
  balanceDeducted: boolean;
  reversedCommissionId: string | null;
  reversedAmountCents: number;
  deductedAmountCents: number;
};

async function verifyAdmin(request: NextRequest) {
  try {
    const userId = request.headers.get('x-user-id');
    if (!userId) return null;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        status: true,
      },
    });

    if (!user || user.role !== 'ADMIN' || user.status !== UserStatus.ACTIVE) {
      return null;
    }

    return user;
  } catch (_error) {
    return null;
  }
}

// POST - Process a refund for a transaction
// Automatically reverses associated commissions
export async function POST(request: NextRequest) {
  const admin = await verifyAdmin(request);
  if (!admin) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 });
  }

  try {
    const { transactionId, reason } = (await request.json()) as {
      transactionId?: string;
      reason?: string;
    };

    if (!transactionId) {
      return NextResponse.json({ success: false, error: 'Transaction ID is required' }, { status: 400 });
    }

    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: {
        affiliate: {
          select: {
            id: true,
            userId: true,
          },
        },
      },
    }) as AdminRefundTransaction | null;

    if (!transaction) {
      return NextResponse.json({ success: false, error: 'Transaction not found' }, { status: 404 });
    }

    if (transaction.status === TransactionStatus.REFUNDED) {
      return NextResponse.json({ success: false, error: 'Transaction already refunded' }, { status: 400 });
    }

    // Find associated commissions for this affiliate that are pending/approved.
    // We reverse the most recent one to avoid wide collateral impact.
    const commissions = await prisma.commission.findMany({
      where: {
        affiliateId: transaction.affiliateId,
        status: {
          in: ['PENDING', 'APPROVED'],
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const results: ReversalTransactionResult = {
      transactionRefunded: false,
      commissionReversed: false,
      balanceDeducted: false,
      reversedCommissionId: null,
      reversedAmountCents: 0,
      deductedAmountCents: 0,
    };

    const reversal = await prisma.$transaction(async (tx) => {
      const updatedTransaction = await tx.transaction.update({
        where: { id: transactionId },
        data: {
          status: TransactionStatus.REFUNDED,
          description: `${transaction.description || ''} [REFUNDED: ${reason || 'No reason provided'}]`.trim(),
        },
      });

      const matchingCommission = commissions[0];
      if (!matchingCommission) {
        return {
          transaction: updatedTransaction,
          matchingCommission: null as null,
          results,
        };
      }

      const updatedCommission = await tx.commission.update({
        where: { id: matchingCommission.id },
        data: { status: 'CANCELLED' },
      });

      let balanceDeducted = false;
      let deductedAmount = 0;

      if (matchingCommission.amountCents > 0) {
        const balanceUpdate = await tx.affiliate.updateMany({
          where: {
            id: transaction.affiliateId,
            balanceCents: {
              gte: matchingCommission.amountCents,
            },
          },
          data: {
            balanceCents: {
              decrement: matchingCommission.amountCents,
            },
          },
        });

        balanceDeducted = balanceUpdate.count === 1;
        deductedAmount = balanceDeducted ? matchingCommission.amountCents : 0;
      }

      await tx.auditLog.create({
        data: {
          actorId: admin.id,
          action: 'TRANSACTION_REFUNDED',
          objectType: 'transaction',
          objectId: transactionId,
          payload: {
            reason: reason || 'No reason provided',
            transactionAmountCents: transaction.amountCents,
            commissionReversed: true,
            reversedAmountCents: updatedCommission.amountCents,
            balanceDeducted,
          },
        },
      });

      return {
        transaction: updatedTransaction,
        matchingCommission: updatedCommission,
        results: {
          transactionRefunded: true,
          commissionReversed: true,
          balanceDeducted,
          reversedCommissionId: updatedCommission.id,
          reversedAmountCents: updatedCommission.amountCents,
          deductedAmountCents: deductedAmount,
        },
      };
    });

    // Ensure audit log exists even if no commission was reversible.
    if (!reversal.matchingCommission) {
      await prisma.auditLog.create({
        data: {
          actorId: admin.id,
          action: 'TRANSACTION_REFUNDED',
          objectType: 'transaction',
          objectId: transactionId,
          payload: {
            reason: reason || 'No reason provided',
            transactionAmountCents: transaction.amountCents,
            commissionReversed: false,
            reversedAmountCents: 0,
            balanceDeducted: false,
          },
        },
      });
    }

    const payload = {
      ...reversal.results,
      transactionRefunded: true,
    };

    return NextResponse.json({
      success: true,
      message: 'Refund processed successfully',
      results: payload,
    });
  } catch (error) {
    console.error('Refund processing error:', error);
    return NextResponse.json({ success: false, error: 'Failed to process refund' }, { status: 500 });
  }
}

// GET - List refunded transactions
export async function GET(request: NextRequest) {
  const admin = await verifyAdmin(request);
  if (!admin) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 });
  }

  try {
    const transactions = await prisma.transaction.findMany({
      where: { status: TransactionStatus.REFUNDED },
      include: {
        affiliate: {
          include: {
            user: {
              select: {
                name: true,
                email: true,
              },
            },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    return NextResponse.json({
      success: true,
      transactions,
      count: transactions.length,
    });
  } catch (error) {
    console.error('Failed to fetch refunded transactions:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch refunds' }, { status: 500 });
  }
}
