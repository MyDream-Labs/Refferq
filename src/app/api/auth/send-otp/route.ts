import { NextRequest, NextResponse } from 'next/server';
import { otpService } from '@/lib/otp';
import { checkRateLimit } from '@/lib/rate-limit';
import { extractRequestIp, isLegacyAuthPayload, normalizeEmail } from '@/lib/auth-flow';

export async function POST(request: NextRequest) {
  try {
    // Rate limit: 3 OTP sends per minute per IP
    const ip = extractRequestIp(request);
    const rateLimit = await checkRateLimit(ip, 'auth/send-otp', 3, 60 * 1000);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many OTP requests. Please try again later.' },
        { status: 429, headers: { 'Retry-After': Math.ceil((rateLimit.resetAt.getTime() - Date.now()) / 1000).toString() } }
      );
    }

    const body = await request.json() as Record<string, unknown>;

    if (isLegacyAuthPayload(body) || typeof body.code === 'string') {
      return NextResponse.json(
        { error: 'Legacy payload rejected' },
        { status: 410 }
      );
    }

    const email = normalizeEmail(body.email);

    if (!email) {
      return NextResponse.json(
        { error: 'Email is required' },
        { status: 400 }
      );
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { error: 'Invalid email format' },
        { status: 400 }
      );
    }

    const result = await otpService.sendOTP(email, { allowPending: true });

    if (!result.success) {
      return NextResponse.json(
        { success: false, message: result.message },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      message: result.message
    });

  } catch (error) {
    console.error('OTP send error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
