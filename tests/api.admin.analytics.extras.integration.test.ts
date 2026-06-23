import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from './mocks/prisma.mock';
import { resetPrismaMock } from './utils/test-prisma-fixture';
import { resend, resetEmailMocks } from './mocks/email.mock';

vi.mock('@/lib/prisma', () => import('./mocks/prisma.mock'));
vi.mock('@/lib/email', () => import('./mocks/email.mock'));

import { GET as adminAnalyticsGET } from '@/app/api/admin/analytics/route';
import { PATCH as adminAffiliatePATCH, DELETE as adminAffiliateDELETE } from '@/app/api/admin/affiliates/[id]/route';
import { POST as adminReportEmailPOST } from '@/app/api/admin/reports/email/route';

const request = (path: string, init: Omit<RequestInit, 'signal'> = {}) =>
  new NextRequest(`http://localhost:3000${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string>),
    },
    ...init,
  });

const date = (value = '2026-06-23T00:00:00.000Z') => new Date(value);

describe('API: admin analytics', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
  });

  it('GET /api/admin/analytics: non-admin is forbidden', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-aff', role: 'AFFILIATE', status: 'ACTIVE' } as never);

    const response = await adminAnalyticsGET(
      request('/api/admin/analytics', {
        method: 'GET',
        headers: { 'x-user-id': 'u-aff' },
      }),
    );

    expect(response.status).toBe(403);
  });

  it('GET /api/admin/analytics: returns rolled-up overview and aggregates', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' } as never);
    prisma.affiliate.findMany.mockResolvedValueOnce([
      {
        id: 'aff-1',
        referralCode: 'AFF-1',
        balanceCents: 2500,
        user: {
          name: 'Jane',
          email: 'jane@example.test',
        },
        referrals: [{}, {}],
        commissions: [{ amountCents: 1000 }, { amountCents: 700 }],
      },
    ]);
    prisma.referral.count
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(5);
    prisma.conversion.groupBy.mockResolvedValueOnce([
      { createdAt: date('2026-06-22T00:00:00.000Z'), _sum: { amountCents: 120000 } },
      { createdAt: date('2026-06-21T00:00:00.000Z'), _sum: { amountCents: 80000 } },
    ] as never);
    prisma.commission.aggregate
      .mockResolvedValueOnce({ _sum: { amountCents: 55000 }, _count: 9 } as never)
      .mockResolvedValueOnce({ _sum: { amountCents: 25000 }, _count: 4 } as never);
    prisma.referral.groupBy.mockResolvedValueOnce([
      { status: 'APPROVED', _count: 5 },
      { status: 'PENDING', _count: 3 },
    ] as never);

    const response = await adminAnalyticsGET(
      request('/api/admin/analytics?days=14', {
        method: 'GET',
        headers: { 'x-user-id': 'u-admin' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      period: 'Last 14 days',
      analytics: {
        overview: {
          totalReferrals: 8,
          approvedReferrals: 5,
          conversionRate: '62.50',
          totalRevenue: 55000,
          totalCommissionsPaid: 25000,
          pendingCommissions: 30000,
        },
        topAffiliates: [
          {
            id: 'aff-1',
            name: 'Jane',
            email: 'jane@example.test',
            referralCode: 'AFF-1',
            totalReferrals: 2,
            totalEarnings: 2500,
            totalCommissions: 2,
          },
        ],
      },
    });

    expect(body.analytics.referralsByStatus).toEqual([
      { status: 'APPROVED', count: 5 },
      { status: 'PENDING', count: 3 },
    ]);
    expect(body.analytics.dailyRevenue).toEqual([
      { date: '2026-06-22T00:00:00.000Z', amount: 120000 },
      { date: '2026-06-21T00:00:00.000Z', amount: 80000 },
    ]);
    expect(body.analytics.commissionStats).toEqual({
      total: { count: 9, amount: 55000 },
      paid: { count: 4, amount: 25000 },
      pending: { count: 5, amount: 30000 },
    });
  });
});

describe('API: admin affiliate by id', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
  });

  it('PATCH /api/admin/affiliates/[id]: non-admin is forbidden', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-aff', role: 'AFFILIATE', status: 'ACTIVE' } as never);

    const response = await adminAffiliatePATCH(
      request('/api/admin/affiliates/aff-1', {
        method: 'PATCH',
        headers: { 'x-user-id': 'u-aff' },
        body: JSON.stringify({ status: 'SUSPENDED' }),
      }),
      { params: Promise.resolve({ id: 'aff-1' }) },
    );

    expect(response.status).toBe(403);
  });

  it('PATCH /api/admin/affiliates/[id]: validates status payload', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' } as never);

    const response = await adminAffiliatePATCH(
      request('/api/admin/affiliates/aff-1', {
        method: 'PATCH',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({ status: '' }),
      }),
      { params: Promise.resolve({ id: 'aff-1' }) },
    );

    expect(response.status).toBe(400);
  });

  it('PATCH /api/admin/affiliates/[id]: updates status and writes audit log', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' } as never);
    prisma.affiliate.findUnique.mockResolvedValueOnce({
      id: 'aff-1',
      userId: 'u-aff',
      user: {
        id: 'u-aff',
        email: 'affiliate@example.test',
        status: 'ACTIVE',
      },
    });
    prisma.user.update.mockResolvedValueOnce({ id: 'u-aff', status: 'SUSPENDED' });

    const response = await adminAffiliatePATCH(
      request('/api/admin/affiliates/aff-1', {
        method: 'PATCH',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({ status: 'SUSPENDED', notes: 'Temporarily disabled' }),
      }),
      { params: Promise.resolve({ id: 'aff-1' }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      message: 'Affiliate status updated to SUSPENDED',
      affiliate: {
        id: 'aff-1',
        userId: 'u-aff',
        status: 'SUSPENDED',
      },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'UPDATE_AFFILIATE_STATUS',
          payload: expect.objectContaining({
            oldStatus: 'ACTIVE',
            newStatus: 'SUSPENDED',
            notes: 'Temporarily disabled',
            affiliateEmail: 'affiliate@example.test',
          }),
        }),
      }),
    );
  });

  it('DELETE /api/admin/affiliates/[id]: removes affiliate user and logs action', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' } as never);
    prisma.affiliate.findUnique.mockResolvedValueOnce({
      id: 'aff-1',
      user: {
        id: 'u-aff',
        name: 'Affiliate One',
        email: 'affiliate@example.test',
      },
      referralCode: 'AFF-1',
      userId: 'u-aff',
    });
    prisma.user.delete.mockResolvedValueOnce({ id: 'u-aff' });

    const response = await adminAffiliateDELETE(
      request('/api/admin/affiliates/aff-1', {
        method: 'DELETE',
        headers: { 'x-user-id': 'u-admin' },
      }),
      { params: Promise.resolve({ id: 'aff-1' }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      message: 'Affiliate deleted successfully',
    });
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u-aff' } });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'DELETE_AFFILIATE',
          payload: expect.objectContaining({
            affiliateName: 'Affiliate One',
            affiliateEmail: 'affiliate@example.test',
            referralCode: 'AFF-1',
          }),
        }),
      }),
    );
  });
});

describe('API: admin report email', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
    resetEmailMocks();
  });

  it('POST /api/admin/reports/email: validates required payload', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' } as never);

    const response = await adminReportEmailPOST(
      request('/api/admin/reports/email', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({ recipients: ['admin@example.test'] }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it('POST /api/admin/reports/email: uses mocked resend client for all recipients', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' } as never);
    prisma.affiliate.findMany.mockResolvedValueOnce([]);

    const response = await adminReportEmailPOST(
      request('/api/admin/reports/email', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({
          reportType: 'affiliates',
          recipients: ['ops@example.test', 'admin2@example.test'],
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      sent: 2,
      failed: 0,
    });
    expect(resend.emails.send).toHaveBeenCalledTimes(2);
    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'admin2@example.test',
      }),
    );
  });
});
