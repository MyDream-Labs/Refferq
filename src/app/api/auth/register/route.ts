import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { checkRateLimit } from '@/lib/rate-limit';
import { otpService } from '@/lib/otp';
import { extractRequestIp, isLegacyAuthPayload, normalizeEmail } from '@/lib/auth-flow';
import crypto from 'crypto';

type RegisterBody = {
  email?: unknown;
  name?: unknown;
  role?: unknown;
};

function normalizeRole(inputRole?: unknown): 'ADMIN' | 'AFFILIATE' {
  const role = typeof inputRole === 'string' ? inputRole.trim().toUpperCase() : 'AFFILIATE';
  return role === 'ADMIN' ? 'AFFILIATE' : 'AFFILIATE';
}

function buildPasswordPlaceholder(email: string): string {
  return crypto.createHash('sha256').update(`otp-only:${email}`).digest('hex');
}

function generateReferralCode(name: string): string {
  const cleanName = name.replace(/[^a-zA-Z]/g, '').toUpperCase();
  const random = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
  return `${cleanName.substr(0, 6)}-${random}`;
}

export async function POST(request: NextRequest) {
  try {
    // Rate limit: 30 registration attempts per minute per IP
    const ip = extractRequestIp(request);
    const rateLimit = await checkRateLimit(ip, 'auth/register', 30, 60 * 1000);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { success: false, message: 'Too many registration attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': Math.ceil((rateLimit.resetAt.getTime() - Date.now()) / 1000).toString() } }
      );
    }

    const body = (await request.json()) as RegisterBody;

    if (isLegacyAuthPayload(body)) {
      return NextResponse.json(
        { success: false, message: 'This endpoint no longer accepts password payloads. Use OTP flow.' },
        { status: 410 }
      );
    }

    const email = normalizeEmail(body.email);
    const name = typeof body.name === 'string' ? body.name.trim() : '';

    // Validate required fields
    if (!email) {
      return NextResponse.json(
        { success: false, message: 'Email and name are required' },
        { status: 400 }
      );
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { success: false, message: 'Invalid email format' },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { affiliate: true }
    });

    // Existing user handling
    if (user) {
      if (user.status === 'INACTIVE' || user.status === 'SUSPENDED') {
        return NextResponse.json(
          { success: false, message: 'Your account is not active. Please contact support.' },
          { status: 403 }
        );
      }

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
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            status: user.status,
          },
          email,
          message: otpResult.message,
        },
        { status: 202 }
      );
    }

    if (!name) {
      return NextResponse.json(
        { success: false, message: 'Name is required for new registrations' },
        { status: 400 }
      );
    }

    // New user path
    const userRole = normalizeRole(body.role);
    const placeholderPassword = buildPasswordPlaceholder(email);

    const createdUser = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          name,
          password: placeholderPassword,
          role: userRole,
          status: 'PENDING',
        },
      });

      if (userRole === 'AFFILIATE') {
        await tx.affiliate.create({
          data: {
            userId: created.id,
            referralCode: generateReferralCode(name),
            payoutDetails: {},
            balanceCents: 0,
          },
        });
      }

      return created;
    });

    const otpResult = await otpService.sendOTP(email, { allowPending: true });
    if (!otpResult.success) {
      return NextResponse.json(
        {
          success: false,
          message: 'Account created, but OTP could not be sent. Please request a new OTP.',
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        next: 'otp',
        user: {
          id: createdUser.id,
          email: createdUser.email,
          name: createdUser.name,
          role: createdUser.role,
          status: createdUser.status,
        },
        email,
        message: otpResult.message,
      },
      { status: 202 }
    );
  } catch (error) {
    console.error('Register API error:', error);
    return NextResponse.json(
      { success: false, message: 'Registration failed' },
      { status: 500 }
    );
  }
}
