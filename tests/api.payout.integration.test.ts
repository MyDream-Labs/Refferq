import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from './mocks/prisma.mock';
import { resetPrismaMock } from './utils/test-prisma-fixture';
import { emailService } from './mocks/email.mock';

vi.mock('@/lib/prisma', () => import('./mocks/prisma.mock'));
vi.mock('@/lib/email', () => import('./mocks/email.mock'));
vi.mock('@/lib/program-settings', () => ({
  getProgramSettings: vi.fn(async () => ({
    commissionHoldDays: 30,
    minPayoutCents: 10000,
    payoutFrequency: 'MONTHLY',
    autoApprovePayouts: false,
  })),
}));

import { GET as payoutsGET, POST as payoutsPOST, PUT as payoutsPUT, DELETE as payoutsDELETE } from '@/app/api/admin/payouts/route';
import { POST as payoutAutoPOST, GET as payoutAutoGET } from '@/app/api/admin/payouts/auto/route';

const request = (path: string, init: Omit<RequestInit, 'signal'> = {}) =>
  new NextRequest(`http://localhost:3000${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string>),
    },
    ...init,
  });

describe('API: admin payouts', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
    emailService.sendPayoutCompletedEmail.mockReset();
    emailService.sendPayoutCreatedEmail.mockReset();
  });

  it('POST /api/admin/payouts: happy path creates payout and updates balances', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' });
    prisma.affiliate.findUnique.mockResolvedValueOnce({
      id: 'affiliate-1',
      userId: 'user-1',
      user: {
        id: 'user-1',
        name: 'Affiliate',
        email: 'affiliate@example.test',
        status: 'ACTIVE',
      },
    });

    prisma.commission.findMany.mockResolvedValueOnce([
      { id: 'commission-1', amountCents: 2000 },
      { id: 'commission-2', amountCents: 1500 },
    ]);
    prisma.commission.count.mockResolvedValueOnce(0);

    prisma.affiliate.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.payout.create.mockResolvedValueOnce({
      id: 'payout-1',
      affiliateId: 'affiliate-1',
      userId: 'user-1',
      amountCents: 3500,
      commissionCount: 2,
      status: 'PENDING',
      affiliate: {
        id: 'affiliate-1',
        user: {
          id: 'user-1',
          name: 'Affiliate',
          email: 'affiliate@example.test',
        },
      },
      method: 'BANK',
    });
    prisma.commission.updateMany.mockResolvedValueOnce({ count: 2 });

    const response = await payoutsPOST(
      request('/api/admin/payouts', {
        method: 'POST',
        headers: { 'x-user-id': 'admin-1' },
        body: JSON.stringify({
          affiliateId: 'affiliate-1',
          commissionIds: ['commission-1', 'commission-2'],
          method: 'BANK',
          notes: 'Monthly payout',
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      payout: {
        id: 'payout-1',
        amountCents: 3500,
        commissionCount: 2,
      },
    });
    expect(prisma.affiliate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'affiliate-1', balanceCents: { gte: 3500 } },
      }),
    );
  });

  it('POST /api/admin/payouts: invalid commissions -> 404', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' });
    prisma.affiliate.findUnique.mockResolvedValueOnce({
      id: 'affiliate-1',
      user: { id: 'user-1', status: 'ACTIVE', email: 'affiliate@example.test', name: 'Affiliate' },
    });

    prisma.commission.findMany.mockResolvedValueOnce([]);

    const response = await payoutsPOST(
      request('/api/admin/payouts', {
        method: 'POST',
        headers: { 'x-user-id': 'admin-1' },
        body: JSON.stringify({
          affiliateId: 'affiliate-1',
          commissionIds: ['missing-1'],
          method: 'BANK',
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ error: 'No valid (approved) commissions found' });
    expect(prisma.payout.create).not.toHaveBeenCalled();
  });

  it('POST /api/admin/payouts: insufficient balance fails and rolls back without success response', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' });
    prisma.affiliate.findUnique.mockResolvedValueOnce({
      id: 'affiliate-1',
      user: {
        id: 'user-1',
        name: 'Affiliate',
        email: 'affiliate@example.test',
        status: 'ACTIVE',
      },
    });
    prisma.commission.findMany.mockResolvedValueOnce([
      { id: 'commission-1', amountCents: 5000 },
      { id: 'commission-2', amountCents: 2500 },
    ]);
    prisma.commission.count.mockResolvedValueOnce(0);

    prisma.affiliate.updateMany.mockResolvedValueOnce({ count: 0 });

    const response = await payoutsPOST(
      request('/api/admin/payouts', {
        method: 'POST',
        headers: { 'x-user-id': 'admin-1' },
        body: JSON.stringify({
          affiliateId: 'affiliate-1',
          commissionIds: ['commission-1', 'commission-2'],
          method: 'BANK',
        }),
      }),
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ error: 'Failed to create payout' });
  });

  it('POST /api/admin/payouts: non-active affiliate is rejected', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' });
    prisma.affiliate.findUnique.mockResolvedValueOnce({
      id: 'affiliate-1',
      user: {
        id: 'user-1',
        status: 'SUSPENDED',
      },
    });

    const response = await payoutsPOST(
      request('/api/admin/payouts', {
        method: 'POST',
        headers: { 'x-user-id': 'admin-1' },
        body: JSON.stringify({
          affiliateId: 'affiliate-1',
          commissionIds: ['commission-1', 'commission-2'],
          method: 'BANK',
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: 'Affiliate is not active' });
  });

  it('POST /api/admin/payouts: commissions in hold period return 400', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' });
    prisma.affiliate.findUnique.mockResolvedValueOnce({
      id: 'affiliate-1',
      user: { id: 'user-1', status: 'ACTIVE', email: 'affiliate@example.test', name: 'Affiliate' },
    });

    prisma.commission.findMany.mockResolvedValueOnce([
      { id: 'commission-1', amountCents: 1200 },
    ]);
    prisma.commission.count.mockResolvedValueOnce(1);

    const response = await payoutsPOST(
      request('/api/admin/payouts', {
        method: 'POST',
        headers: { 'x-user-id': 'admin-1' },
        body: JSON.stringify({
          affiliateId: 'affiliate-1',
          commissionIds: ['commission-1', 'commission-2'],
          method: 'BANK',
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: '1 commission(s) are still in the hold period and cannot be paid out yet.',
    });
  });

  it('POST /api/admin/payouts: unauthorized returns 401/403 from auth guard', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);

    const response = await payoutsPOST(
      request('/api/admin/payouts', {
        method: 'POST',
        headers: {},
        body: JSON.stringify({
          affiliateId: 'affiliate-1',
          commissionIds: ['commission-1'],
        }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it('POST /api/admin/payouts/auto: dryRun returns eligible affiliates list', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' });
    prisma.commission.findMany.mockResolvedValueOnce([
      {
        id: 'commission-1',
        affiliateId: 'affiliate-1',
        amountCents: 7000,
        userId: 'user-1',
        affiliate: { id: 'affiliate-1', user: { name: 'Partner One', email: 'one@example.test' } },
      },
      {
        id: 'commission-2',
        affiliateId: 'affiliate-1',
        amountCents: 4000,
        userId: 'user-1',
        affiliate: { id: 'affiliate-1', user: { name: 'Partner One', email: 'one@example.test' } },
      },
    ]);

    const response = await payoutAutoPOST(
      request('/api/admin/payouts/auto', {
        method: 'POST',
        headers: { 'x-user-id': 'admin-1' },
        body: JSON.stringify({ dryRun: true }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      dryRun: true,
      totalAffiliates: 1,
      eligible: [
        {
          affiliateId: 'affiliate-1',
          commissions: 2,
          payoutCents: 11000,
        },
      ],
    });
  });

  it('POST /api/admin/payouts/auto: one affiliate fails without aborting other', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' });

    prisma.commission.findMany
      .mockResolvedValueOnce([
        {
          id: 'commission-a1',
          affiliateId: 'affiliate-1',
          amountCents: 7000,
          userId: 'user-1',
          affiliate: { id: 'affiliate-1', user: { name: 'Partner One', email: 'one@example.test' } },
        },
        {
          id: 'commission-a2',
          affiliateId: 'affiliate-1',
          amountCents: 4000,
          userId: 'user-1',
          affiliate: { id: 'affiliate-1', user: { name: 'Partner One', email: 'one@example.test' } },
        },
        {
          id: 'commission-b1',
          affiliateId: 'affiliate-2',
          amountCents: 12000,
          userId: 'user-2',
          affiliate: { id: 'affiliate-2', user: { name: 'Partner Two', email: 'two@example.test' } },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'commission-a1',
          affiliateId: 'affiliate-1',
          amountCents: 7000,
          userId: 'user-1',
          conversionId: 'conv-1',
        },
        {
          id: 'commission-a2',
          affiliateId: 'affiliate-1',
          amountCents: 4000,
          userId: 'user-1',
          conversionId: 'conv-2',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'commission-b1',
          affiliateId: 'affiliate-2',
          amountCents: 12000,
          userId: 'user-2',
          conversionId: 'conv-3',
        },
      ]);

    prisma.payout.create
      .mockResolvedValueOnce({ id: 'payout-1', affiliateId: 'affiliate-1', amountCents: 11000 })
      .mockResolvedValueOnce({ id: 'payout-2', affiliateId: 'affiliate-2', amountCents: 12000 });

    prisma.affiliate.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    prisma.commission.updateMany.mockResolvedValueOnce({ count: 2 });

    const response = await payoutAutoPOST(
      request('/api/admin/payouts/auto', {
        method: 'POST',
        headers: { 'x-user-id': 'admin-1' },
        body: JSON.stringify({ dryRun: false }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      processed: 1,
      results: [
        expect.objectContaining({ affiliateId: 'affiliate-1', status: 'CREATED' }),
        expect.objectContaining({ affiliateId: 'affiliate-2', status: 'FAILED' }),
      ],
    });
    expect(prisma.affiliate.updateMany).toHaveBeenCalledTimes(2);
  });

  it('PUT /api/admin/payouts: COMPLETED triggers side-effect', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' });
    prisma.payout.update.mockResolvedValueOnce({
      id: 'payout-1',
      affiliateId: 'affiliate-1',
      amountCents: 3500,
      status: 'COMPLETED',
      commissionCount: 2,
      affiliate: {
        id: 'affiliate-1',
        user: { id: 'user-1', name: 'Affiliate', email: 'affiliate@example.test' },
      },
    });

    const response = await payoutsPUT(
      request('/api/admin/payouts', {
        method: 'PUT',
        headers: { 'x-user-id': 'admin-1' },
        body: JSON.stringify({ id: 'payout-1', status: 'COMPLETED' }),
      }),
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      payout: {
        id: 'payout-1',
        status: 'COMPLETED',
      },
    });
    expect(emailService.sendPayoutCompletedEmail).toHaveBeenCalledWith('affiliate@example.test', expect.objectContaining({
      amountCents: 3500,
      payoutId: 'payout-1',
    }));
  });

  it('GET /api/admin/payouts: filters by affiliateId', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' });
    prisma.payout.findMany.mockResolvedValueOnce([
      {
        id: 'payout-1',
        affiliateId: 'affiliate-1',
        affiliate: {
          id: 'affiliate-1',
          user: {
            name: 'Affiliate One',
            email: 'one@example.test',
          },
        },
        amountCents: 1200,
        commissionCount: 2,
        status: 'PENDING',
        method: 'BANK',
        notes: 'Quarterly payout',
        createdAt: new Date('2026-06-20T00:00:00.000Z'),
        processedAt: null,
      },
    ]);

    const response = await payoutsGET(
      request('/api/admin/payouts?affiliateId=affiliate-1', {
        method: 'GET',
        headers: { 'x-user-id': 'admin-1' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      payouts: [
        {
          id: 'payout-1',
          affiliateId: 'affiliate-1',
          affiliateName: 'Affiliate One',
          affiliateEmail: 'one@example.test',
          amountCents: 1200,
          commissionCount: 2,
          status: 'PENDING',
        },
      ],
    });
    expect(prisma.payout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { affiliateId: 'affiliate-1' },
      }),
    );
  });

  it('GET /api/admin/payouts?format=csv: returns csv payload', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' });
    prisma.payout.findMany.mockResolvedValueOnce([
      {
        id: 'payout-1',
        affiliateId: 'affiliate-1',
        affiliate: {
          id: 'affiliate-1',
          user: {
            name: 'Affiliate One',
            email: 'one@example.test',
          },
        },
        amountCents: 1800,
        commissionCount: 1,
        status: 'COMPLETED',
        method: 'BANK',
        notes: 'Monthly',
        createdAt: new Date('2026-06-20T00:00:00.000Z'),
        processedAt: new Date('2026-06-21T00:00:00.000Z'),
      },
    ]);

    const response = await payoutsGET(
      request('/api/admin/payouts?format=csv', {
        method: 'GET',
        headers: { 'x-user-id': 'admin-1' },
      }),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(body).toContain('id,affiliateId,affiliateName,affiliateEmail,amountCents,commissionCount,status,method,notes,createdAt,processedAt');
    expect(body).toContain('payout-1');
    expect(body).toContain('Affiliate One');
  });

  it('DELETE /api/admin/payouts: removes payout and returns success', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' });
    prisma.payout.delete.mockResolvedValueOnce({ id: 'payout-1' });

    const response = await payoutsDELETE(
      request('/api/admin/payouts?id=payout-1', {
        method: 'DELETE',
        headers: { 'x-user-id': 'admin-1' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      message: 'Payout deleted successfully',
    });
    expect(prisma.payout.delete).toHaveBeenCalledWith({ where: { id: 'payout-1' } });
  });

  it('DELETE /api/admin/payouts: missing id -> 400', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' });

    const response = await payoutsDELETE(
      request('/api/admin/payouts', {
        method: 'DELETE',
        headers: { 'x-user-id': 'admin-1' },
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ error: 'Payout ID is required' });
  });

  it('GET /api/admin/payouts/auto: returns config and recent auto payouts', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' });
    prisma.commission.findMany.mockResolvedValueOnce([
      { affiliateId: 'affiliate-1', amountCents: 7000 },
      { affiliateId: 'affiliate-1', amountCents: 4000 },
      { affiliateId: 'affiliate-2', amountCents: 3000 },
    ]);
    prisma.payout.findMany.mockResolvedValueOnce([
      {
        id: 'payout-1',
        affiliateId: 'affiliate-1',
        amountCents: 11000,
        status: 'PENDING',
        createdAt: new Date('2026-06-20T00:00:00.000Z'),
        method: 'AUTO',
        notes: 'Auto-payout processed',
        affiliate: { user: { name: 'Partner One', email: 'one@example.test' } },
      },
    ]);

    const response = await payoutAutoGET(
      request('/api/admin/payouts/auto', {
        method: 'GET',
        headers: { 'x-user-id': 'admin-1' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      config: {
        minPayoutCents: 10000,
        payoutFrequency: 'MONTHLY',
        autoPayoutsEnabled: false,
      },
      stats: {
        eligibleAffiliates: 1,
        totalPendingCents: 11000,
      },
    });
    expect(body.recentPayouts).toHaveLength(1);
    expect(body.recentPayouts[0]).toMatchObject({ id: 'payout-1' });
  });
});
