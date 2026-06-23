import { vi } from 'vitest';

export const checkRateLimit = vi.fn(async () => ({
  allowed: true,
  limit: 5,
  remaining: 4,
  resetAt: new Date(Date.now() + 60_000),
}));
