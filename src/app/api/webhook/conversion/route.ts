import { NextRequest, NextResponse } from 'next/server';
import { ConversionType, Prisma } from '@prisma/client';
import { prisma, db } from '@/lib/prisma';
import crypto from 'crypto';
import { type WebhookConversionPayload, webhookConversionSchema } from '@/lib/validations';
import { z } from 'zod';
import { getProgramSettings } from '@/lib/program-settings';

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
  integrationId: string;
  actorId: string;
};

type WebhookDuplicateConversion = Prisma.ConversionGetPayload<{
  include: {
      affiliate: {
        select: {
          id: true;
          referralCode: true;
          user: {
            select: {
              name: true;
            };
          };
        };
      };
      commissions: true;
    };
  }>;

function asJsonObject(value: unknown): Prisma.InputJsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Prisma.InputJsonObject;
  }
  return {};
}

async function verifyApiKey(request: NextRequest): Promise<ApiKeyAuth | null> {
  const apiKeyHeader = request.headers.get('x-api-key');
  if (!apiKeyHeader) return null;

  const keyHash = crypto.createHash('sha256').update(apiKeyHeader).digest('hex');
  const key = await prisma.apiKey.findFirst({ where: { keyHash, isActive: true } });
  if (!key) return null;

  return {
    integrationId: key.id,
    actorId: key.userId,
  };
}

function extractIdempotencyKey(request: NextRequest, body: { eventId?: string; order_id?: string }) {
  const headerValue = request.headers.get('X-Idempotency-Key') || request.headers.get('x-idempotency-key');
  return headerValue?.trim() || body.eventId?.trim() || body.order_id?.trim() || null;
}

async function findDuplicateConversion(
  integrationId: string,
  eventType: ConversionType,
  idempotencyKey: string
): Promise<WebhookDuplicateConversion | null> {
  return prisma.conversion.findFirst({
    where: {
      eventType,
      AND: [
        { eventMetadata: { path: ['integrationId'], equals: integrationId } },
        { eventMetadata: { path: ['idempotencyKey'], equals: idempotencyKey } },
        { eventMetadata: { path: ['source'], equals: 'WEBHOOK_CONVERSION' } },
      ],
    },
    include: {
      affiliate: {
        select: {
          id: true,
          referralCode: true,
          user: {
            select: { name: true },
          },
        },
      },
      commissions: true,
    },
  });
}

function toNumberCents(data: z.infer<typeof webhookConversionSchema>) {
  if (data.amount_cents !== undefined) return Math.trunc(data.amount_cents);
  return Math.max(0, Math.round((data.amount ?? 0) * 100));
}

function normalizeEventMetadata(metadata: WebhookConversionPayload['event_metadata']) {
  return asJsonObject(metadata);
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const webhookSecret = process.env.WEBHOOK_SECRET;
    const signature = request.headers.get('x-webhook-signature') || request.headers.get('x-refferq-signature');

    let authenticated = false;
    let actorId: string | null = null;
    let integrationId = 'WEBHOOK_SIGNATURE';

    const apiKeyAuth = await verifyApiKey(request);
    if (apiKeyAuth) {
      authenticated = true;
      actorId = apiKeyAuth.actorId;
      integrationId = apiKeyAuth.integrationId;
    }

    if (!authenticated && webhookSecret && signature) {
      authenticated = verifyWebhookSignature(rawBody, signature, webhookSecret);
      if (authenticated && !actorId) {
        integrationId = 'WEBHOOK_SIGNATURE';
      }
    }

    if (!authenticated) {
      return NextResponse.json(
        { success: false, message: 'Unauthorized: Valid API key or webhook signature required' },
        { status: 401 }
      );
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch (_error) {
      return NextResponse.json(
        { success: false, message: 'Invalid JSON payload' },
        { status: 400 }
      );
    }

    const validation = webhookConversionSchema.safeParse(parsedBody);
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

    const data = validation.data;
    const idempotencyKey = extractIdempotencyKey(request, data);
    const amountCents = toNumberCents(data);
    const customerEmail = data.customer_email;
    const referralCode = data.referral_code;
    const attributionKey = data.attribution_key;
    const eventType = data.event_type;
    const amount = amountCents;
    const currency = data.currency;

    if (!idempotencyKey) {
      return NextResponse.json(
        { success: false, message: 'eventId or order_id is required when X-Idempotency-Key is not provided' },
        { status: 400 }
      );
    }

    const duplicate = await findDuplicateConversion(integrationId, eventType, idempotencyKey);

    if (duplicate) {
      const existingCommission = duplicate.commissions.at(0);
      return NextResponse.json({
        success: true,
        duplicate: true,
        message: 'Webhook conversion already processed',
        attributed: true,
        conversion: {
          id: duplicate.id,
          amount: duplicate.amountCents / 100,
          currency: duplicate.currency,
          status: duplicate.status,
          createdAt: duplicate.createdAt,
        },
        commission: existingCommission
          ? {
              id: existingCommission.id,
              amount: existingCommission.amountCents / 100,
              status: existingCommission.status,
            }
          : null,
        affiliate: {
          id: duplicate.affiliate.id,
          code: duplicate.affiliate.referralCode,
          name: duplicate.affiliate.user.name,
        },
      });
    }

    let affiliate = null;
    let attributionMethod = 'none';

    // Attribution by attribution key is not implemented yet and can be enhanced later.
    if (attributionKey) {
      attributionMethod = 'attribution_key';
    }

    if (!affiliate && referralCode) {
      affiliate = await db.getAffiliateByReferralCode(referralCode);
      attributionMethod = 'referral_code';
    }

    if (!affiliate) {
      return NextResponse.json({
        success: true,
        message: 'Conversion logged (no attribution)',
        attributed: false,
      });
    }

    const settings = await getProgramSettings();
    const holdDays = settings.commissionHoldDays;

    const commissionRules = await prisma.commissionRule.findMany();
    const applicableRule = commissionRules.find((rule) => rule.isDefault) ?? commissionRules.find((rule) => rule.type === 'PERCENTAGE');

    const rate = applicableRule?.value ?? 15;
    const commissionRate = applicableRule?.type === 'FIXED' ? rate : rate;

    const commissionAmount =
      applicableRule?.type === 'FIXED'
        ? Math.trunc(commissionRate)
        : Math.floor((amount * commissionRate) / 100);

    const maturesAt = new Date();
    maturesAt.setDate(maturesAt.getDate() + holdDays);

    const result = await prisma.$transaction(async (tx) => {
      const conversion = await tx.conversion.create({
        data: {
          affiliateId: affiliate.id,
          eventType,
          amountCents: amount,
          currency,
          status: 'PENDING',
          eventMetadata: {
            ...normalizeEventMetadata(data.event_metadata),
            customerEmail,
            attributionMethod,
            attributionKey,
            referralCode,
            idempotencyKey,
            integrationId,
            source: 'WEBHOOK_CONVERSION',
            eventId: data.eventId,
            orderId: data.order_id,
          },
        },
      });

      const commission = await tx.commission.create({
        data: {
          conversionId: conversion.id,
          affiliateId: affiliate.id,
          userId: affiliate.userId,
          amountCents: commissionAmount,
          rate: commissionRate,
          status: 'PENDING',
          maturesAt,
        },
      });

      if (actorId) {
        try {
          await tx.auditLog.create({
            data: {
              actorId,
              action: 'conversion_tracked',
              objectType: 'conversion',
              objectId: conversion.id,
              payload: {
                source: 'webhook',
                event_type: eventType,
                amount_cents: amount,
                commission_amount: commissionAmount,
                affiliate_id: affiliate.id,
                attributionMethod,
                idempotencyKey,
              },
            },
          });
        } catch (_error) {
          // Audit failures must not impact main processing path.
        }
      }

      return { conversion, commission };
    });

    return NextResponse.json({
      success: true,
      message: 'Conversion tracked successfully',
      attributed: true,
      idempotency: {
        key: idempotencyKey,
        integrationId,
      },
      conversion: {
        id: result.conversion.id,
        amount: result.conversion.amountCents / 100,
        currency: result.conversion.currency,
        status: result.conversion.status,
      },
      commission: {
        id: result.commission.id,
        amount: result.commission.amountCents / 100,
        status: result.commission.status,
      },
      attributionMethod,
    });
  } catch (error) {
    console.error('Conversion webhook error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to process conversion' },
      { status: 500 }
    );
  }
}
