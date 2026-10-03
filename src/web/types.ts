import type { Logger } from '../core/logger.js';
import type { WebSession } from '../db/models.js';
import type { FetchLike } from '../platforms/http.js';

/** Authenticated dashboard user attached to every /api request by the auth hook. */
export interface AuthState {
  session: WebSession;
  /** Listed in ADMIN_USER_IDS: may manage every guild the bot is in. */
  isAdmin: boolean;
  /** Audit actor, e.g. "user:123456789012345678". */
  actor: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthState | null;
  }
}

export interface WebServerOptions {
  /** fetch used for Discord OAuth2 calls (tests inject a mock). Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Directory with the built dashboard. Defaults to <cwd>/dist/public. */
  publicDir?: string;
  /** Clock used for session/refresh decisions (tests). */
  now?: () => number;
  logger?: Logger;
  /** SSE heartbeat interval (tests shorten it). */
  sseHeartbeatMs?: number;
}
