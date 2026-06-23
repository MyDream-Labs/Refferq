import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emailService } from './mocks/email.mock';
import { prisma } from './mocks/prisma.mock';
import { resetPrismaMock } from './utils/test-prisma-fixture';

vi.mock('@/lib/prisma', () => import('./mocks/prisma.mock'));
vi.mock('@/lib/email', () => import('./mocks/email.mock'));
vi.mock('@/lib/audit', () => ({
  logAuditAction: vi.fn(async () => ({ id: 'mock-audit-id' })),
}));
vi.mock('@/lib/fraud-detection', () => ({
  checkFraud: vi.fn(async () => ({
    isSuspicious: false,
    reasons: [],
    riskScore: 0,
  })),
}));

import { POST as maturePOST } from '@/app/api/admin/commissions/mature/route';
import { GET as transactionsGET, POST as transactionsPOST, PUT as transactionsPUT, DELETE as transactionsDELETE } from '@/app/api/admin/transactions/route';
import { GET as rGET } from '../src/app/r/[code]/route';

const request = (path: string, init: Omit<RequestInit, 'signal'> = {}) =>
  new NextRequest(`http://localhost:3000${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string>),
    },
    ...init,
  });

describe('API: admin commissions mature', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
  });

  it('POST /api/admin/commissions/mature: unauthorized without token or cron secret', async () => {
    const response = await maturePOST(request('/api/admin/commissions/mature', { method: 'POST' }));

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({ error: 'Unauthorized' });
  });

  it('POST /api/admin/commissions/mature: returns no-op when nothing to mature', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' });
    prisma.commission.findMany.mockResolvedValueOnce([]);

    const response = await maturePOST(
      request('/api/admin/commissions/mature', {
        method: 'POST',
        headers: { 'x-user-id': 'admin-1' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, matured: 0, message: 'No commissions to mature' });
  });

  it('POST /api/admin/commissions/mature: approves matured commissions and updates affiliate balances', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' });
    prisma.commission.findMany.mockResolvedValueOnce([
      { id: 'com-1', affiliateId: 'affiliate-1', amountCents: 1500 },
      { id: 'com-2', affiliateId: 'affiliate-1', amountCents: 2500 },
      { id: 'com-3', affiliateId: 'affiliate-2', amountCents: 3000 },
    ]);

    prisma.commission.updateMany.mockResolvedValueOnce({ count: 3 });
    prisma.affiliate.update.mockResolvedValue({ id: 'affiliate-id' } as never);

    const response = await maturePOST(
      request('/api/admin/commissions/mature', {
        method: 'POST',
        headers: { 'x-user-id': 'admin-1' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      matured: 3,
      affiliatesUpdated: 2,
    });

    expect(prisma.commission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['com-1', 'com-2', 'com-3'] } },
      }),
    );
    expect(prisma.affiliate.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'affiliate-1' }, data: { balanceCents: { increment: 4000 } } }),
    );
    expect(prisma.affiliate.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'affiliate-2' }, data: { balanceCents: { increment: 3000 } } }),
    );
  });
});

describe('API: admin transactions', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
    emailService.sendTransactionCreatedEmail.mockReset();
  });

  it('GET /api/admin/transactions: returns mapped transactions list', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' });
    prisma.transaction.findMany.mockResolvedValueOnce([
      {
        id: 'tx-1',
        customerId: 'cust-1',
        customerName: 'Buyer',
        customerEmail: 'buyer@example.test',
        amountCents: 12000,
        commissionCents: 1500,
        commissionRate: 0.125,
        status: 'COMPLETED',
        description: 'Initial sale',
        invoiceId: 'INV-1',
        paymentMethod: 'CARD',
        paidAt: null,
        createdAt: new Date('2026-06-23T12:00:00.000Z'),
        referral: {
          id: 'ref-1',
          leadName: 'Lead',
          leadEmail: 'lead@example.test',
          status: 'APPROVED',
        },
        affiliate: {
          id: 'affiliate-1',
          partnerGroupId: 'group-1',
          user: {
            name: 'Affiliate',
            email: 'affiliate@example.test',
          },
          partnerGroup: {
            name: 'Gold',
          },
          referralCode: 'AFF-1',
        },
      },
    ]);

    const response = await transactionsGET(
      request('/api/admin/transactions?affiliateId=affiliate-1', {
        method: 'GET',
        headers: { 'x-user-id': 'admin-1' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      transactions: [
        {
          id: 'tx-1',
          customerId: 'cust-1',
          commissionRate: 0.125,
          affiliate: { id: 'affiliate-1', partnerGroup: 'Gold' },
        },
      ],
    });
  });

  it('GET /api/admin/transactions: unauthorized when user missing', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);

    const response = await transactionsGET(
      request('/api/admin/transactions', {
        method: 'GET',
        headers: { 'x-user-id': 'missing-user' },
      }),
    );

    expect(response.status).toBe(401);
  });

  it('POST /api/admin/transactions: creates transaction and commission side-effect', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' });
    prisma.referral.findUnique.mockResolvedValueOnce({
      id: 'ref-1',
      affiliateId: 'affiliate-1',
      leadName: 'Lead',
      leadEmail: 'lead@example.test',
      subscriptionId: 'sub-123',
      affiliate: {
        partnerGroupId: 'group-1',
        userId: 'user-aff',
      },
    });
    prisma.partnerGroup.findUnique.mockResolvedValueOnce({
      id: 'group-1',
      commissionRate: 0.15,
    });
    prisma.transaction.create.mockResolvedValueOnce({
      id: 'tx-2',
      referralId: 'ref-1',
      affiliateId: 'affiliate-1',
      amountCents: 10000,
      commissionCents: 1500,
      commissionRate: 0.15,
      status: 'COMPLETED',
      customerName: 'Lead',
      customerEmail: 'lead@example.test',
    });
    prisma.conversion.create.mockResolvedValueOnce({
      id: 'conv-2',
      affiliateId: 'affiliate-1',
      referralId: 'ref-1',
      amountCents: 10000,
      status: 'APPROVED',
    });
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-aff',
      email: 'affiliate@example.test',
      name: 'Affiliate',
    });

    const response = await transactionsPOST(
      request('/api/admin/transactions', {
        method: 'POST',
        headers: { 'x-user-id': 'admin-1' },
        body: JSON.stringify({
          referralId: 'ref-1',
          amount: 100,
          description: 'Manual transaction',
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      transaction: {
        id: 'tx-2',
        amountCents: 10000,
        commissionCents: 1500,
      },
      message: 'Transaction created successfully',
    });
    expect(emailService.sendTransactionCreatedEmail).toHaveBeenCalledWith('affiliate@example.test',
      expect.objectContaining({
        transactionId: 'tx-2',
        amountCents: 10000,
        commissionCents: 1500,
      }),
    );
  });

  it('POST /api/admin/transactions: returns 404 for unknown referral', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' });
    prisma.referral.findUnique.mockResolvedValueOnce(null);

    const response = await transactionsPOST(
      request('/api/admin/transactions', {
        method: 'POST',
        headers: { 'x-user-id': 'admin-1' },
        body: JSON.stringify({ referralId: 'missing', amount: 100 }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ error: 'Referral not found' });
  });

  it('PUT /api/admin/transactions: updates transaction', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' });
    prisma.transaction.update.mockResolvedValueOnce({
      id: 'tx-1',
      status: 'PAID',
      description: 'Updated',
    });

    const response = await transactionsPUT(
      request('/api/admin/transactions', {
        method: 'PUT',
        headers: { 'x-user-id': 'admin-1' },
        body: JSON.stringify({ id: 'tx-1', status: 'PAID', description: 'Updated' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      transaction: {
        id: 'tx-1',
        status: 'PAID',
      },
    });
  });

  it('DELETE /api/admin/transactions: removes transaction', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', status: 'ACTIVE' });
    prisma.transaction.delete.mockResolvedValueOnce({ id: 'tx-1' });

    const response = await transactionsDELETE(
      request('/api/admin/transactions?id=tx-1', {
        method: 'DELETE',
        headers: { 'x-user-id': 'admin-1' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, message: 'Transaction deleted successfully' });
  });
});

describe('API: /r/[code] redirect route', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
  });

  it('GET /r/[code]: tracks valid code, sets ref/attr and issues cookie', async () => {
    prisma.programSettings.findFirst.mockResolvedValueOnce({ websiteUrl: 'https://program.example.com' });
    prisma.affiliate.findUnique.mockResolvedValueOnce({
      id: 'affiliate-1',
      referralCode: 'JOHN-2026',
      user: {
        id: 'user-affiliate',
        email: 'affiliate@example.test',
        name: 'John',
        status: 'ACTIVE',
      },
    });
    prisma.referral.findFirst.mockResolvedValueOnce(null);
    prisma.referral.create.mockResolvedValueOnce({
      id: 'ref-1',
      affiliateId: 'affiliate-1',
      leadEmail: 'click-attr@tracking.internal',
      metadata: {},
    });

    const response = await rGET(
      request('/r/JOHN-2026?dest=https://program.example.com/landing&campaign=summer'),
      { params: Promise.resolve({ code: 'JOHN-2026' }) },
    );

    expect(response.status).toBe(307);

    const location = new URL(response.headers.get('location') || '');
    expect(location.origin).toBe('https://program.example.com');
    expect(location.pathname).toBe('/landing');
    expect(location.searchParams.get('campaign')).toBe('summer');
    expect(location.searchParams.get('ref')).toBe('JOHN-2026');
    expect(location.searchParams.get('attr')).toBeTruthy();

    const cookie = response.headers.get('set-cookie') || '';
    expect(cookie).toContain('affiliate_attribution=');
  });

  it('GET /r/[code]: missing code redirects to app/website fallback', async () => {
    prisma.programSettings.findFirst.mockResolvedValueOnce({ websiteUrl: 'https://program.example.com' });
    prisma.affiliate.findUnique.mockResolvedValueOnce(null);

    const response = await rGET(
      request('/r/UNKNOWN?dest=https://program.example.com/fail'),
      { params: Promise.resolve({ code: 'UNKNOWN' }) },
    );

    expect(response.status).toBe(307);
    const location = response.headers.get('location');
    expect(location).toBe('https://program.example.com/fail');
  });

  it('GET /r/[code]: blocks open redirect and falls back to allow-listed host', async () => {
    prisma.programSettings.findFirst.mockResolvedValueOnce({ websiteUrl: 'https://program.example.com' });
    prisma.affiliate.findUnique.mockResolvedValueOnce({
      id: 'affiliate-1',
      referralCode: 'JOHN-2026',
      user: { id: 'user-affiliate', email: 'affiliate@example.test', name: 'John', status: 'ACTIVE' },
    });
    prisma.referral.findFirst.mockResolvedValueOnce({
      id: 'existing-ref',
      metadata: {},
    });
    prisma.referral.update.mockResolvedValueOnce({ id: 'existing-ref', metadata: {} });
    prisma.referralClick.create.mockResolvedValueOnce({ id: 'click-existing' });

    const response = await rGET(
      request('/r/JOHN-2026?dest=https://malicious.example.com/phish'),
      { params: Promise.resolve({ code: 'JOHN-2026' }) },
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location') || '');
    expect(location.origin).toBe('https://program.example.com');
    expect(location.searchParams.get('ref')).toBe('JOHN-2026');
    expect(location.searchParams.get('attr')).toBeTruthy();
  });
});
