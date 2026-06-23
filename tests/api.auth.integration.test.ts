import { SignJWT } from 'jose';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { InMemoryPrisma, resetPrismaMock } from './utils/test-prisma-fixture';
import { checkRateLimit } from './mocks/rate-limit.mock';
import { otpService } from './mocks/otp.mock';
import { prisma } from './mocks/prisma.mock';

type VerifyOTPResult = {
  success: boolean;
  message: string;
  user?: {
    id: string;
    email: string;
    name: string;
    role: 'ADMIN' | 'AFFILIATE';
    status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'PENDING';
    affiliate?: { id: string } | null;
  };
};

vi.mock('@/lib/prisma', () => import('./mocks/prisma.mock'));
vi.mock('@/lib/rate-limit', () => import('./mocks/rate-limit.mock'));
vi.mock('@/lib/otp', () => import('./mocks/otp.mock'));
vi.mock('@/lib/email', () => import('./mocks/email.mock'));

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as registerPOST } from '@/app/api/auth/register/route';
import { POST as sendOtpPOST } from '@/app/api/auth/send-otp/route';
import { POST as verifyOtpPOST } from '@/app/api/auth/verify-otp/route';
import { GET as meGET } from '@/app/api/auth/me/route';
import { middleware } from '@/middleware';

type RequestTestInit = Omit<RequestInit, 'signal'> & { signal?: AbortSignal };

const request = (path: string, init: RequestTestInit = {}) => {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string>),
    },
    ...init,
  });
};

const jwtSecret = new TextEncoder().encode(process.env.JWT_SECRET!);

async function makeAuthToken(overrides: Record<string, string>) {
  return new SignJWT({
    userId: 'user-1',
    email: 'user@example.com',
    name: 'User',
    role: 'AFFILIATE',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(jwtSecret);
}

async function buildExpiredToken() {
  return new SignJWT({
    userId: 'user-1',
    email: 'expired@example.com',
    role: 'AFFILIATE',
    name: 'Expired User',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() - 60 * 60 * 1000) / 1000))
    .sign(jwtSecret);
}

function authRequest(path: string, token?: string) {
  return request(path, token ? { headers: { Cookie: `auth-token=${token}` } } : {});
}

describe('API: auth flow', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
    checkRateLimit.mockResolvedValue({
      allowed: true,
      limit: 5,
      remaining: 4,
      resetAt: new Date(Date.now() + 60_000),
    });
    otpService.sendOTP.mockResolvedValue({ success: true, message: 'OTP sent successfully' });
    otpService.verifyOTP.mockResolvedValue({ success: false, message: 'Invalid or expired OTP' });

    prisma.$transaction.mockImplementation(async (callback: (tx: InMemoryPrisma) => Promise<unknown>) =>
      callback(prisma),
    );
  });

  it('POST /api/auth/login: unknown email -> next register', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);

    const response = await loginPOST(request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'unknown@example.test' }),
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ success: true, next: 'register' });
  });

  it('POST /api/auth/login: legacy payload -> 410', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);

    const response = await loginPOST(request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'user@example.test', password: '123456' }),
    }));

    expect(response.status).toBe(410);
  });

  it('POST /api/auth/login: invalid email -> 400', async () => {
    const response = await loginPOST(request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'not-an-email' }),
    }));

    expect(response.status).toBe(400);
  });

  it('POST /api/auth/login: rate limit -> 429', async () => {
    checkRateLimit.mockResolvedValueOnce({
      allowed: false,
      limit: 5,
      remaining: 0,
      resetAt: new Date(),
    });

    const response = await loginPOST(request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'user@example.test' }),
    }));

    expect(response.status).toBe(429);
  });

  it('POST /api/auth/register: новый user creates pending + otp', async () => {
    const email = 'new@example.test';
    const name = 'New Partner';

    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.user.create.mockResolvedValueOnce({
      id: 'u-new',
      email,
      name,
      role: 'AFFILIATE',
      status: 'PENDING',
    });
    prisma.affiliate.create.mockResolvedValueOnce({
      id: 'a-new',
      userId: 'u-new',
      referralCode: 'NEW-1234',
      balanceCents: 0,
    });
    otpService.sendOTP.mockResolvedValueOnce({ success: true, message: 'OTP sent successfully' });

    const response = await registerPOST(request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, name }),
    }));
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toMatchObject({ success: true, next: 'otp', email });
    expect(body.user.status).toBe('PENDING');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('POST /api/auth/register: existing active user -> otp', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-active',
      email: 'active@example.test',
      name: 'Active User',
      role: 'AFFILIATE',
      status: 'ACTIVE',
    });
    otpService.sendOTP.mockResolvedValueOnce({ success: true, message: 'OTP sent successfully' });

    const response = await registerPOST(request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: 'active@example.test', name: 'Name should be ignored' }),
    }));
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toMatchObject({ success: true, next: 'otp', user: { status: 'ACTIVE' } });
  });

  it('POST /api/auth/register: inactive user -> 403', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-bad',
      email: 'inactive@example.test',
      role: 'AFFILIATE',
      name: 'Blocked',
      status: 'INACTIVE',
    });

    const response = await registerPOST(request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: 'inactive@example.test', name: 'Blocked' }),
    }));

    expect(response.status).toBe(403);
  });

  it('POST /api/auth/send-otp: legacy payload -> 410', async () => {
    const response = await sendOtpPOST(request('/api/auth/send-otp', {
      method: 'POST',
      body: JSON.stringify({ email: 'known@example.test', code: '123456' }),
    }));

    expect(response.status).toBe(410);
  });

  it('POST /api/auth/send-otp: rate limit -> 429', async () => {
    checkRateLimit.mockResolvedValueOnce({
      allowed: false,
      limit: 3,
      remaining: 0,
      resetAt: new Date(),
    });

    const response = await sendOtpPOST(request('/api/auth/send-otp', {
      method: 'POST',
      body: JSON.stringify({ email: 'known@example.test' }),
    }));

    expect(response.status).toBe(429);
  });

  it('POST /api/auth/send-otp: valid flow -> 200', async () => {
    const response = await sendOtpPOST(request('/api/auth/send-otp', {
      method: 'POST',
      body: JSON.stringify({ email: 'known@example.test' }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true });
    expect(otpService.sendOTP).toHaveBeenCalledWith('known@example.test', { allowPending: true });
  });

  it('POST /api/auth/verify-otp: wrong code -> 400', async () => {
    otpService.verifyOTP.mockResolvedValueOnce({
      success: false,
      message: 'Wrong code',
    });

    const response = await verifyOtpPOST(request('/api/auth/verify-otp', {
      method: 'POST',
      body: JSON.stringify({ email: 'known@example.test', code: '000000' }),
    }));

    expect(response.status).toBe(400);
  });

  it('POST /api/auth/verify-otp: pending user -> 403', async () => {
    otpService.verifyOTP.mockResolvedValueOnce({
      success: true,
      message: 'Verified',
      user: {
        id: 'u-pending',
        email: 'pending@example.test',
        name: 'Pending',
        role: 'AFFILIATE',
        status: 'PENDING',
      },
    } as VerifyOTPResult);

    const response = await verifyOtpPOST(request('/api/auth/verify-otp', {
      method: 'POST',
      body: JSON.stringify({ email: 'pending@example.test', code: '123456' }),
    }));

    expect(response.status).toBe(403);
  });

  it('POST /api/auth/verify-otp: success sets auth cookie', async () => {
    otpService.verifyOTP.mockResolvedValueOnce({
      success: true,
      message: 'Verified',
      user: {
        id: 'u-active',
        email: 'active@example.test',
        name: 'Active',
        role: 'AFFILIATE',
        affiliate: { id: 'a-active' },
        status: 'ACTIVE',
      },
    } as VerifyOTPResult);

    const response = await verifyOtpPOST(request('/api/auth/verify-otp', {
      method: 'POST',
      body: JSON.stringify({ email: 'active@example.test', code: '123456' }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie') ?? '').toContain('auth-token=');
  });

  it('GET /api/auth/me: active user returns payload', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-active',
      email: 'active@example.test',
      name: 'Active',
      role: 'AFFILIATE',
      status: 'ACTIVE',
      affiliate: { id: 'a-active' },
    });

    const response = await meGET(request('/api/auth/me', {
      method: 'GET',
      headers: { 'x-user-id': 'u-active' },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.user).toMatchObject({ id: 'u-active', status: 'ACTIVE', hasAffiliate: true });
  });

  it('GET /api/auth/me: inactive user -> 403', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-inactive',
      status: 'SUSPENDED',
      role: 'AFFILIATE',
      affiliate: null,
    });

    const response = await meGET(request('/api/auth/me', {
      method: 'GET',
      headers: { 'x-user-id': 'u-inactive' },
    }));

    expect(response.status).toBe(403);
  });

  it('GET /api/auth/me: missing id -> 401', async () => {
    const response = await meGET(request('/api/auth/me', { method: 'GET' }));
    expect(response.status).toBe(401);
  });
});

describe('API: middleware access control', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
    prisma.user.findUnique.mockResolvedValue({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' });
  });

  it('admin route without token -> 401', async () => {
    const response = await middleware(request('/api/admin/payouts'));
    expect(response.status).toBe(401);
  });

  it('admin route with non-admin token -> 403', async () => {
    const token = await makeAuthToken({ userId: 'u-affiliate', role: 'AFFILIATE' });
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-affiliate', role: 'AFFILIATE', status: 'ACTIVE' });
    const response = await middleware(authRequest('/api/admin/payouts', token));

    expect(response.status).toBe(403);
  });

  it('admin/affiliate routes block inactive user even for affiliate route', async () => {
    const token = await makeAuthToken({ userId: 'u-inactive', role: 'AFFILIATE' });
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-inactive', role: 'AFFILIATE', status: 'INACTIVE' });

    const response = await middleware(authRequest('/api/affiliate/profile', token));

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toEqual({ error: 'Account is inactive or pending approval' });
  });

  it('admin route with admin token passes', async () => {
    const token = await makeAuthToken({ userId: 'u-admin', role: 'ADMIN' });
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' });
    const response = await middleware(authRequest('/api/admin/payouts', token));
    expect(response.status).toBe(200);
  });

  it('affiliate route with affiliate token passes', async () => {
    const token = await makeAuthToken({ userId: 'u-affiliate', role: 'AFFILIATE' });
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-affiliate', role: 'AFFILIATE', status: 'ACTIVE' });

    const response = await middleware(authRequest('/api/affiliate/profile', token));
    expect(response.status).toBe(200);
  });

  it('expired JWT token on admin route -> 401', async () => {
    const response = await middleware(authRequest('/api/admin/affiliates', await buildExpiredToken()));
    expect(response.status).toBe(401);
  });
});
