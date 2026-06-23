import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logAuditAction } from '@/lib/audit';
import { webhookRefundSchema } from '@/lib/validations';
import crypto from 'crypto';

// ─── Webhook Signature Verification ────────────────────────────
function verifyWebhookSignature(payload: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const sig = signature.startsWith('sha256=') ? signature.slice(7) : signature;

  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch (_e) {
    return false;
  }
}

type ApiKeyAuth = {
  actorId: string;
  keyId: string;
};

type RefundUpdate = {
  commissionId: string;
  action: string;
  amountCents: number;
};

async function verifyApiKey(request: NextRequest): Promise<ApiKeyAuth | null> {
  const apiKeyHeader = request.headers.get('x-api-key');
  if (!apiKeyHeader) return null;

  const keyHash = crypto.createHash('sha256').update(apiKeyHeader).digest('hex');
  const key = await prisma.apiKey.findFirst({
    where: { keyHash, isActive: true },
  });

  if (!key) return null;

  return {
    actorId: key.userId,
    keyId: key.id,
  };
}

function extractIdempotencyKey(request: NextRequest, data: { eventId?: string; external_id?: string; refund_id?: string }) {
  return (
    request.headers.get('X-Idempotency-Key') ||
    request.headers.get('x-idempotency-key') ||
    data.eventId?.trim() ||
    data.external_id?.trim() ||
    data.refund_id?.trim() ||
    null
  );
}

function getMetadataObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  return {};
}

function parseAmountCents(data: { amount_cents?: number; amount?: number }) {
  if (data.amount_cents !== undefined) return Math.trunc(data.amount_cents);
  return Math.max(0, Math.round((data.amount ?? 0) * 100));
}

export async function POST(request: NextRequest) {
  try {
    // ─── Authentication ────────────────────────────────────────
    const rawBody = await request.text();
    const webhookSecret = process.env.WEBHOOK_SECRET;
    const signature =
      request.headers.get('x-webhook-signature') ||
      request.headers.get('x-refferq-signature');

    let actorId: string | null = null;
    let namespace = 'WEBHOOK_SIGNATURE';

    const keyAuth = await verifyApiKey(request);

    let authenticated = false;
    if (keyAuth) {
      actorId = keyAuth.actorId;
      namespace = `API_KEY:${keyAuth.keyId}`;
      authenticated = true;
    }

    if (!authenticated && webhookSecret && signature) {
      authenticated = verifyWebhookSignature(rawBody, signature, webhookSecret);
      if (authenticated) {
        namespace = `SIGNATURE:${(signature || 'webhook').slice(0, 32)}`;
      }
    }

    if (!authenticated) {
      return NextResponse.json(
        { success: false, message: 'Unauthorized' },
        { status: 401 }
      );
    }

    // ─── Parse & Validate ──────────────────────────────────────
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch (_error) {
      return NextResponse.json(
        { success: false, message: 'Invalid JSON payload' },
        { status: 400 }
      );
    }

    const validation = webhookRefundSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        {
          success: false,
          message: 'Invalid payload',
          details: validation.error.flatten(),
        },
        { status: 400 }
      );
    }

    const {
      customer_email,
      referral_code,
      amount_cents,
      reason = 'Customer refund',
      external_id,
      eventId,
      refund_id,
    } = validation.data;

    const idempotencyKey = extractIdempotencyKey(request, {
      eventId,
      external_id,
      refund_id,
    });

    if (!idempotencyKey) {
      return NextResponse.json(
        { success: false, message: 'eventId, external_id or refund_id is required when no idempotency header is set' },
        { status: 400 }
      );
    }

    const idempotencyMarker = `${namespace}|${idempotencyKey}`;

    // Return cached outcome for repeat webhook delivery when available.
    const existing = await prisma.conversion.findFirst({
      where: {
        eventMetadata: {
          path: ['refundEventKey'],
          equals: idempotencyMarker,
        },
      },
      include: {
        affiliate: {
          include: {
            user: { select: { email: true, name: true } },
          },
        },
      },
    });

    if (existing) {
      const metadata = getMetadataObject(existing.eventMetadata);
      const cachedResult = metadata.refundResult;

      return NextResponse.json({
        success: true,
        duplicate: true,
        message: 'Refund already processed',
        attributed: existing.affiliate.user.email ? true : false,
        reversed: cachedResult,
      });
    }

    // ─── Find Related Conversions ──────────────────────────────
    // Strategy: find conversions by customer email in event_metadata
    const conversions = await prisma.conversion.findMany({
      where: {
        eventMetadata: {
          path: ['customerEmail'],
          equals: customer_email,
        },
      },
      include: {
        commissions: true,
        affiliate: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (referral_code) {
      const hasReferral = conversions.some((item) => item.affiliate?.referralCode === referral_code);
      if (!hasReferral) {
        // No-op path keeps behavior deterministic for this specific provider attribution hint.
        // Refund handling will still proceed by email lookup above.
      }
    }

    const processResult = await prisma.$transaction(async (tx) => {
      let reversedCount = 0;
      let totalReversedCents = 0;
      const updates: RefundUpdate[] = [];

      if (conversions.length === 0) {
        return {
          reversedCount,
          totalReversedCents,
          updates,
        };
      }

      for (const conversion of conversions) {
        for (const commission of conversion.commissions) {
          if (commission.status === 'CANCELLED' || commission.status === 'CLAWBACK') {
            updates.push({
              commissionId: commission.id,
              action: 'already_cancelled',
              amountCents: 0,
            });
            continue;
          }

          if (commission.status === 'PENDING') {
            await tx.commission.update({
              where: { id: commission.id },
              data: {
                status: 'CANCELLED',
                clawbackNote: `Refund: ${reason}. External ID: ${external_id || eventId || refund_id || 'N/A'}`,
              },
            });

            updates.push({
              commissionId: commission.id,
              action: 'cancelled_pending',
              amountCents: commission.amountCents,
            });
          } else if (commission.status === 'APPROVED') {
            await tx.commission.update({
              where: { id: commission.id },
              data: {
                status: 'CANCELLED',
                clawbackNote: `Refund clawback: ${reason}. External ID: ${external_id || eventId || refund_id || 'N/A'}`,
              },
            });

            await tx.affiliate.update({
              where: { id: commission.affiliateId },
              data: {
                balanceCents: {
                  decrement: commission.amountCents,
                },
              },
            });

            updates.push({
              commissionId: commission.id,
              action: 'clawback_approved',
              amountCents: commission.amountCents,
            });
          } else if (commission.status === 'PAID') {
            await tx.commission.update({
              where: { id: commission.id },
              data: {
                status: 'CLAWBACK',
                clawbackNote: `Paid commission clawback: ${reason}. Will be deducted from next payout. External ID: ${external_id || eventId || refund_id || 'N/A'}`,
              },
            });

            await tx.affiliate.update({
              where: { id: commission.affiliateId },
              data: {
                balanceCents: {
                  decrement: commission.amountCents,
                },
              },
            });

            updates.push({
              commissionId: commission.id,
              action: 'clawback_paid',
              amountCents: commission.amountCents,
            });
          }

          reversedCount++;
          totalReversedCents += commission.amountCents;
        }

        await tx.conversion.update({
          where: { id: conversion.id },
          data: {
            status: 'REJECTED',
            eventMetadata: {
              ...getMetadataObject(conversion.eventMetadata),
              refundEventKey: idempotencyMarker,
              refundSource: namespace,
              refundResult: {
                reversedCount,
                totalReversedCents,
                reason,
                eventId,
                external_id,
                processedAt: new Date().toISOString(),
              },
            },
          },
        });
      }

      return {
        reversedCount,
        totalReversedCents,
        updates,
      };
    });

    const payoutSummary = {
      reversedCount: processResult.reversedCount,
      totalReversedCents: processResult.totalReversedCents,
      details: processResult.updates,
    };

    if (actorId) {
      await logAuditAction({
        actorId,
        action: 'REFUND_PROCESSED',
        objectType: 'REFUND',
        objectId: idempotencyMarker,
        payload: {
          customer_email,
          referral_code,
          amount_cents: amount_cents ?? 0,
          reason,
          reversedCount: processResult.reversedCount,
          totalReversedCents: processResult.totalReversedCents,
          refundKey: idempotencyMarker,
          results: processResult.updates,
        },
      });
    }

    // ─── Send email notification to affected affiliates ────────
    if (conversions.length > 0) {
      try {
        const affectedAffiliateIds = [...new Set(conversions.map((c) => c.affiliateId))];
        for (const affId of affectedAffiliateIds) {
          const affiliateUser = await prisma.user.findFirst({
            where: { affiliate: { id: affId } },
          });

          if (affiliateUser?.email) {
            const { emailService } = await import('@/lib/email');
            await emailService.sendGenericEmail(affiliateUser.email, {
              subject: 'Commission Reversed — Customer Refund',
              body: `A commission has been reversed due to a customer refund. Reason: ${reason}. This has been reflected in your balance.`,
            });
          }
        }
      } catch (emailErr) {
        console.error('Failed to send refund notification emails:', emailErr);
      }
    }

    return NextResponse.json({
      success: true,
      message: `Refund processed: ${payoutSummary.reversedCount} commission(s) reversed`,
      attributed: true,
      idempotency: {
        key: idempotencyKey,
        namespace,
      },
      reversed: payoutSummary.reversedCount,
      totalReversedCents: payoutSummary.totalReversedCents,
      details: payoutSummary.details,
      refundAmountCents: parseAmountCents({ amount_cents, amount: validation.data.amount }),
    });
  } catch (error) {
    console.error('Refund webhook error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to process refund' },
      { status: 500 }
    );
  }
}
