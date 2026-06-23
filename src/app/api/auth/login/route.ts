import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { checkRateLimit } from '@/lib/rate-limit';
import { otpService } from '@/lib/otp';
import { extractRequestIp, isLegacyAuthPayload, normalizeEmail } from '@/lib/auth-flow';

export async function POST(request: NextRequest) {
  try {
    // Rate limit: 5 login attempts per minute per IP
    const ip = extractRequestIp(request);
    const rateLimit = await checkRateLimit(ip, 'auth/login', 5, 60 * 1000);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { success: false, message: 'Too many login attempts. Please try again later.' },
        {
          status: 429,
          headers: {
            'Retry-After': Math.ceil((rateLimit.resetAt.getTime() - Date.now()) / 1000).toString(),
            'X-RateLimit-Limit': rateLimit.limit.toString(),
            'X-RateLimit-Remaining': '0',
          }
        }
      );
    }

    const body = (await request.json()) as Record<string, unknown>;

    if (isLegacyAuthPayload(body)) {
      return NextResponse.json(
        { success: false, message: 'This endpoint no longer accepts password payloads. Use OTP flow.' },
        { status: 410 }
      );
    }

    const email = normalizeEmail(body.email);

    if (!email) {
      return NextResponse.json(
        { success: false, message: 'Email is required' },
        { status: 400 }
      );
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { success: false, message: 'Invalid email format' },
        { status: 400 }
      );
    }

    // Find user by email
    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      return NextResponse.json(
        {
          success: true,
          next: 'register',
          message: 'Please continue registration with your email.'
        },
        {
          status: 202,
        }
      );
    }

    // Check user status - use generic message to prevent account status enumeration
    if (user.status === 'INACTIVE' || user.status === 'SUSPENDED') {
      return NextResponse.json(
        { success: false, message: 'Your account is not active. Please contact support.' },
        { status: 403 }
      );
    }

    // Existing users get OTP login.
    const otpResult = await otpService.sendOTP(email, { allowPending: true });
    if (!otpResult.success) {
      return NextResponse.json(
        { success: false, message: otpResult.message },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        next: 'otp',
        email,
        message: otpResult.message,
      },
      {
        status: 202,
      }
    );
  } catch (error) {
    console.error('Login API error:', error);
    return NextResponse.json(
      { success: false, message: 'Login failed' },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    return NextResponse.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    console.error('Logout API error:', error);
    return NextResponse.json(
      { success: false, message: 'Logout failed' },
      { status: 500 }
    );
  }
}
