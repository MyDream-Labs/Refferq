import { NextRequest } from 'next/server';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { prisma } from './mocks/prisma.mock';
import { resetPrismaMock } from './utils/test-prisma-fixture';

vi.mock('@/lib/prisma', () => import('./mocks/prisma.mock'));

import { GET as adminProfileGET, PUT as adminProfilePUT } from '@/app/api/admin/profile/route';
import { POST as logoutPOST } from '@/app/api/auth/logout/route';

const request = (path: string, init: Omit<RequestInit, 'signal'> = {}) =>
  new NextRequest(`http://localhost:3000${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string>),
    },
    ...init,
  });

describe('API: admin profile', () => {
  beforeEach(() => {
    resetPrismaMock(prisma);
  });

  it('GET /api/admin/profile: non-admin is forbidden', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-aff',
      role: 'AFFILIATE',
      status: 'ACTIVE',
      email: 'aff@example.test',
    } as never);

    const response = await adminProfileGET(
      request('/api/admin/profile', {
        headers: { 'x-user-id': 'u-aff' },
      }),
    );

    expect(response.status).toBe(403);
  });

  it('GET /api/admin/profile: hides password field in payload', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-admin',
      role: 'ADMIN',
      status: 'ACTIVE',
      email: 'admin@example.test',
      name: 'Admin User',
      password: 'super-secret',
      profilePicture: 'https://example.com/avatar.png',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);

    const response = await adminProfileGET(
      request('/api/admin/profile', {
        headers: { 'x-user-id': 'u-admin' },
      }),
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.user.email).toBe('admin@example.test');
    expect(body.user).not.toHaveProperty('password');
  });

  it('PUT /api/admin/profile: requires name in update payload', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-admin',
      role: 'ADMIN',
      status: 'ACTIVE',
      email: 'admin@example.test',
      name: 'Admin User',
    } as never);

    const response = await adminProfilePUT(
      request('/api/admin/profile', {
        method: 'PUT',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({
          name: '   ',
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'Name is required',
    });
  });

  it('PUT /api/admin/profile: updates name and returns success', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-admin',
      role: 'ADMIN',
      status: 'ACTIVE',
      email: 'admin@example.test',
      name: 'Admin User',
      password: 'hash',
    } as never);
    prisma.user.update.mockResolvedValueOnce({
      id: 'u-admin',
      role: 'ADMIN',
      status: 'ACTIVE',
      email: 'admin@example.test',
      name: 'Updated Admin',
      profilePicture: 'https://example.com/avatar-new.png',
      password: 'hash',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);

    const response = await adminProfilePUT(
      request('/api/admin/profile', {
        method: 'PUT',
        headers: { 'x-user-id': 'u-admin' },
        body: JSON.stringify({
          name: 'Updated Admin',
          profilePicture: 'https://example.com/avatar-new.png',
        }),
      }),
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      message: 'Profile updated successfully',
      user: {
        id: 'u-admin',
        name: 'Updated Admin',
      },
    });
    expect(body.user).not.toHaveProperty('password');
  });
});

describe('API: auth logout', () => {
  it('POST /api/auth/logout: clears auth token cookie', async () => {
    const response = await logoutPOST(
      request('/api/auth/logout', {
        method: 'POST',
      }),
    );

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload).toMatchObject({
      success: true,
      message: 'Logged out successfully',
    });

    const setCookieHeader = response.headers.get('set-cookie');
    expect(setCookieHeader).toContain('auth-token=');
    expect(setCookieHeader).toContain('Expires=Thu, 01 Jan 1970');
  });
});
