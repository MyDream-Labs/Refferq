import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './mocks/prisma.mock';
import { resetPrismaMock } from './utils/test-prisma-fixture';

vi.mock('@/lib/prisma', () => import('./mocks/prisma.mock'));

import { GET as affiliateProfileGET, PUT as affiliateProfilePUT } from '@/app/api/affiliate/profile/route';
import { POST as affiliateReferralsPOST, GET as affiliateReferralsGET } from '@/app/api/affiliate/referrals/route';
import { POST as affiliateGenerateCodePOST } from '@/app/api/affiliate/generate-code/route';
import { GET as affiliatePayoutsGET } from '@/app/api/affiliate/payouts/route';
import { GET as affiliateResourcesGET, POST as affiliateResourcesPOST } from '@/app/api/affiliate/resources/route';

const request = (path: string, init: Omit<RequestInit, 'signal'> = {}) =>
  new NextRequest(`http://localhost:3000${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string>),
    },
    ...init,
  });

const toDate = (iso = '2026-06-23T00:00:00.000Z') => new Date(iso);

describe('API: affiliate profile and referrals', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
  });

  it('GET /api/affiliate/profile: missing user -> 401', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);

    const response = await affiliateProfileGET(
      request('/api/affiliate/profile', {
        method: 'GET',
        headers: { 'x-user-id': 'unknown-user' },
      }),
    );

    expect(response.status).toBe(401);
  });

  it('GET /api/affiliate/profile: returns stats + metadata-backed referral list', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-aff',
      role: 'AFFILIATE',
      email: 'affiliate@example.test',
      name: 'Affiliate Test',
      affiliate: { id: 'affiliate-1', userId: 'user-aff', referralCode: 'AFF-1', balanceCents: 1200 },
    });
    prisma.referral.findMany.mockResolvedValueOnce([
      {
        id: 'ref-1',
        affiliateId: 'affiliate-1',
        leadName: 'Lead One',
        leadEmail: 'lead@example.test',
        status: 'APPROVED',
        createdAt: toDate(),
        metadata: { clicks: 3, estimated_value: 125 },
      },
    ]);
    prisma.conversion.findMany.mockResolvedValueOnce([]);
    prisma.commission.findMany.mockResolvedValueOnce([]);

    const response = await affiliateProfileGET(
      request('/api/affiliate/profile', {
        method: 'GET',
        headers: { 'x-user-id': 'user-aff' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      affiliate: { id: 'affiliate-1', referralCode: 'AFF-1' },
      stats: {
        totalClicks: 3,
        totalConversions: 0,
      },
    });
    expect(body.referrals[0]).toMatchObject({
      id: 'ref-1',
      estimatedValue: 125,
      company: '',
    });
  });

  it('PUT /api/affiliate/profile: email update conflict -> 400', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce({
        id: 'user-aff',
        role: 'AFFILIATE',
        email: 'old@example.test',
        affiliate: { id: 'affiliate-1', userId: 'user-aff' },
      })
      .mockResolvedValueOnce({
        id: 'other-user',
        role: 'ADMIN',
        email: 'blocked@example.test',
      });

    const response = await affiliateProfilePUT(
      request('/api/affiliate/profile', {
        method: 'PUT',
        headers: { 'x-user-id': 'user-aff' },
        body: JSON.stringify({
          name: 'Affiliate New',
          email: 'blocked@example.test',
        }),
      }),
    );

    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: 'Email already in use' });
  });

  it('POST /api/affiliate/referrals: creates referral for active affiliate', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-aff',
      role: 'AFFILIATE',
      affiliate: { id: 'affiliate-1', userId: 'user-aff' },
    });
    prisma.referral.create.mockResolvedValueOnce({
      id: 'ref-new',
      leadName: 'Buyer One',
      leadEmail: 'buyer@example.com',
      affiliateId: 'affiliate-1',
      status: 'PENDING',
    });

    const response = await affiliateReferralsPOST(
      request('/api/affiliate/referrals', {
        method: 'POST',
        headers: { 'x-user-id': 'user-aff' },
        body: JSON.stringify({
          leadName: 'Buyer One',
          leadEmail: 'buyer@example.com',
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      message: 'Referral submitted successfully',
      referral: { id: 'ref-new' },
    });
  });

  it('GET /api/affiliate/referrals: maps metadata to estimated value', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-aff',
      role: 'AFFILIATE',
      affiliate: { id: 'affiliate-1', userId: 'user-aff' },
    });
    prisma.referral.findMany.mockResolvedValueOnce([
      {
        id: 'ref-1',
        leadName: 'Buyer One',
        leadEmail: 'buyer@example.com',
        status: 'APPROVED',
        metadata: { estimated_value: 250, company: 'Acme Corp.' },
        createdAt: toDate(),
      },
    ]);

    const response = await affiliateReferralsGET(
      request('/api/affiliate/referrals', {
        method: 'GET',
        headers: { 'x-user-id': 'user-aff' },
      }),
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.referrals[0]).toMatchObject({
      id: 'ref-1',
      estimatedValue: 250,
      company: 'Acme Corp.',
    });
  });

  it('POST /api/affiliate/generate-code: creates affiliate profile if missing', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-aff',
      role: 'AFFILIATE',
      name: 'Affiliate Test',
      affiliate: null,
    });
    prisma.affiliate.create.mockResolvedValueOnce({
      id: 'affiliate-1',
      referralCode: 'GEN-ABCD',
    });

    const response = await affiliateGenerateCodePOST(
      request('/api/affiliate/generate-code', {
        method: 'POST',
        headers: { 'x-user-id': 'user-aff' },
      }),
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      message: 'Affiliate profile created with referral code',
      affiliate: { id: 'affiliate-1', referralCode: 'GEN-ABCD' },
    });
  });
});

describe('API: affiliate payouts and resources', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
  });

  it('GET /api/affiliate/payouts: returns mapped payouts', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-aff',
      role: 'AFFILIATE',
      email: 'affiliate@example.test',
      affiliate: { id: 'affiliate-1', userId: 'user-aff' },
    });

    prisma.payout.findMany.mockResolvedValueOnce([
      {
        id: 'payout-1',
        amountCents: 3000,
        status: 'PENDING',
        method: 'BANK',
        createdAt: toDate('2026-06-01T00:00:00.000Z'),
        processedAt: toDate('2026-06-20T00:00:00.000Z'),
      },
    ]);

    const response = await affiliatePayoutsGET(
      request('/api/affiliate/payouts', {
        method: 'GET',
        headers: { 'x-user-id': 'user-aff' },
      }),
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      payouts: [
        {
          id: 'payout-1',
          amount: 3000,
          status: 'PENDING',
          paidAt: '2026-06-20T00:00:00.000Z',
        },
      ],
    });
  });

  it('GET /api/affiliate/resources: returns active resources', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-aff',
      role: 'AFFILIATE',
      email: 'affiliate@example.test',
    });
    prisma.resource.findMany.mockResolvedValueOnce([
      {
        id: 'res-1',
        title: 'Guide',
        description: 'Intro',
        type: 'PDF',
        fileUrl: '/files/guide.pdf',
        fileName: 'guide.pdf',
        fileSize: 42,
        mimeType: 'application/pdf',
        category: 'guide',
        downloads: 1,
        createdAt: toDate(),
      },
    ]);

    const response = await affiliateResourcesGET(
      request('/api/affiliate/resources', {
        method: 'GET',
        headers: { 'x-user-id': 'user-aff' },
      }),
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      resources: [
        {
          id: 'res-1',
          title: 'Guide',
          fileName: 'guide.pdf',
        },
      ],
    });
  });

  it('POST /api/affiliate/resources: missing id -> 400', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-aff',
      role: 'AFFILIATE',
      email: 'affiliate@example.test',
    });

    const response = await affiliateResourcesPOST(
      request('/api/affiliate/resources', {
        method: 'POST',
        headers: { 'x-user-id': 'user-aff' },
      }),
    );

    expect(response.status).toBe(400);
  });

  it('POST /api/affiliate/resources: increments download counter', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-aff',
      role: 'AFFILIATE',
      email: 'affiliate@example.test',
    });
    prisma.resource.update.mockResolvedValueOnce({ id: 'res-1', downloads: 2 });

    const response = await affiliateResourcesPOST(
      request('/api/affiliate/resources?id=res-1', {
        method: 'POST',
        headers: { 'x-user-id': 'user-aff' },
      }),
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true });
    expect(prisma.resource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'res-1' },
        data: { downloads: { increment: 1 } },
      }),
    );
  });
});
