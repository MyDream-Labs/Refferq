import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { prisma } from './mocks/prisma.mock';
import { resetPrismaMock } from './utils/test-prisma-fixture';

vi.mock('@/lib/prisma', () => import('./mocks/prisma.mock'));
vi.mock('@/lib/program-settings', () => ({
  getProgramSettings: vi.fn(async () => ({ commissionHoldDays: 30 })),
}));
vi.mock('@/lib/email', () => import('./mocks/email.mock'));

import { POST as trackReferralPOST } from '@/app/api/track/referral/route';
import { POST as trackConversionPOST } from '@/app/api/track/conversion/route';
import { POST as webhookConversionPOST } from '@/app/api/webhook/conversion/route';
import { POST as webhookRefundPOST } from '@/app/api/webhook/refund/route';

type TrackingRequestInit = Omit<RequestInit, 'signal'> & { signal?: AbortSignal };

const request = (path: string, init: TrackingRequestInit = {}) =>
  new NextRequest(`http://localhost:3000${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string>),
    },
    ...init,
  });

function signWebhook(payload: string, secret: string) {
  const digest = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `sha256=${digest}`;
}

function makeTrackingDate(iso = '2026-06-23T00:00:00.000Z') {
  return new Date(iso);
}

describe('API: tracking endpoints', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
    prisma.integrationSettings.findFirst.mockResolvedValue({ id: 'integration-1', publicKey: 'pub-key', isActive: true });
  });

  it('POST /api/track/referral: no key -> 401', async () => {
    const response = await trackReferralPOST(
      request('/api/track/referral', {
        method: 'POST',
        body: JSON.stringify({ referralCode: 'JOHN-1234', url: 'https://app.example.com' }),
      }),
    );

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({ success: false, error: 'API key is required' });
  });

  it('POST /api/track/referral: invalid payload -> 400', async () => {
    const response = await trackReferralPOST(
      request('/api/track/referral', {
        method: 'POST',
        headers: { 'X-API-Key': 'pub-key' },
        body: JSON.stringify({ referralCode: '', url: 'https://ok.test' }),
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.success).toBe(false);
  });

  it('POST /api/track/referral: invalid code -> 404', async () => {
    prisma.affiliate.findUnique.mockResolvedValueOnce(null);

    const response = await trackReferralPOST(
      request('/api/track/referral', {
        method: 'POST',
        headers: { 'X-API-Key': 'pub-key' },
        body: JSON.stringify({ referralCode: 'UNKNOWN', url: 'https://ok.test' }),
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ success: false, error: 'Invalid referral code' });
  });

  it('POST /api/track/referral: success returns expected payload', async () => {
    prisma.affiliate.findUnique.mockResolvedValueOnce({
      id: 'affiliate-1',
      referralCode: 'JOHN-1234',
      user: { id: 'user-1', name: 'John', email: 'john@company.test', status: 'ACTIVE' },
    });

    const response = await trackReferralPOST(
      request('/api/track/referral', {
        method: 'POST',
        headers: { 'X-API-Key': 'pub-key' },
        body: JSON.stringify({
          referralCode: 'JOHN-1234',
          url: 'https://app.example.com',
          referrer: 'https://google.com',
          userAgent: 'vitest',
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      message: 'Referral tracked successfully',
      affiliate: { name: 'John', code: 'JOHN-1234' },
    });
  });

  it('POST /api/track/conversion: no key -> 401', async () => {
    const response = await trackConversionPOST(
      request('/api/track/conversion', {
        method: 'POST',
        body: JSON.stringify({ referralCode: 'JOHN-1234', customerEmail: 'buyer@example.com', orderId: 'ORD-1', amount: 12.5 }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it('POST /api/track/conversion: payload validation -> 400', async () => {
    const response = await trackConversionPOST(
      request('/api/track/conversion', {
        method: 'POST',
        headers: { 'X-API-Key': 'pub-key' },
        body: JSON.stringify({ referralCode: 'JOHN-1234', orderId: 'ORD-1', customerEmail: 'not-email' }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it('POST /api/track/conversion: invalid referral code -> 404', async () => {
    prisma.affiliate.findUnique.mockResolvedValueOnce(null);

    const response = await trackConversionPOST(
      request('/api/track/conversion', {
        method: 'POST',
        headers: { 'X-API-Key': 'pub-key' },
        body: JSON.stringify({
          referralCode: 'UNKNOWN',
          customerEmail: 'buyer@example.com',
          orderId: 'ORD-1',
          amount: 12.5,
        }),
      }),
    );

    expect(response.status).toBe(404);
  });

  it('POST /api/track/conversion: idempotency returns duplicate=true', async () => {
    prisma.conversion.findFirst.mockResolvedValueOnce({
      id: 'conv-dup',
      amountCents: 2500,
      currency: 'USD',
      status: 'PENDING',
      createdAt: makeTrackingDate(),
      affiliate: {
        referralCode: 'JOHN-1234',
        user: { name: 'John' },
      },
    });

    const response = await trackConversionPOST(
      request('/api/track/conversion', {
        method: 'POST',
        headers: {
          'X-API-Key': 'pub-key',
          'X-Idempotency-Key': 'idemp-key-1',
        },
        body: JSON.stringify({
          referralCode: 'JOHN-1234',
          customerEmail: 'buyer@example.com',
          orderId: 'ORD-1',
          amountCents: 2500,
          eventType: 'PURCHASE',
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      duplicate: true,
      conversion: { id: 'conv-dup', amount: 25 },
    });
    expect(prisma.conversion.create).not.toHaveBeenCalled();
  });

  it('POST /api/track/conversion: happy path creates conversion and referral record', async () => {
    prisma.affiliate.findUnique.mockResolvedValueOnce({
      id: 'affiliate-1',
      referralCode: 'JOHN-1234',
      user: { id: 'user-1', name: 'John', email: 'john@company.test', status: 'ACTIVE' },
    });
    prisma.referral.findFirst.mockResolvedValueOnce(null);
    prisma.referral.create.mockResolvedValueOnce({
      id: 'ref-1',
      affiliateId: 'affiliate-1',
      leadEmail: 'buyer@example.com',
      leadName: 'Buyer',
      status: 'APPROVED',
      metadata: { _trackFlowState: 'CONVERSION' },
    });
    prisma.conversion.create.mockResolvedValueOnce({
      id: 'conv-new',
      amountCents: 2500,
      currency: 'USD',
      status: 'PENDING',
      createdAt: makeTrackingDate(),
    });

    const response = await trackConversionPOST(
      request('/api/track/conversion', {
        method: 'POST',
        headers: { 'X-API-Key': 'pub-key' },
        body: JSON.stringify({
          referralCode: 'JOHN-1234',
          customerEmail: 'buyer@example.com',
          orderId: 'ORD-1',
          amount: 25,
          eventType: 'PURCHASE',
          customerName: 'Buyer',
        }),
      }),
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      conversion: {
        id: 'conv-new',
        amount: 25,
        currency: 'USD',
      },
      affiliate: {
        code: 'JOHN-1234',
      },
      idempotency: {
        key: 'ORD-1',
      },
    });
  });
});

describe('API: webhook conversion', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
  });

  it('POST /api/webhook/conversion: unauthorized without key/signature -> 401', async () => {
    const response = await webhookConversionPOST(
      request('/api/webhook/conversion', {
        method: 'POST',
        body: JSON.stringify({
          event_type: 'PURCHASE',
          eventId: 'evt-1',
          customer_email: 'buyer@example.com',
          amount_cents: 1000,
          referral_code: 'JOHN-1234',
        }),
      }),
    );

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.message).toContain('Unauthorized');
  });

  it('POST /api/webhook/conversion: API key auth + referral attribution', async () => {
    prisma.apiKey.findFirst.mockResolvedValueOnce({ id: 'key-1', userId: 'admin-1' });
    prisma.commissionRule.findMany.mockResolvedValueOnce([
      { id: 'rule-1', isDefault: true, type: 'PERCENTAGE', value: 15 },
    ]);
    prisma.conversion.findFirst.mockResolvedValueOnce(null);
    prisma.conversion.create.mockResolvedValueOnce({
      id: 'conv-wh-1',
      affiliateId: 'affiliate-1',
      amountCents: 1000,
      currency: 'USD',
      status: 'PENDING',
      createdAt: makeTrackingDate(),
    });
    prisma.commission.create.mockResolvedValueOnce({
      id: 'commission-1',
      amountCents: 150,
      status: 'PENDING',
      conversionId: 'conv-wh-1',
      affiliateId: 'affiliate-1',
      userId: 'user-1',
    });
    prisma.db.getAffiliateByReferralCode.mockResolvedValueOnce({
      id: 'affiliate-1',
      referralCode: 'JOHN-1234',
      user: { id: 'user-1', name: 'John', email: 'john@company.test', status: 'ACTIVE' },
    });

    const response = await webhookConversionPOST(
      request('/api/webhook/conversion', {
        method: 'POST',
        headers: { 'x-api-key': 'api-key-1' },
        body: JSON.stringify({
          event_type: 'PURCHASE',
          eventId: 'evt-1',
          customer_email: 'buyer@example.com',
          amount_cents: 1000,
          referral_code: 'JOHN-1234',
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      attributed: true,
      conversion: { id: 'conv-wh-1', amount: 10 },
      attributionMethod: 'referral_code',
      commission: { amount: 1.5, status: 'PENDING' },
    });
    expect(prisma.conversion.create).toHaveBeenCalledTimes(1);
  });

  it('POST /api/webhook/conversion: duplicate webhook is idempotent', async () => {
    prisma.apiKey.findFirst.mockResolvedValueOnce({ id: 'key-1', userId: 'admin-1' });
    prisma.conversion.findFirst.mockResolvedValueOnce({
      id: 'conv-existing',
      amountCents: 1000,
      currency: 'USD',
      status: 'PENDING',
      affiliate: {
        id: 'affiliate-1',
        referralCode: 'JOHN-1234',
        user: { name: 'John' },
      },
      commissions: [
        {
          id: 'commission-existing',
          amountCents: 150,
          status: 'PENDING',
        },
      ],
    });

    const response = await webhookConversionPOST(
      request('/api/webhook/conversion', {
        method: 'POST',
        headers: { 'x-api-key': 'api-key-1' },
        body: JSON.stringify({
          event_type: 'PURCHASE',
          eventId: 'evt-dup',
          customer_email: 'buyer@example.com',
          amount_cents: 1000,
          referral_code: 'JOHN-1234',
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      duplicate: true,
    });
    expect(prisma.conversion.create).not.toHaveBeenCalled();
  });

  it('POST /api/webhook/conversion: signed secret auth path', async () => {
    const rawBody = JSON.stringify({
      event_type: 'PURCHASE',
      eventId: 'evt-sig',
      customer_email: 'buyer@example.com',
      amount_cents: 1200,
      attribution_key: 'attr-sig',
    });

    prisma.apiKey.findFirst.mockResolvedValueOnce(null);
    prisma.conversion.findFirst.mockResolvedValueOnce(null);
    prisma.commissionRule.findMany.mockResolvedValueOnce([
      { id: 'rule-1', isDefault: true, type: 'PERCENTAGE', value: 10 },
    ]);

    const response = await webhookConversionPOST(
      request('/api/webhook/conversion', {
        method: 'POST',
        headers: {
          'x-webhook-signature': signWebhook(rawBody, process.env.WEBHOOK_SECRET || 'vitest-webhook-secret'),
        },
        body: rawBody,
      }),
    );

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      attributed: false,
    });
  });
});

describe('API: webhook refund', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
    prisma.apiKey.findFirst.mockResolvedValue({ id: 'key-1', userId: 'admin-1' });
    prisma.user.findFirst.mockResolvedValue({ id: 'user-1', email: 'affiliate@company.test' });
  });

  it('POST /api/webhook/refund: missing id fields -> 400', async () => {
    const rawBody = JSON.stringify({
      event_type: 'PURCHASE',
      customer_email: 'buyer@example.com',
      amount_cents: 1000,
      refund_reason: 'reason',
    });

    const response = await webhookRefundPOST(
      request('/api/webhook/refund', {
        method: 'POST',
        headers: { 'x-webhook-signature': signWebhook(rawBody, process.env.WEBHOOK_SECRET || 'vitest-webhook-secret') },
        body: rawBody,
      }),
    );

    expect(response.status).toBe(400);
  });

  it('POST /api/webhook/refund: already processed idempotent path', async () => {
    prisma.conversion.findFirst.mockResolvedValueOnce({
      id: 'conv-1',
      affiliate: {
        user: {
          email: 'affiliate@company.test',
          name: 'Affiliate',
        },
      },
      eventMetadata: {
        refundResult: {
          reversedCount: 2,
          totalReversedCents: 1500,
        },
      },
    });

    const response = await webhookRefundPOST(
      request('/api/webhook/refund', {
        method: 'POST',
        headers: { 'x-api-key': 'api-key-1' },
        body: JSON.stringify({
          event_type: 'PURCHASE',
          eventId: 'evt-2',
          customer_email: 'buyer@example.com',
          amount_cents: 1000,
          external_id: 'ext-2',
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      duplicate: true,
      reversed: { reversedCount: 2, totalReversedCents: 1500 },
    });
  });

  it.each([
    ['PENDING', 'CANCELLED'],
    ['APPROVED', 'CANCELLED'],
    ['PAID', 'CLAWBACK'],
  ])('POST /api/webhook/refund: status %s moves to expected commission state', async (initialStatus, expectedStatus) => {
    prisma.commission.update.mockResolvedValueOnce({
      id: 'com-1',
      amountCents: 1200,
      status: expectedStatus,
      affiliateId: 'affiliate-1',
    });

    prisma.affiliate.updateMany.mockResolvedValueOnce({
      count: initialStatus === 'PENDING' ? 0 : 1,
    });

    prisma.conversion.findMany.mockResolvedValueOnce([
      {
        id: 'conv-1',
        affiliateId: 'affiliate-1',
        commissions: [
          {
            id: 'com-1',
            affiliateId: 'affiliate-1',
            amountCents: 1200,
            status: initialStatus,
          },
        ],
        affiliate: {
          id: 'affiliate-1',
          user: {
            id: 'user-1',
            name: 'Affiliate',
            email: 'affiliate@company.test',
          },
        },
      },
    ]);

    prisma.conversion.update.mockResolvedValueOnce({ id: 'conv-1' });

    const response = await webhookRefundPOST(
      request('/api/webhook/refund', {
        method: 'POST',
        headers: { 'x-api-key': 'api-key-1' },
        body: JSON.stringify({
          event_type: 'PURCHASE',
          external_id: 'ext-1',
          customer_email: 'buyer@example.com',
          amount_cents: 1000,
          reason: 'Customer request',
        }),
      }),
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.reversed).toBe(1);
    expect(body.totalReversedCents).toBe(1200);
    expect(prisma.conversion.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'REJECTED' }),
    }));

    const updatePayload = (prisma.commission.update.mock.calls[0]?.[0] as { data?: { status?: string } })?.data;
    expect(updatePayload?.status).toBe(expectedStatus);

    if (initialStatus === 'PENDING') {
      expect(prisma.affiliate.update).not.toHaveBeenCalled();
    } else {
      expect(prisma.affiliate.update).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: 'affiliate-1' }),
        data: expect.objectContaining({ balanceCents: { decrement: 1200 } }),
      }));
    }
  });
});
