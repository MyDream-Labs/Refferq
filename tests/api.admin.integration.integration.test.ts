import { NextRequest } from 'next/server';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { prisma } from './mocks/prisma.mock';
import { resetPrismaMock } from './utils/test-prisma-fixture';

vi.mock('@/lib/prisma', () => import('./mocks/prisma.mock'));

import { GET as adminIntegrationGET, PUT as adminIntegrationPUT } from '@/app/api/admin/integration/route';
import { POST as generateKeyPOST } from '@/app/api/admin/integration/generate-key/route';

const request = (path: string, init: Omit<RequestInit, 'signal'> = {}) =>
  new NextRequest(`http://localhost:3000${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string>),
    },
    ...init,
  });

describe('API: admin integration settings', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
  });

  it('GET /api/admin/integration: non-admin gets unauthorized', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-aff', role: 'AFFILIATE', status: 'ACTIVE', email: 'aff@example.test' } as never);

    const response = await adminIntegrationGET(
      request('/api/admin/integration', {
        headers: { 'x-user-id': 'u-aff' },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'Access denied. Admin role required.',
    });
  });

  it('GET /api/admin/integration: returns null when integration not configured', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-admin',
      role: 'ADMIN',
      status: 'ACTIVE',
      email: 'admin@example.test',
    } as never);
    prisma.integrationSettings.findUnique.mockResolvedValueOnce(null);

    const response = await adminIntegrationGET(
      request('/api/admin/integration', {
        headers: { 'x-user-id': 'u-admin' },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      integration: null,
      message: 'No integration configured. Generate API keys to get started.',
    });
  });

  it('PUT /api/admin/integration: updates and returns integration settings', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-admin',
      role: 'ADMIN',
      status: 'ACTIVE',
      email: 'admin@example.test',
    } as never);
    prisma.integrationSettings.update.mockResolvedValueOnce({
      id: 'integration-id',
      webhookUrl: 'https://api.example.com/webhook',
      isActive: true,
      trackingScript: 'window.rfq = true;',
      config: { allowlist: ['a.com'] },
    } as never);

    const response = await adminIntegrationPUT(
      request('/api/admin/integration', {
        method: 'PUT',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({
          webhookUrl: 'https://api.example.com/webhook',
          isActive: true,
          trackingScript: 'window.rfq = true;',
          config: { allowlist: ['a.com'] },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      message: 'Integration settings updated successfully',
      integration: {
        id: 'integration-id',
        webhookUrl: 'https://api.example.com/webhook',
        config: { allowlist: ['a.com'] },
      },
    });
  });

  it('POST /api/admin/integration/generate-key: creates keys when settings missing', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-admin',
      role: 'ADMIN',
      status: 'ACTIVE',
      email: 'admin@example.test',
    } as never);
    prisma.integrationSettings.findUnique.mockResolvedValueOnce(null);
    prisma.integrationSettings.create.mockResolvedValueOnce({
      id: 'integration-id',
      userId: 'u-admin',
      provider: 'refferq',
      isActive: true,
      publicKey: 'pk_existing',
      apiKey: 'sk_existing',
      config: {},
    } as never);

    const response = await generateKeyPOST(
      request('/api/admin/integration/generate-key', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toMatchObject({
      success: true,
      message: 'API keys generated successfully',
      keys: {
        publicKey: expect.stringContaining('pk_'),
        apiKey: expect.stringContaining('sk_'),
      },
      integration: {
        isActive: true,
      },
    });
  });

  it('POST /api/admin/integration/generate-key: rotates keys for existing integration', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-admin',
      role: 'ADMIN',
      status: 'ACTIVE',
      email: 'admin@example.test',
    } as never);
    prisma.integrationSettings.findUnique.mockResolvedValueOnce({
      id: 'integration-id',
      userId: 'u-admin',
      publicKey: 'pk_old',
      apiKey: 'sk_old',
      isActive: true,
      provider: 'refferq',
      config: {},
      webhookUrl: null,
      trackingScript: null,
      createdAt: new Date().toISOString(),
    } as never);
    prisma.integrationSettings.update.mockResolvedValueOnce({
      id: 'integration-id',
      userId: 'u-admin',
      publicKey: 'pk_new',
      apiKey: 'sk_new',
      isActive: true,
      provider: 'refferq',
      config: {},
    } as never);

    const response = await generateKeyPOST(
      request('/api/admin/integration/generate-key', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toMatchObject({
      success: true,
      integration: {
        id: 'integration-id',
        userId: 'u-admin',
      },
      keys: {
        publicKey: expect.stringContaining('pk_'),
        apiKey: expect.stringContaining('sk_'),
      },
    });
    expect(body.keys.publicKey).not.toBe('pk_old');
    expect(body.keys.apiKey).not.toBe('sk_old');
    expect(prisma.integrationSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u-admin' },
      }),
    );
  });

  it('POST /api/admin/integration/generate-key: requires admin user', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-aff',
      role: 'AFFILIATE',
      status: 'ACTIVE',
      email: 'aff@example.test',
    } as never);

    const response = await generateKeyPOST(
      request('/api/admin/integration/generate-key', {
        method: 'POST',
        headers: { 'x-user-id': 'u-aff' },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'Access denied. Admin role required.',
    });
  });
});
