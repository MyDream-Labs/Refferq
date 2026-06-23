import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from './mocks/prisma.mock';
import { resetPrismaMock } from './utils/test-prisma-fixture';

vi.mock('@/lib/prisma', () => import('./mocks/prisma.mock'));
vi.mock('@/lib/program-settings', () => ({
  getProgramSettings: vi.fn(async () => ({
    id: 'program-1',
    currency: 'USD',
    productName: 'Affiliate Program',
    programName: 'Refferq Affiliate Program',
    websiteUrl: 'https://app.refferq.com',
    portalSubdomain: 'app',
    minimumPayoutThreshold: 100,
    minPayoutCents: 10000,
    payoutTerm: 'NET-15',
    commissionHoldDays: 30,
    payoutFrequency: 'MONTHLY',
    autoApprovePayouts: false,
    autoApprove: false,
    payoutMethods: ['PAYPAL'],
  })),
}));

import { GET as adminAffiliatesGET, POST as adminAffiliatesPOST } from '@/app/api/admin/affiliates/route';
import { GET as adminReferralsGET, POST as adminReferralsPOST } from '@/app/api/admin/referrals/route';
import { PUT as adminReferralPUT } from '../src/app/api/admin/referrals/[id]/route';
import { GET as adminPartnerGroupsGET, POST as adminPartnerGroupsPOST, PUT as adminPartnerGroupsPUT, DELETE as adminPartnerGroupsDELETE } from '@/app/api/admin/partner-groups/route';
import { GET as adminApiKeysGET, POST as adminApiKeysPOST, PUT as adminApiKeysPUT, DELETE as adminApiKeysDELETE } from '@/app/api/admin/api-keys/route';
import { GET as adminSettingsGET, PUT as adminSettingsPUT } from '@/app/api/admin/settings/route';

const request = (path: string, init: Omit<RequestInit, 'signal'> = {}) =>
  new NextRequest(`http://localhost:3000${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string>),
    },
    ...init,
  });

const date = (value = '2026-06-23T00:00:00.000Z') => new Date(value);

describe('API: admin core operations', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
  });

  it('GET /api/admin/affiliates: non-admin is denied', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-aff', role: 'AFFILIATE', status: 'ACTIVE' });

    const response = await adminAffiliatesGET(
      request('/api/admin/affiliates', {
        method: 'GET',
        headers: { 'x-user-id': 'u-aff' },
      }),
    );

    expect(response.status).toBe(403);
  });

  it('GET /api/admin/affiliates: returns affiliates with count', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' });
    prisma.affiliate.findMany.mockResolvedValueOnce([
      {
        id: 'affiliate-1',
        userId: 'u-aff',
        referralCode: 'AFF-1',
        partnerGroupId: null,
        balanceCents: 1500,
        user: {
          id: 'u-aff',
          name: 'Affiliate One',
          email: 'aff@example.test',
          role: 'AFFILIATE',
          status: 'ACTIVE',
          createdAt: date(),
        },
        _count: { referrals: 2 },
      },
    ]);

    const response = await adminAffiliatesGET(
      request('/api/admin/affiliates', {
        method: 'GET',
        headers: { 'x-user-id': 'u-admin' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      affiliates: [
        expect.objectContaining({
          id: 'affiliate-1',
          referralCode: 'AFF-1',
          _count: { referrals: 2 },
        }),
      ],
    });
  });

  it('POST /api/admin/affiliates: creates affiliate and returns temporary password', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' });
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.user.create.mockResolvedValueOnce({
      id: 'u-new',
      name: 'New Affiliate',
      email: 'new@example.test',
      role: 'AFFILIATE',
      status: 'ACTIVE',
    });
    prisma.affiliate.create.mockResolvedValueOnce({
      id: 'affiliate-new',
      referralCode: 'AF-NEW',
      userId: 'u-new',
      balanceCents: 0,
      createdAt: date(),
    });

    const response = await adminAffiliatesPOST(
      request('/api/admin/affiliates', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({
          name: 'New Affiliate',
          email: 'new@example.test',
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      affiliate: {
        id: 'affiliate-new',
        referralCode: 'AF-NEW',
      },
      message: 'Affiliate created successfully',
      temporaryPassword: expect.any(String),
    });
  });

  it('POST /api/admin/affiliates: duplicate user gets 400', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' });
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-exists', email: 'exists@example.test', role: 'AFFILIATE' });

    const response = await adminAffiliatesPOST(
      request('/api/admin/affiliates', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({
          name: 'Existing',
          email: 'exists@example.test',
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: 'User with this email already exists' });
  });

  it('GET /api/admin/referrals: maps partner group and default rate', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' });
    prisma.referral.findMany.mockResolvedValueOnce([
      {
        id: 'ref-1',
        leadEmail: 'lead@example.test',
        leadName: 'Lead One',
        leadPhone: '+123',
        status: 'PENDING',
        notes: 'Test note',
        createdAt: date(),
        metadata: { estimated_value: 120, company: 'ACME' },
        affiliate: {
          id: 'affiliate-1',
          user: { name: 'Aff One', email: 'aff@example.test', id: 'u-aff', role: 'AFFILIATE', status: 'ACTIVE' },
          partnerGroupId: 'group-1',
          referralCode: 'AFF-1',
          userId: 'u-aff',
        },
      },
    ]);
    prisma.partnerGroup.findMany.mockResolvedValueOnce([{ id: 'group-1', name: 'Gold', commissionRate: 0.2 }]);

    const response = await adminReferralsGET(
      request('/api/admin/referrals', {
        method: 'GET',
        headers: { 'x-user-id': 'u-admin' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
    });
    expect(body.referrals).toHaveLength(1);
    expect(body.referrals[0]).toMatchObject({
      id: 'ref-1',
      leadEmail: 'lead@example.test',
      estimatedValue: 120,
      company: 'ACME',
      affiliate: {
        id: 'affiliate-1',
        referralCode: 'AFF-1',
        partnerGroup: 'Gold',
        partnerGroupId: 'group-1',
        commissionRate: 0.2,
      },
    });
  });

  it('POST /api/admin/referrals: validates action and performs batch update', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' });
    prisma.referral.updateMany.mockResolvedValueOnce({ count: 1 });

    const response = await adminReferralsPOST(
      request('/api/admin/referrals', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({
          referralIds: ['ref-1'],
          action: 'approve',
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      message: '1 referrals approved successfully',
      updatedCount: 1,
    });
  });

  it('POST /api/admin/referrals: invalid action is rejected', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' });

    const response = await adminReferralsPOST(
      request('/api/admin/referrals', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({
          referralIds: ['ref-1'],
          action: 'noop',
        }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it('PUT /api/admin/referrals/[id]: approve creates conversion and commission', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' });
    prisma.referral.findUnique.mockResolvedValueOnce({
      id: 'ref-1',
      affiliateId: 'affiliate-1',
      affiliate: {
        userId: 'u-aff',
        partnerGroup: { commissionRate: 15 },
      },
      metadata: { estimated_value: 80 },
    });
    prisma.referral.update.mockResolvedValueOnce({
      id: 'ref-1',
      status: 'APPROVED',
      leadName: 'Lead One',
      leadEmail: 'lead@example.test',
      affiliateId: 'affiliate-1',
    });
    prisma.conversion.create.mockResolvedValueOnce({
      id: 'conversion-1',
      affiliateId: 'affiliate-1',
      referralId: 'ref-1',
      amountCents: 8000,
    });
    prisma.commission.create.mockResolvedValueOnce({
      id: 'commission-1',
      affiliateId: 'affiliate-1',
      amountCents: 1200,
      conversionId: 'conversion-1',
    });

    const response = await adminReferralPUT(
      request('/api/admin/referrals/ref-1', {
        method: 'PUT',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({ action: 'approve' }),
      }),
      { params: Promise.resolve({ id: 'ref-1' }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      message: 'Referral approved successfully',
      referral: { id: 'ref-1', status: 'APPROVED' },
    });

    expect(prisma.conversion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'PURCHASE',
          referralId: 'ref-1',
        }),
      }),
    );
  });

  it('GET /api/admin/partner-groups: returns groups with memberCount', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' });
    prisma.partnerGroup.findMany.mockResolvedValueOnce([
      {
        id: 'group-1',
        name: 'Gold',
        description: 'High tier',
        commissionRate: 0.2,
        signupUrl: 'https://app.refferq.com',
        isDefault: true,
        createdAt: date(),
        updatedAt: date(),
      },
    ]);
    prisma.affiliate.count.mockResolvedValueOnce(3);

    const response = await adminPartnerGroupsGET(
      request('/api/admin/partner-groups', {
        method: 'GET',
        headers: { 'x-user-id': 'u-admin' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      partnerGroups: [
        expect.objectContaining({
          id: 'group-1',
          name: 'Gold',
          memberCount: 3,
        }),
      ],
    });
  });

  it('POST /api/admin/partner-groups: sets new default after create', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' });
    prisma.partnerGroup.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.partnerGroup.create.mockResolvedValueOnce({
      id: 'group-2',
      name: 'Silver',
      description: 'New',
      commissionRate: 0.1,
      signupUrl: null,
      isDefault: true,
    });

    const response = await adminPartnerGroupsPOST(
      request('/api/admin/partner-groups', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({
          name: 'Silver',
          commissionRate: 0.1,
          isDefault: true,
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      message: 'Partner group created successfully',
      partnerGroup: { id: 'group-2', name: 'Silver' },
    });

    expect(prisma.partnerGroup.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isDefault: true },
        data: { isDefault: false },
      }),
    );
  });

  it('DELETE /api/admin/partner-groups: blocked when group has members', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' });
    prisma.partnerGroup.findUnique.mockResolvedValueOnce({ id: 'group-1', name: 'Gold' });
    prisma.affiliate.count.mockResolvedValueOnce(2);

    const response = await adminPartnerGroupsDELETE(
      request('/api/admin/partner-groups?id=group-1', {
        method: 'DELETE',
        headers: { 'x-user-id': 'u-admin' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: 'Cannot delete partner group with 2 active member(s)',
    });
  });

  it('GET /api/admin/api-keys: returns masked key and request counts', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' });
    prisma.apiKey.findMany.mockResolvedValueOnce([
      {
        id: 'key-1',
        name: 'Webhook',
        prefix: 'rfq_abc',
        scopes: ['read', 'write'],
        rateLimit: 500,
        isActive: true,
        lastUsedAt: null,
        expiresAt: null,
        createdAt: date(),
        _count: { usageLogs: 5 },
      },
    ]);

    const response = await adminApiKeysGET(
      request('/api/admin/api-keys', {
        method: 'GET',
        headers: { 'x-user-id': 'u-admin' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      apiKeys: [
        {
          id: 'key-1',
          maskedKey: 'rfq_abc...',
          totalRequests: 5,
        },
      ],
    });
  });

  it('POST /api/admin/api-keys: creates key and returns raw key once', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' });
    prisma.apiKey.create.mockResolvedValueOnce({
      id: 'key-2',
      name: 'Service',
      key: 'rfq_full-key',
      prefix: 'rfq_ser',
      scopes: ['read'],
      rateLimit: 100,
      keyHash: 'hash',
      expiresAt: null,
      createdAt: date(),
    });

    const response = await adminApiKeysPOST(
      request('/api/admin/api-keys', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({ name: 'Service', scopes: ['read'], rateLimit: 100 }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      apiKey: {
        id: 'key-2',
        name: 'Service',
      },
    });
    expect(body.apiKey.key).toMatch(/^rfq_[a-f0-9]{64}$/);
  });

  it('PUT /api/admin/api-keys: updates key fields', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' });
    prisma.apiKey.update.mockResolvedValueOnce({
      id: 'key-1',
      name: 'Webhook',
      prefix: 'rfq_abc',
      scopes: ['read'],
      rateLimit: 250,
      isActive: false,
    });

    const response = await adminApiKeysPUT(
      request('/api/admin/api-keys', {
        method: 'PUT',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({
          id: 'key-1',
          rateLimit: 250,
          isActive: false,
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      apiKey: {
        id: 'key-1',
        isActive: false,
      },
    });
  });

  it('DELETE /api/admin/api-keys: removes key', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' });
    prisma.apiKey.delete.mockResolvedValueOnce({ id: 'key-1' });

    const response = await adminApiKeysDELETE(
      request('/api/admin/api-keys', {
        method: 'DELETE',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({ id: 'key-1' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, message: 'API key revoked' });
  });

  it('GET /api/admin/settings: maps settings and commission rules', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' });
    prisma.programSettings.findFirst.mockResolvedValueOnce({
      id: 'program-1',
      productName: 'Affiliate Program',
      programName: 'Refferq Affiliate Program',
      websiteUrl: 'https://app.refferq.com',
      currency: 'USD',
      portalSubdomain: 'app',
      minimumPayoutThreshold: 100,
      minPayoutCents: 10000,
      payoutTerm: 'NET-15',
      commissionHoldDays: 30,
      payoutFrequency: 'MONTHLY',
      autoApprovePayouts: false,
      payoutMethods: ['PAYPAL'],
    });
    prisma.commissionRule.findMany.mockResolvedValueOnce([
      {
        id: 'rule-1',
        name: 'Default',
        type: 'PERCENTAGE',
        value: 10,
        conditions: {},
        isDefault: true,
        isActive: true,
        createdAt: date(),
      },
    ]);

    const response = await adminSettingsGET(
      request('/api/admin/settings', {
        method: 'GET',
        headers: { 'x-user-id': 'u-admin' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      settings: {
        id: 'program-1',
        minPayoutCents: 10000,
        payoutMethods: ['PAYPAL'],
      },
    });
    expect(body.settings.commissionRules).toHaveLength(1);
  });

  it('PUT /api/admin/settings: no-op patch returns current settings', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-admin', role: 'ADMIN', status: 'ACTIVE' });
    prisma.programSettings.findFirst.mockResolvedValueOnce({ id: 'program-1' });

    const response = await adminSettingsPUT(
      request('/api/admin/settings', {
        method: 'PUT',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({}),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      settings: {
        id: 'program-1',
        minPayoutCents: 10000,
      },
      message: 'No changes to update',
    });
  });
});
