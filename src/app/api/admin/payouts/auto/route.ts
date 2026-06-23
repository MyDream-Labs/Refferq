import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { UserStatus } from '@prisma/client';
import { getProgramSettings } from '@/lib/program-settings';


async function verifyAdmin(request: NextRequest) {
  try {
    const userId = request.headers.get('x-user-id');
    if (!userId) return null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, status: true }
    });
    if (!user || user.role !== 'ADMIN' || user.status !== UserStatus.ACTIVE) return null;
    return user;
  } catch (_e) { return null; }
}

// POST - Process auto-payouts for all eligible affiliates
export async function POST(request: NextRequest) {
  const admin = await verifyAdmin(request);
  if (!admin) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 });
  }

  try {
    const { dryRun = false } = await request.json().catch(() => ({ dryRun: false }));

    const settings = await getProgramSettings();
    const minPayoutCents = settings.minPayoutCents;

    // Find eligible commissions for payout by affiliate, scoped by payout threshold.
    // Status check is on User model, not Affiliate
    const eligibleCommissions = await prisma.commission.findMany({
      where: {
        status: 'APPROVED',
        payoutId: null,
        affiliate: {
          user: {
            status: UserStatus.ACTIVE,
          },
        },
      },
      include: {
        affiliate: {
          select: {
            id: true,
            user: {
              select: {
                name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    const commissionsByAffiliate = new Map<
      string,
      {
        affiliateId: string;
        affiliateUserId: string;
        affiliateName: string | null;
        affiliateEmail: string | null;
        totalAmountCents: number;
        commissionIds: string[];
      }
    >();

    for (const commission of eligibleCommissions) {
      const item = commissionsByAffiliate.get(commission.affiliateId);
      if (!item) {
        commissionsByAffiliate.set(commission.affiliateId, {
          affiliateId: commission.affiliateId,
          affiliateUserId: commission.userId,
          affiliateName: commission.affiliate.user?.name || null,
          affiliateEmail: commission.affiliate.user?.email || null,
          totalAmountCents: commission.amountCents,
          commissionIds: [commission.id],
        });
      } else {
        item.totalAmountCents += commission.amountCents;
        item.commissionIds.push(commission.id);
      }
    }

    const eligibleAffiliates = Array.from(commissionsByAffiliate.values()).filter(
      (entry) => entry.totalAmountCents >= minPayoutCents,
    );

    if (eligibleAffiliates.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No affiliates eligible for auto-payout',
        processed: 0,
        totalAmountCents: 0,
      });
    }

    if (dryRun) {
      return NextResponse.json({
        success: true,
        dryRun: true,
        eligible: eligibleAffiliates.map(a => ({
          affiliateId: a.affiliateId,
          name: a.affiliateName,
          email: a.affiliateEmail,
          payoutCents: a.totalAmountCents,
          commissions: a.commissionIds.length,
        })),
        totalAffiliates: eligibleAffiliates.length,
        totalAmountCents: eligibleAffiliates.reduce((s, a) => s + a.totalAmountCents, 0),
      });
    }

    // Process payouts
    const results: Array<{
      affiliateId: string;
      name: string;
      payoutId?: string;
      amountCents?: number;
      status: string;
      error?: string;
    }> = [];
    let totalProcessed = 0;
    let totalAmountCents = 0;

    for (const affiliate of eligibleAffiliates) {
      try {
        const payoutAmountCents = affiliate.totalAmountCents;

        const payout = await prisma.$transaction(async (tx) => {
          const commissions = await tx.commission.findMany({
            where: {
              id: { in: affiliate.commissionIds },
              status: 'APPROVED',
              payoutId: null,
            },
          });

          if (commissions.length === 0) {
            throw new Error('No qualifying commissions remained for payout.');
          }

          const amountCents = commissions.reduce((sum, item) => sum + item.amountCents, 0);

          if (amountCents !== payoutAmountCents) {
            throw new Error('Payout amount changed during processing.');
          }

          const createdPayout = await tx.payout.create({
            data: {
              affiliateId: affiliate.affiliateId,
              userId: affiliate.affiliateUserId,
              amountCents,
              status: 'PENDING',
              method: 'AUTO',
              notes: 'Auto-payout processed',
              createdBy: admin.id,
            },
          });

          const balanceUpdate = await tx.affiliate.updateMany({
            where: {
              id: affiliate.affiliateId,
              balanceCents: payoutAmountCents,
            },
            data: {
              balanceCents: 0,
            },
          });

          if (balanceUpdate.count !== 1) {
            throw new Error('Affiliate balance changed during processing');
          }

          const commissionUpdate = await tx.commission.updateMany({
            where: {
              id: { in: commissions.map((entry) => entry.id) },
              payoutId: null,
              status: 'APPROVED',
            },
            data: {
              status: 'PAID',
              payoutId: createdPayout.id,
              paidAt: new Date(),
            },
          });

          if (commissionUpdate.count !== commissions.length) {
            throw new Error('Commission payout state changed before commit.');
          }

          await tx.auditLog.create({
            data: {
              action: 'AUTO_PAYOUT_CREATED',
              actorId: admin.id,
              objectType: 'payout',
              objectId: createdPayout.id,
              payload: {
                affiliateId: affiliate.affiliateId,
                amountCents: payoutAmountCents,
              },
            },
          });

          return createdPayout;
        });

        results.push({
          affiliateId: affiliate.affiliateId,
          name: affiliate.affiliateName || 'Unknown',
          payoutId: payout.id,
          amountCents: payoutAmountCents,
          status: 'CREATED',
        });

        totalProcessed++;
        totalAmountCents += payoutAmountCents;
      } catch (err) {
        results.push({
          affiliateId: affiliate.affiliateId,
          name: affiliate.affiliateName || 'Unknown',
          status: 'FAILED',
          error: (err as Error).message,
        });
      }
    }

    return NextResponse.json({
      success: true,
      message: `Auto-payout processed for ${totalProcessed} affiliates`,
      processed: totalProcessed,
      totalAmountCents,
      results,
    });
  } catch (error) {
    console.error('Auto-payout error:', error);
    return NextResponse.json({ success: false, error: 'Failed to process auto-payouts' }, { status: 500 });
  }
}

// GET - Get auto-payout configuration and status
export async function GET(request: NextRequest) {
  const admin = await verifyAdmin(request);
  if (!admin) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 });
  }

  try {
    const settings = await getProgramSettings();

    const minPayoutCents = settings.minPayoutCents;
    const eligibleCommissions = await prisma.commission.findMany({
      where: {
        status: 'APPROVED',
        payoutId: null,
        affiliate: {
          user: { status: UserStatus.ACTIVE },
        },
      },
      select: { affiliateId: true, amountCents: true },
    });

    const eligibleByAffiliate = new Map<string, number>();
    for (const commission of eligibleCommissions) {
      const prev = eligibleByAffiliate.get(commission.affiliateId) || 0;
      eligibleByAffiliate.set(commission.affiliateId, prev + commission.amountCents);
    }
    const eligibleTotals = Array.from(eligibleByAffiliate.values()).filter((amount) => amount >= minPayoutCents);
    const eligibleCount = eligibleTotals.length;
    const totalPendingAmount = eligibleTotals.reduce((acc, amount) => acc + amount, 0);

    // Recent auto-payouts
    const recentPayouts = await prisma.payout.findMany({
      where: { notes: { contains: 'Auto-payout' } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        affiliate: {
          include: { user: { select: { name: true, email: true } } },
        },
      },
    });

    return NextResponse.json({
      success: true,
      config: {
        minPayoutCents,
        payoutFrequency: settings.payoutFrequency,
        autoPayoutsEnabled: settings.autoApprovePayouts,
      },
      stats: {
        eligibleAffiliates: eligibleCount,
        totalPendingCents: totalPendingAmount,
      },
      recentPayouts,
    });
  } catch (error) {
    console.error('Auto-payout config error:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch config' }, { status: 500 });
  }
}
