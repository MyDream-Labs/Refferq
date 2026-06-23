import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from './mocks/prisma.mock';
import { resetPrismaMock } from './utils/test-prisma-fixture';

vi.mock('@/lib/prisma', () => import('./mocks/prisma.mock'));

import { POST as affiliatesBatchPOST } from '@/app/api/admin/affiliates/batch/route';
import { GET as dashboardGET } from '@/app/api/admin/dashboard/route';
import { GET as reportsGET } from '@/app/api/admin/reports/route';
import { GET as adminEmailsGET, POST as adminEmailsPOST, PUT as adminEmailsPUT, DELETE as adminEmailsDELETE } from '@/app/api/admin/emails/route';
import { GET as adminRefundsGET, POST as adminRefundsPOST } from '@/app/api/admin/refunds/route';

const request = (path: string, init: Omit<RequestInit, 'signal'> = {}) =>
  new NextRequest(`http://localhost:3000${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string>),
    },
    ...init,
  });

const date = (value = '2026-06-23T00:00:00.000Z') => new Date(value);

describe('API: admin batch + analytics', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
  });

  it('POST /api/admin/affiliates/batch: non-admin is denied', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-aff', role: 'AFFILIATE' } as never);

    const response = await affiliatesBatchPOST(
      request('/api/admin/affiliates/batch', {
        method: 'POST',
        headers: { 'x-user-id': 'u-aff' },
        body: JSON.stringify({ affiliateIds: ['a1'], action: 'changeStatus', status: 'ACTIVE' }),
      }),
    );

    expect(response.status).toBe(403);
  });

  it('POST /api/admin/affiliates/batch: changeStatus updates user statuses and logs action', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' } as never);
    prisma.affiliate.findMany.mockResolvedValueOnce([
      { id: 'aff-1', userId: 'u-user-1' },
      { id: 'aff-2', userId: 'u-user-2' },
    ]);
    prisma.user.updateMany.mockResolvedValueOnce({ count: 2 });

    const response = await affiliatesBatchPOST(
      request('/api/admin/affiliates/batch', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({ affiliateIds: ['aff-1', 'aff-2'], action: 'changeStatus', status: 'SUSPENDED' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      message: 'Updated 2 affiliate(s) status to SUSPENDED',
      count: 2,
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'BATCH_UPDATE_AFFILIATE_STATUS',
          payload: expect.objectContaining({ affiliateIds: ['aff-1', 'aff-2'], newStatus: 'SUSPENDED', count: 2 }),
        }),
      }),
    );
  });

  it('POST /api/admin/affiliates/batch: changeGroup updates payoutDetails with group', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' } as never);
    prisma.affiliate.findUnique
      .mockResolvedValueOnce({ payoutDetails: { existing: true } })
      .mockResolvedValueOnce({ payoutDetails: { tier: 'old' } });
    prisma.affiliate.update.mockResolvedValue({ id: 'aff' });

    const response = await affiliatesBatchPOST(
      request('/api/admin/affiliates/batch', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({ affiliateIds: ['aff-1', 'aff-2'], action: 'changeGroup', group: 'Gold' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, message: 'Updated 2 affiliate(s) group to Gold', count: 2 });

    expect(prisma.affiliate.update).toHaveBeenCalledTimes(2);
    expect(prisma.affiliate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'aff-1' },
        data: expect.objectContaining({
          payoutDetails: expect.objectContaining({
            existing: true,
            group: 'Gold',
          }),
        }),
      }),
    );
  });

  it('POST /api/admin/affiliates/batch: delete removes users by ids and logs action', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' } as never);
    prisma.affiliate.findMany.mockResolvedValueOnce([
      { id: 'aff-1', userId: 'user-1', user: { email: 'one@example.test' } },
      { id: 'aff-2', userId: 'user-2', user: { email: 'two@example.test' } },
    ]);
    prisma.user.deleteMany.mockResolvedValueOnce({ count: 2 });

    const response = await affiliatesBatchPOST(
      request('/api/admin/affiliates/batch', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({ affiliateIds: ['aff-1', 'aff-2'], action: 'delete' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, message: 'Deleted 2 affiliate(s)', count: 2 });
    expect(prisma.user.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['user-1', 'user-2'] } },
    });
  });

  it('POST /api/admin/affiliates/batch: invalid payload is rejected', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' } as never);

    const response = await affiliatesBatchPOST(
      request('/api/admin/affiliates/batch', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({ action: 'changeStatus', status: 'ACTIVE' }),
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('affiliateIds array is required');
  });
});

describe('API: admin dashboard', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
  });

  it('GET /api/admin/dashboard: non-admin is forbidden', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-aff', role: 'AFFILIATE' } as never);

    const response = await dashboardGET(
      request('/api/admin/dashboard', {
        method: 'GET',
        headers: { 'x-user-id': 'u-aff' },
      }),
    );

    expect(response.status).toBe(403);
  });

  it('GET /api/admin/dashboard: calculates referral-based estimates with group commission rates', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN' } as never);
    prisma.affiliate.count.mockResolvedValueOnce(3);
    prisma.user.count.mockResolvedValueOnce(8);
    prisma.referral.count.mockResolvedValueOnce(10); // total
    prisma.conversion.count.mockResolvedValueOnce(7);
    prisma.referral.count.mockResolvedValueOnce(6); // pending
    prisma.referral.count.mockResolvedValueOnce(4); // approved
    prisma.conversion.aggregate.mockResolvedValueOnce({ _sum: { amountCents: 120000 } });
    prisma.partnerGroup.findMany.mockResolvedValueOnce([
      { id: 'g1', commissionRate: 0.15 },
      { id: 'g2', commissionRate: 0.25 },
    ]);
    prisma.referral.findMany.mockResolvedValueOnce([
      { metadata: { estimated_value: 100 }, affiliate: { partnerGroupId: 'g1' } },
      { metadata: { estimated_value: 200 }, affiliate: { partnerGroupId: 'g2' } },
    ]);

    const response = await dashboardGET(
      request('/api/admin/dashboard', {
        method: 'GET',
        headers: { 'x-user-id': 'u-admin' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      stats: {
        totalAffiliates: 3,
        totalUsers: 8,
        totalReferrals: 10,
        totalConversions: 7,
        pendingReferrals: 6,
        approvedReferrals: 4,
        totalRevenue: 120000,
      },
    });
    expect(body.stats.totalEstimatedRevenue).toBe(30000);
    expect(body.stats.totalEstimatedCommission).toBe(6500);
  });
});

describe('API: admin reports', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
  });

  it('GET /api/admin/reports: non-admin is forbidden', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-aff', role: 'AFFILIATE' } as never);

    const response = await reportsGET(
      request('/api/admin/reports', {
        method: 'GET',
        headers: { 'x-user-id': 'u-aff' },
      }),
    );

    expect(response.status).toBe(403);
  });

  it('GET /api/admin/reports: default summary returns aggregated data', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN' } as never);
    prisma.affiliate.count.mockResolvedValueOnce(4);
    prisma.referral.count.mockResolvedValueOnce(9);
    prisma.referral.count.mockResolvedValueOnce(5);
    prisma.commission.aggregate.mockResolvedValueOnce({ _sum: { amountCents: 55000 }, _count: 12 } as never);
    prisma.payout.aggregate.mockResolvedValueOnce({ _sum: { amountCents: 12000 }, _count: 3 } as never);

    const response = await reportsGET(
      request('/api/admin/reports', {
        method: 'GET',
        headers: { 'x-user-id': 'u-admin' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      report: {
        type: 'Summary Report',
        summary: {
          totalAffiliates: 4,
          totalReferrals: 9,
          approvedReferrals: 5,
          totalCommissions: 12,
          totalCommissionAmount: 55000,
          totalPayouts: 3,
          totalPayoutAmount: 12000,
        },
      },
    });
  });

  it('GET /api/admin/reports: affiliates format supports CSV output', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN' } as never);
    prisma.affiliate.findMany.mockResolvedValueOnce([
      {
        id: 'aff-1',
        user: { name: 'Alice', email: 'a@example.test' },
        referralCode: 'AL-1',
        referrals: [],
        commissions: [{ amountCents: 1200 }, { amountCents: 800 }],
        createdAt: date(),
      },
    ]);

    const response = await reportsGET(
      request('/api/admin/reports?type=affiliates&format=csv', {
        method: 'GET',
        headers: { 'x-user-id': 'u-admin' },
      }),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv');
    expect(body).toContain('affiliateId,name,email,referralCode,totalReferrals,approvedReferrals,pendingReferrals,totalCommissions,totalEarnings,paidEarnings,balance,joinedDate');
    expect(body).toContain('AL-1');
  });
});

describe('API: admin email templates', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
  });

  it('GET /api/admin/emails: non-admin gets unauthorized', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-aff', role: 'AFFILIATE' } as never);

    const response = await adminEmailsGET(
      request('/api/admin/emails', {
        method: 'GET',
        headers: { 'x-user-id': 'u-aff' },
      }),
    );

    expect(response.status).toBe(401);
  });

  it('GET /api/admin/emails: maps template stats with last sent date', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN' } as never);
    prisma.emailTemplate.findMany.mockResolvedValueOnce([
      {
        id: 't1',
        type: 'welcome',
        name: 'Welcome',
        subject: 'Welcome!',
        body: '<p>hi</p>',
        variables: ['name'],
        isActive: true,
        createdAt: date(),
        updatedAt: date(),
        _count: { emailLogs: 3 },
      },
    ]);
    prisma.emailLog.findFirst.mockResolvedValueOnce({ sentAt: date('2026-06-20T00:00:00.000Z') });

    const response = await adminEmailsGET(
      request('/api/admin/emails', {
        method: 'GET',
        headers: { 'x-user-id': 'u-admin' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.templates[0]).toMatchObject({
      id: 't1',
      sentCount: 3,
      lastSent: '2026-06-20T00:00:00.000Z',
    });
  });

  it('POST /api/admin/emails: create requires required fields', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN' } as never);

    const response = await adminEmailsPOST(
      request('/api/admin/emails', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({ name: 'Incomplete', type: 'welcome' }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it('POST /api/admin/emails: create returns success response', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN' } as never);
    prisma.emailTemplate.create.mockResolvedValueOnce({
      id: 'tpl-new',
      type: 'welcome',
      name: 'Welcome',
      subject: 'Welcome',
      body: '<p>body</p>',
      variables: ['name'],
      isActive: true,
      createdAt: date(),
      updatedAt: date(),
    });

    const response = await adminEmailsPOST(
      request('/api/admin/emails', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({
          type: 'welcome',
          name: 'Welcome',
          subject: 'Welcome',
          body: '<p>hello</p>',
          variables: ['name'],
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      template: { id: 'tpl-new', type: 'welcome' },
    });
  });

  it('PUT /api/admin/emails: missing id is rejected', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN' } as never);

    const response = await adminEmailsPUT(
      request('/api/admin/emails', {
        method: 'PUT',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({ isActive: false }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it('DELETE /api/admin/emails: requires id and succeeds on delete', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN' } as never)
      .mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN' } as never);

    const response = await adminEmailsDELETE(
      request('/api/admin/emails', {
        method: 'DELETE',
        headers: { 'x-user-id': 'u-admin' },
      }),
    );

    expect(response.status).toBe(400);

    prisma.emailTemplate.delete.mockResolvedValueOnce({ id: 't1' });
    const response2 = await adminEmailsDELETE(
      request('/api/admin/emails?id=t1', {
        method: 'DELETE',
        headers: { 'x-user-id': 'u-admin' },
      }),
    );
    const body = await response2.json();

    expect(response2.status).toBe(200);
    expect(body).toMatchObject({ success: true, message: 'Template deleted successfully' });
  });
});

describe('API: admin refunds', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
  });

  it('GET /api/admin/refunds: unauthorized for non-admin', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);

    const response = await adminRefundsGET(
      request('/api/admin/refunds', {
        method: 'GET',
        headers: { 'x-user-id': 'missing-user' },
      }),
    );

    expect(response.status).toBe(403);
  });

  it('GET /api/admin/refunds: returns refunded transactions list', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' } as never);
    prisma.transaction.findMany.mockResolvedValueOnce([
      {
        id: 'tx-1',
        createdAt: date(),
        updatedAt: date(),
        affiliate: {
          user: { name: 'John', email: 'john@example.test' },
        },
      },
    ]);

    const response = await adminRefundsGET(
      request('/api/admin/refunds', {
        method: 'GET',
        headers: { 'x-user-id': 'u-admin' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.count).toBe(1);
    expect(body.transactions[0].id).toBe('tx-1');
  });

  it('POST /api/admin/refunds: missing transactionId returns 400', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' } as never);

    const response = await adminRefundsPOST(
      request('/api/admin/refunds', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({ reason: 'fraud' }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it('POST /api/admin/refunds: happy path reverses latest commission and balances affiliate', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' } as never);
    prisma.transaction.findUnique.mockResolvedValueOnce({
      id: 'tx-1',
      amountCents: 12000,
      status: 'COMPLETED',
      description: 'Purchase',
      affiliateId: 'affiliate-1',
      affiliate: { id: 'affiliate-1', userId: 'user-1' },
      createdAt: date(),
      updatedAt: date(),
      customerName: 'Mike',
      customerEmail: 'mike@example.test',
    } as never);
    prisma.commission.findMany.mockResolvedValueOnce([
      { id: 'com-1', amountCents: 3000 },
    ]);
    prisma.transaction.update.mockResolvedValueOnce({
      id: 'tx-1',
      status: 'REFUNDED',
      description: 'Purchase [REFUNDED: customer asked]',
    } as never);
    prisma.commission.update.mockResolvedValueOnce({ id: 'com-1', amountCents: 3000, status: 'CANCELLED' } as never);
    prisma.affiliate.updateMany.mockResolvedValueOnce({ count: 1 });

    const response = await adminRefundsPOST(
      request('/api/admin/refunds', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({ transactionId: 'tx-1', reason: 'customer asked' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      results: {
        transactionRefunded: true,
        commissionReversed: true,
        balanceDeducted: true,
        reversedCommissionId: 'com-1',
        reversedAmountCents: 3000,
      },
    });
    expect(prisma.commission.findMany).toHaveBeenCalledWith({
      where: {
        affiliateId: 'affiliate-1',
        status: {
          in: ['PENDING', 'APPROVED'],
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('POST /api/admin/refunds: returns 404 for unknown transaction', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' } as never);
    prisma.transaction.findUnique.mockResolvedValueOnce(null);

    const response = await adminRefundsPOST(
      request('/api/admin/refunds', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({ transactionId: 'unknown-tx', reason: 'fraud' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({
      success: false,
      error: 'Transaction not found',
    });
  });

  it('POST /api/admin/refunds: returns 400 when transaction already refunded', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' } as never);
    prisma.transaction.findUnique.mockResolvedValueOnce({
      id: 'tx-1',
      status: 'REFUNDED',
      affiliateId: 'affiliate-1',
      affiliate: { id: 'affiliate-1', userId: 'user-1' },
    } as never);

    const response = await adminRefundsPOST(
      request('/api/admin/refunds', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({ transactionId: 'tx-1', reason: 'dup' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: 'Transaction already refunded',
    });
  });

  it('POST /api/admin/refunds: no reversible commission keeps transaction refunded but no balance change', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' } as never);
    prisma.transaction.findUnique.mockResolvedValueOnce({
      id: 'tx-1',
      amountCents: 8000,
      status: 'COMPLETED',
      description: 'No commission transaction',
      affiliateId: 'affiliate-1',
      affiliate: { id: 'affiliate-1', userId: 'user-1' },
    } as never);
    prisma.commission.findMany.mockResolvedValueOnce([]);
    prisma.transaction.update.mockResolvedValueOnce({
      id: 'tx-1',
      status: 'REFUNDED',
      description: 'No commission transaction [REFUNDED: no reversals]',
    } as never);

    const response = await adminRefundsPOST(
      request('/api/admin/refunds', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({ transactionId: 'tx-1', reason: 'no reversals' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      results: {
        transactionRefunded: true,
        commissionReversed: false,
        balanceDeducted: false,
        reversedCommissionId: null,
        reversedAmountCents: 0,
      },
    });
    expect(prisma.commission.update).not.toHaveBeenCalled();
    expect(prisma.affiliate.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'TRANSACTION_REFUNDED',
          payload: expect.objectContaining({
            commissionReversed: false,
            reversedAmountCents: 0,
            balanceDeducted: false,
          }),
        }),
      }),
    );
  });
});
