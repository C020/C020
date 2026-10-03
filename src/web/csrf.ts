import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Header the dashboard sends on mutating requests (value from GET /api/me). */
export const CSRF_HEADER = 'x-csrf-token';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isMutating(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/**
 * Stateless CSRF token bound to the web session: HMAC(SESSION_SECRET, sessionId).
 * The session id is sha256(cookie token), so the token never reveals the cookie itself.
 */
export function csrfTokenFor(secret: string, sessionId: string): string {
  return createHmac('sha256', secret).update(`csrf:${sessionId}`).digest('base64url');
}

export function verifyCsrfToken(secret: string, sessionId: string, provided: unknown): boolean {
  if (typeof provided !== 'string' || provided.length === 0 || provided.length > 256) return false;
  return safeEqual(csrfTokenFor(secret, sessionId), provided);
}

/** Constant-time string comparison (length mismatch returns false without leaking timing on content). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Random URL-safe token (session cookies, OAuth state). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** DB id of a web session: sha256(cookie token), so a leaked DB does not leak usable cookies. */
export function sessionIdFromToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
