import { NextRequest, NextResponse } from 'next/server';
import { otpService } from '@/lib/otp';
import { SignJWT } from 'jose';
import { checkRateLimit } from '@/lib/rate-limit';
import { getJwtExpiration, getJwtCookieMaxAgeSeconds, getJwtSecret } from '@/lib/auth-config';
import { extractRequestIp, normalizeEmail } from '@/lib/auth-flow';

const JWT_SECRET = getJwtSecret();
const JWT_EXPIRATION = getJwtExpiration();
const JWT_COOKIE_AGE = getJwtCookieMaxAgeSeconds();

export async function POST(request: NextRequest) {
  try {
    // Rate limit: 5 verify attempts per minute per IP
    const ip = extractRequestIp(request);
    const rateLimit = await checkRateLimit(ip, 'auth/verify-otp', 5, 60 * 1000);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many verification attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': Math.ceil((rateLimit.resetAt.getTime() - Date.now()) / 1000).toString() } }
      );
    }

    const body = (await request.json()) as Record<string, unknown>;
    const email = normalizeEmail(body.email);
    const code = typeof body.code === 'string' ? body.code.trim() : '';

    if (!email || !code) {
      return NextResponse.json(
        { error: 'Email and code are required' },
        { status: 400 }
      );
    }

    const result = await otpService.verifyOTP(email, code);

    if (!result.success) {
      return NextResponse.json(
        { error: result.message },
        { status: 400 }
      );
    }

    const user = result.user!;

    if (user.status === 'INACTIVE' || user.status === 'SUSPENDED') {
      return NextResponse.json(
        { error: 'Your account is not active. Please contact support.' },
        { status: 403 }
      );
    }

    if (user.status === 'PENDING' && user.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Account is pending approval. Please contact support if activation is needed.' },
        { status: 403 }
      );
    }

    // Generate JWT token
    const token = await new SignJWT({
      userId: user.id,
      email: user.email,
      role: user.role,
      name: user.name
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(JWT_EXPIRATION)
      .sign(JWT_SECRET);

    // Set cookie
    const response = NextResponse.json({
      success: true,
      message: result.message,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        hasAffiliate: !!user.affiliate
      }
    });

    response.cookies.set('auth-token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: JWT_COOKIE_AGE,
      path: '/'
    });

    return response;

  } catch (error) {
    console.error('OTP verify error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
