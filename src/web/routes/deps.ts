import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../../app/context.js';
import { ValidationError } from '../../core/errors.js';
import type { AuthService } from '../auth.js';
import type { DtoMapper } from '../dto.js';
import { HttpError, unauthorized } from '../httpErrors.js';
import type { MemberCache } from '../memberCache.js';
import { guildParams, parseInput } from '../schemas.js';
import type { SseHub } from '../sse.js';
import type { AuthState } from '../types.js';

/** Everything the API routes need, built once per server. */
export interface ApiDeps {
  ctx: AppContext;
  auth: AuthService;
  dto: DtoMapper;
  members: MemberCache;
  sse: SseHub;
  now: () => number;
}

export function requireAuth(request: FastifyRequest): AuthState {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

/** Guild id of a guild-scoped route (access was already checked by the guild hook). */
export function guildIdOf(request: FastifyRequest): string {
  return parseInput(guildParams, request.params).guildId;
}

/** Runs a side effect that must never fail the request (logs instead). */
export function bestEffort(request: FastifyRequest, what: string, fn: () => unknown): void {
  try {
    const result = fn();
    if (result instanceof Promise) result.catch((err: unknown) => request.log.warn({ err }, `${what} failed`));
  } catch (err) {
    request.log.warn({ err }, `${what} failed`);
  }
}

/**
 * Wraps a Discord action: user-facing errors pass through, anything else becomes a 502 with an
 * actionable Arabic hint instead of a generic 500.
 */
export async function discordAction<T>(request: FastifyRequest, what: string, hint: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ValidationError || err instanceof HttpError) throw err;
    request.log.warn({ err }, `${what} failed`);
    throw new HttpError(502, 'discord_error', hint);
  }
}
