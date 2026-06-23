const MIN_JWT_SECRET_LENGTH = 32;

const ENV_SECRET = process.env.JWT_SECRET;

if (!ENV_SECRET || ENV_SECRET.length < MIN_JWT_SECRET_LENGTH) {
  throw new Error(
    `JWT_SECRET must be defined and at least ${MIN_JWT_SECRET_LENGTH} characters long.`,
  );
}

const JWT_COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60;
const JWT_EXPIRATION = '24h';

export function getJwtSecret(): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(ENV_SECRET);
}

export function getJwtExpiration(): string {
  return JWT_EXPIRATION;
}

export function getJwtCookieMaxAgeSeconds(): number {
  return JWT_COOKIE_MAX_AGE_SECONDS;
}

export function isAuthBearerToken(value: string | null): value is string {
  if (!value) return false;
  return value.startsWith('Bearer ');
}
