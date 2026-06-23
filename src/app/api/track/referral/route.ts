import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { trackReferralSchema } from '@/lib/validations';

/**
 * POST /api/track/referral - Track referral clicks
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
    const validation = trackReferralSchema.safeParse(body);

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
      url,
      referrer,
      userAgent,
      timestamp,
      metadata,
    } = validation.data;

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

    // Log the referral click
    console.log('✅ Referral click tracked:', {
      affiliateId: affiliate.id,
      referralCode,
      url,
      referrer,
      timestamp,
      metadata,
    });

    // You can optionally create a ReferralClick record or update stats
    // For now, we'll just log it and return success

    return NextResponse.json({
      success: true,
      message: 'Referral tracked successfully',
      affiliate: {
        name: affiliate.user.name,
        code: affiliate.referralCode,
      },
    });
  } catch (error) {
    console.error('POST /api/track/referral error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to track referral' },
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
