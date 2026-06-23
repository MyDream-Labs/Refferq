import { NextRequest } from 'next/server';
import { describe, beforeEach, expect, it } from 'vitest';
import { prisma } from './mocks/prisma.mock';
import { resetPrismaMock } from './utils/test-prisma-fixture';

import {
  GET as settingsIntegrationGET,
  POST as settingsIntegrationPOST,
  DELETE as settingsIntegrationDELETE,
} from '@/app/api/admin/settings/integration/route';
import {
  GET as settingsProfileGET,
  PUT as settingsProfilePUT,
} from '@/app/api/admin/settings/profile/route';

vi.mock('@/lib/prisma', () => import('./mocks/prisma.mock'));

const request = (path: string, init: Omit<RequestInit, 'signal'> = {}) =>
  new NextRequest(`http://localhost:3000${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string>),
    },
    ...init,
  });

describe('API: admin settings integration', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
  });

  it('GET /api/admin/settings/integration: non-admin is unauthorized', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);

    const response = await settingsIntegrationGET(
      request('/api/admin/settings/integration', {
        headers: {
          'x-user-id': 'u-aff',
        },
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'Unauthorized',
    });
  });

  it('GET /api/admin/settings/integration: returns integration settings for admin', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-admin',
      role: 'ADMIN',
      status: 'ACTIVE',
    } as never);
    prisma.integrationSettings.findUnique.mockResolvedValueOnce({
      id: 'integration-id',
      userId: 'u-admin',
      provider: 'refferq',
      apiKey: 'api-key',
    } as never);

    const response = await settingsIntegrationGET(
      request('/api/admin/settings/integration', {
        headers: { 'x-user-id': 'u-admin' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      integration: {
        id: 'integration-id',
        provider: 'refferq',
      },
    });
  });

  it('POST /api/admin/settings/integration: validates provider', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-admin',
      role: 'ADMIN',
      status: 'ACTIVE',
    } as never);

    const response = await settingsIntegrationPOST(
      request('/api/admin/settings/integration', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({
          apiKey: 'api-key',
          publicKey: 'pk',
        }),
      }),
    );

    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: 'Provider is required',
    });
  });

  it('POST /api/admin/settings/integration: creates integration settings if missing', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-admin',
      role: 'ADMIN',
      status: 'ACTIVE',
    } as never);
    prisma.integrationSettings.findUnique.mockResolvedValueOnce(null);
    prisma.integrationSettings.create.mockResolvedValueOnce({
      id: 'integration-id',
      userId: 'u-admin',
      provider: 'refferq',
      apiKey: 'api-key',
      publicKey: 'pk',
      webhookUrl: 'https://hooks.example.test',
      isActive: true,
      config: { allowlist: ['a.com'] },
    } as never);

    const response = await settingsIntegrationPOST(
      request('/api/admin/settings/integration', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({
          provider: 'refferq',
          apiKey: 'api-key',
          publicKey: 'pk',
          webhookUrl: 'https://hooks.example.test',
          config: { allowlist: ['a.com'] },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      integration: {
        id: 'integration-id',
        userId: 'u-admin',
        provider: 'refferq',
        webhookUrl: 'https://hooks.example.test',
        config: { allowlist: ['a.com'] },
      },
      message: 'Integration settings saved successfully',
    });
    expect(prisma.integrationSettings.create).toHaveBeenCalledTimes(1);
  });

  it('POST /api/admin/settings/integration: updates existing settings', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-admin',
      role: 'ADMIN',
      status: 'ACTIVE',
    } as never);
    prisma.integrationSettings.findUnique.mockResolvedValueOnce({
      id: 'integration-id',
      userId: 'u-admin',
      provider: 'refferq',
      apiKey: 'old',
      publicKey: 'oldpk',
      isActive: false,
    } as never);
    prisma.integrationSettings.update.mockResolvedValueOnce({
      id: 'integration-id',
      userId: 'u-admin',
      provider: 'refferq',
      apiKey: 'api-key',
      publicKey: 'pk',
      webhookUrl: 'https://hooks.example.test',
      isActive: false,
    } as never);

    const response = await settingsIntegrationPOST(
      request('/api/admin/settings/integration', {
        method: 'POST',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({
          provider: 'refferq',
          apiKey: 'api-key',
          publicKey: 'pk',
          webhookUrl: 'https://hooks.example.test',
          isActive: false,
        }),
      }),
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      integration: {
        id: 'integration-id',
        userId: 'u-admin',
        isActive: false,
      },
      message: 'Integration settings saved successfully',
    });
  });

  it('DELETE /api/admin/settings/integration: returns 404 when no integration', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-admin',
      role: 'ADMIN',
      status: 'ACTIVE',
    } as never);
    prisma.integrationSettings.findUnique.mockResolvedValueOnce(null);

    const response = await settingsIntegrationDELETE(
      request('/api/admin/settings/integration', {
        method: 'DELETE',
        headers: { 'x-user-id': 'u-admin' },
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'Integration settings not found',
    });
  });

  it('DELETE /api/admin/settings/integration: deletes existing integration', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-admin',
      role: 'ADMIN',
      status: 'ACTIVE',
    } as never);
    prisma.integrationSettings.findUnique.mockResolvedValueOnce({
      id: 'integration-id',
      userId: 'u-admin',
      provider: 'refferq',
    } as never);
    prisma.integrationSettings.delete.mockResolvedValueOnce({
      id: 'integration-id',
    } as never);

    const response = await settingsIntegrationDELETE(
      request('/api/admin/settings/integration', {
        method: 'DELETE',
        headers: { 'x-user-id': 'u-admin' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      message: 'Integration settings deleted successfully',
    });
    expect(prisma.integrationSettings.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u-admin' },
      }),
    );
  });
});

describe('API: admin settings profile', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
  });

  it('GET /api/admin/settings/profile: unauthorized -> 401', async () => {
    const response = await settingsProfileGET(
      request('/api/admin/settings/profile', {
        headers: { 'x-user-id': 'u-aff' },
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'Unauthorized',
    });
  });

  it('GET /api/admin/settings/profile: returns admin profile', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-admin',
      role: 'ADMIN',
      status: 'ACTIVE',
      email: 'admin@example.test',
    } as never);
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-admin',
      name: 'Admin',
      email: 'admin@example.test',
      profilePicture: 'https://example.test/avatar.png',
      role: 'ADMIN',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    } as never);

    const response = await settingsProfileGET(
      request('/api/admin/settings/profile', {
        headers: { 'x-user-id': 'u-admin' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      profile: {
        id: 'u-admin',
        name: 'Admin',
        email: 'admin@example.test',
      },
    });
  });

  it('PUT /api/admin/settings/profile: requires name and email', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-admin',
      role: 'ADMIN',
      status: 'ACTIVE',
      email: 'admin@example.test',
    } as never);

    const response = await settingsProfilePUT(
      request('/api/admin/settings/profile', {
        method: 'PUT',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({ name: 'Admin' }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'Name and email are required',
    });
  });

  it('PUT /api/admin/settings/profile: blocks email conflict', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-admin',
      role: 'ADMIN',
      status: 'ACTIVE',
      email: 'admin@example.test',
    } as never);
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'other-user',
      email: 'dup@example.test',
    } as never);

    const response = await settingsProfilePUT(
      request('/api/admin/settings/profile', {
        method: 'PUT',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({
          name: 'Admin',
          email: 'dup@example.test',
          profilePicture: 'https://example.test/new.png',
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'Email is already in use',
    });
  });

  it('PUT /api/admin/settings/profile: updates profile successfully', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-admin',
      role: 'ADMIN',
      status: 'ACTIVE',
      email: 'admin@example.test',
    } as never);
    prisma.user.update.mockResolvedValueOnce({
      id: 'u-admin',
      name: 'New Admin',
      email: 'new-admin@example.test',
      profilePicture: 'https://example.test/new.png',
      role: 'ADMIN',
      updatedAt: new Date('2026-01-03T00:00:00.000Z'),
    } as never);

    const response = await settingsProfilePUT(
      request('/api/admin/settings/profile', {
        method: 'PUT',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({
          name: 'New Admin',
          email: 'new-admin@example.test',
          profilePicture: 'https://example.test/new.png',
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      message: 'Profile updated successfully',
      profile: {
        id: 'u-admin',
        email: 'new-admin@example.test',
      },
    });
  });
});
