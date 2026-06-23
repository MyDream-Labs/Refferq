import { NextRequest } from 'next/server';

type UnknownRecord = Record<string, unknown>;

const LEGACY_AUTH_FIELDS = [
  'password',
  'pass',
  'passcode',
  'oldpassword',
  'newpassword',
  'confirm',
  'passwordhash',
  'hash',
  'token',
  'otp',
  'pin',
  'totp',
  'recovery_code',
  'recoverycode',
] as const;

function normalizeLegacyKey(key: string): string {
  return key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
}

export function isLegacyAuthPayload(payload: unknown): boolean {
  if (!isRecord(payload)) return false;

  return Object.keys(payload).some((rawKey) => {
    const key = normalizeLegacyKey(rawKey);
    return LEGACY_AUTH_FIELDS.some((field) => key === field || key.includes(field));
  });
}

export function normalizeEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

export function extractRequestIp(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown'
  );
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
