import { NextRequest, NextResponse } from 'next/server';
import { ConversionType, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { REFERRAL_STATES, buildReferralStateMetadata, getReferralFlowState, resolveReferralStateTransition } from '@/lib/referral-flow';
import { type TrackConversionPayload, trackConversionSchema } from '@/lib/validations';

type ConversionTrackingResult = {
  id: string;
  amountCents: number;
  currency: string;
  status: string;
  createdAt: Date;
  affiliate: {
    referralCode: string;
    user: {
      name: string;
    };
  };
};

type TrackDuplicateConversion = Prisma.ConversionGetPayload<{
  include: {
    affiliate: {
      select: {
        referralCode: true;
        user: {
          select: {
            name: true;
          };
        };
      };
    };
  };
}>;

function asJsonObject(value: unknown): Prisma.InputJsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Prisma.InputJsonObject;
  }
  return {};
}

function parseAmountToCents(amount?: number, amountCents?: number): number {
  if (amountCents !== undefined) {
    return Math.max(0, Math.trunc(amountCents));
  }

  if (amount === undefined) {
    return 0;
  }

  return Math.max(0, Math.round(amount * 100));
}

function extractIdempotencyKey(
  req: NextRequest,
  body: { orderId?: string; eventId?: string }
): string | null {
  const headerValue = req.headers.get('X-Idempotency-Key') || req.headers.get('x-idempotency-key');
  if (headerValue?.trim()) return headerValue.trim();
  if (body.eventId?.trim()) return body.eventId.trim();
  return body.orderId?.trim() || null;
}

function toTrackResult(conversion: ConversionTrackingResult) {
  return {
    id: conversion.id,
    amount: conversion.amountCents / 100,
    currency: conversion.currency,
    status: conversion.status,
    createdAt: conversion.createdAt.toISOString(),
  };
}

async function findDuplicateConversion(
  integrationId: string,
  idempotencyKey: string,
  eventType: ConversionType
): Promise<TrackDuplicateConversion | null> {
  return prisma.conversion.findFirst({
    where: {
      eventType,
      AND: [
        {
          eventMetadata: {
            path: ['idempotencyKey'],
            equals: idempotencyKey,
          },
        },
        {
          eventMetadata: {
            path: ['integrationId'],
            equals: integrationId,
          },
        },
        {
          eventMetadata: {
            path: ['source'],
            equals: 'TRACK_CONVERSION',
          },
        },
      ],
    },
    include: {
      affiliate: {
        select: {
          referralCode: true,
          user: {
            select: {
              name: true,
            },
          },
        },
      },
    },
  });
}

function normalizeMetadata(metadata: TrackConversionPayload['metadata']): Prisma.InputJsonObject {
  return asJsonObject(metadata);
}

function buildConversionMetadata(
  metadata: TrackConversionPayload['metadata'],
  idempotencyKey: string,
  integrationId: string,
  eventType: string,
  eventId?: string,
  orderId?: string,
  url?: string,
  timestamp?: string,
) {
  const baseMetadata = {
    ...normalizeMetadata(metadata),
    orderId: orderId || null,
    idempotencyKey,
    integrationId,
    source: 'TRACK_CONVERSION',
    eventId,
    url: url || null,
    timestamp: timestamp || new Date().toISOString(),
  };

  return {
    ...baseMetadata,
    _trackFlowState: REFERRAL_STATES.CONVERSION,
    _trackFlowUpdatedAt: new Date().toISOString(),
  };
}

/**
 * POST /api/track/conversion - Track conversions/sales
 */
export async function POST(req: NextRequest) {
  try {
    const apiKey = req.headers.get('X-API-Key') || req.headers.get('x-api-key');
    
    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: 'API key is required' },
        { status: 401 }
      );
    }

    // Verify API key
    const integration = await prisma.integrationSettings.findFirst({
      where: {
        publicKey: apiKey,
        isActive: true,
      },
    });

    if (!integration) {
      return NextResponse.json(
        { success: false, error: 'Invalid or inactive API key' },
        { status: 401 }
      );
    }

    const body = await req.json();
    const validation = trackConversionSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid payload',
          details: validation.error.flatten(),
        },
        { status: 400 }
      );
    }

    const {
      referralCode,
      customerEmail,
      customerName,
      amount,
      amountCents,
      currency,
      eventType,
      orderId,
      eventId,
      metadata,
      url,
      timestamp,
    } = validation.data;

    const idempotencyKey = extractIdempotencyKey(req, { orderId, eventId });

    if (!idempotencyKey) {
      return NextResponse.json(
        { success: false, error: 'eventId or X-Idempotency-Key required when orderId is absent' },
        { status: 400 }
      );
    }

    const duplicateConversion = await findDuplicateConversion(integration.id, idempotencyKey, eventType);

    if (duplicateConversion) {
      return NextResponse.json({
        success: true,
        duplicate: true,
        message: 'Conversion already processed',
        conversion: toTrackResult(duplicateConversion),
        affiliate: {
          name: duplicateConversion.affiliate.user.name,
          code: duplicateConversion.affiliate.referralCode,
        },
      });
    }

    // Find affiliate by referral code
    const affiliate = await prisma.affiliate.findUnique({
      where: { referralCode },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            status: true,
          },
        },
      },
    });

    if (!affiliate) {
      return NextResponse.json(
        { success: false, error: 'Invalid referral code' },
        { status: 404 }
      );
    }

    if (affiliate.user.status !== 'ACTIVE') {
      return NextResponse.json(
        { success: false, error: 'Affiliate is not active' },
        { status: 403 }
      );
    }

    // Check if referral with this email already exists
    let referral;
    if (customerEmail) {
      referral = await prisma.referral.findFirst({
        where: {
          leadEmail: customerEmail,
          affiliateId: affiliate.id,
        },
      });
    }

    // Create referral if doesn't exist
    if (!referral && customerEmail) {
      const normalizedMetadata = normalizeMetadata(metadata);
      referral = await prisma.referral.create({
        data: {
          leadEmail: customerEmail,
          leadName: customerName || 'Unknown Customer',
          affiliateId: affiliate.id,
          status: 'APPROVED',
          metadata: buildReferralStateMetadata(
            normalizedMetadata,
            REFERRAL_STATES.CONVERSION,
            'track-conversion-create',
          ),
        },
      });
    } else if (referral && referral.status === 'PENDING') {
      const referralNextState = resolveReferralStateTransition(
        getReferralFlowState(referral.metadata),
        REFERRAL_STATES.CONVERSION,
      );

      // Update referral status to APPROVED
      referral = await prisma.referral.update({
        where: { id: referral.id },
        data: {
          status: 'APPROVED',
          metadata: buildReferralStateMetadata(
            {
              ...asJsonObject(referral.metadata),
              ...normalizeMetadata(metadata),
            },
            referralNextState,
            'track-conversion-update',
          ),
        },
      });
    } else if (referral) {
      referral = await prisma.referral.update({
        where: { id: referral.id },
        data: {
          metadata: buildReferralStateMetadata(
            {
              ...asJsonObject(referral.metadata),
              ...normalizeMetadata(metadata),
            },
            resolveReferralStateTransition(
              getReferralFlowState(referral.metadata),
              REFERRAL_STATES.CONVERSION,
            ),
            'track-conversion-existing',
          ),
        },
      });
    }

    // Create conversion record
    const resolvedAmountCents = parseAmountToCents(amount, amountCents);

    const conversion = await prisma.conversion.create({
      data: {
        affiliateId: affiliate.id,
        referralId: referral?.id || null,
        eventType,
        amountCents: resolvedAmountCents,
        currency,
        status: 'PENDING',
        eventMetadata: {
          ...buildConversionMetadata(
            metadata,
            idempotencyKey,
            integration.id,
            eventType,
            eventId,
            orderId,
            url,
            timestamp,
          ),
        },
      },
    });

    // Note: Commission calculation will be done by the commission rules system
    // This just creates the conversion record

    console.log('✅ Conversion tracked successfully:', {
      conversionId: conversion.id,
      affiliateId: affiliate.id,
      referralId: referral?.id,
      amount: conversion.amountCents / 100,
    });

    return NextResponse.json({
      success: true,
      message: 'Conversion tracked successfully',
      conversion: {
        id: conversion.id,
        amount: conversion.amountCents / 100,
        currency: conversion.currency,
      },
      affiliate: {
        name: affiliate.user.name,
        code: affiliate.referralCode,
      },
      idempotency: {
        key: idempotencyKey,
      },
    });
  } catch (error) {
    console.error('POST /api/track/conversion error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to track conversion' },
      { status: 500 }
    );
  }
}

// Handle OPTIONS for CORS
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    },
  });
}
