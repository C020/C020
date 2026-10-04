/**
 * Dashboard authentication: Discord OAuth2 login, cookie sessions (DB id = sha256(cookie token)),
 * CSRF tokens, cached guild permissions and guild-level authorization.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../app/context.js';
import { childLogger, type Logger } from '../core/logger.js';
import type { WebSession, WebSessionGuild } from '../db/models.js';
import type { DiscordGuildInfo } from '../services/ports.js';
import { CSRF_HEADER, csrfTokenFor, randomToken, safeEqual, sessionIdFromToken, verifyCsrfToken } from './csrf.js';
import { DiscordOAuthError, displayNameOf, userAvatarUrl, type DiscordOAuthClient, type DiscordPartialGuild, type DiscordUser } from './discordOAuth.js';
import { discordUnavailable, forbidden, HttpError } from './httpErrors.js';
import { authErrorPage } from './pages.js';
import { canManageGuild } from './permissions.js';
import type { AuthState } from './types.js';

export const SESSION_COOKIE = 'sb_session';
export const STATE_COOKIE = 'sb_oauth_state';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_TTL_SEC = 10 * 60;
const DEFAULT_GUILD_REFRESH_MS = 10 * 60 * 1000;
/** Back-off after a failed guild refresh so a dashboard burst does not hammer Discord. */
const REFRESH_RETRY_MS = 60 * 1000;
/**
 * Cached guild permissions older than this are not trusted (Discord kept failing to refresh them):
 * a user who lost Manage Server must not keep access just because Discord was unreachable.
 */
const MAX_GUILD_STALENESS_MS = 60 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

export const AUTH_RATE_LIMIT = { max: 20, timeWindow: 60_000 };

export interface AuthServiceDeps {
  ctx: AppContext;
  oauth: DiscordOAuthClient;
  now?: () => number;
  guildRefreshMs?: number;
  logger?: Logger;
}

export class AuthService {
  readonly secureCookies: boolean;
  private readonly ctx: AppContext;
  private readonly oauth: DiscordOAuthClient;
  private readonly now: () => number;
  private readonly guildRefreshMs: number;
  private readonly log: Logger;
  private readonly secret: string;
  private readonly refreshes = new Map<string, Promise<WebSession | null>>();
  private readonly refreshBlockedUntil = new Map<string, number>();

  constructor(deps: AuthServiceDeps) {
    this.ctx = deps.ctx;
    this.oauth = deps.oauth;
    this.now = deps.now ?? Date.now;
    this.guildRefreshMs = deps.guildRefreshMs ?? DEFAULT_GUILD_REFRESH_MS;
    this.log = deps.logger ?? childLogger('web.auth');
    const secret = deps.ctx.config.SESSION_SECRET;
    if (!secret) throw new Error('SESSION_SECRET is required for dashboard authentication');
    this.secret = secret;
    this.secureCookies = deps.ctx.config.PUBLIC_URL?.startsWith('https://') ?? false;
  }

  get oauthClient(): DiscordOAuthClient {
    return this.oauth;
  }

  isAdmin(userId: string): boolean {
    return this.ctx.config.ADMIN_USER_IDS.includes(userId);
  }

  authState(session: WebSession): AuthState {
    return { session, isAdmin: this.isAdmin(session.userId), actor: `user:${session.userId}` };
  }

  csrfToken(sessionId: string): string {
    return csrfTokenFor(this.secret, sessionId);
  }

  verifyCsrf(sessionId: string, provided: unknown): boolean {
    return verifyCsrfToken(this.secret, sessionId, provided);
  }

  // ───────────────────────────── sessions ─────────────────────────────

  createSession(user: DiscordUser, guilds: DiscordPartialGuild[], accessToken: string): { token: string; session: WebSession } {
    const token = randomToken(32);
    const nowMs = this.now();
    const session = this.ctx.repos.webSessions.create({
      id: sessionIdFromToken(token),
      userId: user.id,
      username: displayNameOf(user),
      avatarUrl: userAvatarUrl(user),
      guilds: toSessionGuilds(guilds),
      guildsRefreshedAt: new Date(nowMs).toISOString(),
      accessToken,
      expiresAt: new Date(nowMs + SESSION_TTL_MS).toISOString(),
    });
    return { token, session };
  }

  /** Looks up the session for a cookie value; null when missing, malformed or expired. */
  resolveSession(token: string | undefined): WebSession | null {
    if (!token || !TOKEN_RE.test(token)) return null;
    const session = this.ctx.repos.webSessions.get(sessionIdFromToken(token));
    if (!session) return null;
    if (Date.parse(session.expiresAt) <= this.now()) {
      this.ctx.repos.webSessions.delete(session.id);
      return null;
    }
    return session;
  }

  destroySession(session: WebSession): void {
    this.ctx.repos.webSessions.delete(session.id);
    this.refreshes.delete(session.id);
    this.refreshBlockedUntil.delete(session.id);
    if (session.accessToken) void this.oauth.revoke(session.accessToken);
  }

  /**
   * Refreshes the cached guild list from Discord when it is older than the refresh interval.
   * Concurrent requests share one refresh. Transient failures keep the cached list (and back off) until it is too
   * old to trust; a rejected token ends the session (returns null → 401, the user logs in again).
   */
  async ensureFreshGuilds(session: WebSession): Promise<WebSession | null> {
    if (!session.accessToken) {
      // Nothing to refresh with: once the cached permissions are too old, the user has to log in again.
      if (this.guildsTrusted(session)) return session;
      this.endSession(session);
      return null;
    }
    const nowMs = this.now();
    const refreshedAt = Date.parse(session.guildsRefreshedAt);
    if (Number.isFinite(refreshedAt) && nowMs - refreshedAt < this.guildRefreshMs) return session;
    if ((this.refreshBlockedUntil.get(session.id) ?? 0) > nowMs) return session;

    let pending: Promise<WebSession | null> | undefined = this.refreshes.get(session.id);
    if (!pending) {
      pending = this.refreshGuilds(session).finally(() => this.refreshes.delete(session.id));
      this.refreshes.set(session.id, pending);
    }
    return pending;
  }

  private async refreshGuilds(session: WebSession): Promise<WebSession | null> {
    try {
      const guilds = toSessionGuilds(await this.oauth.fetchGuilds(session.accessToken!));
      this.ctx.repos.webSessions.updateGuilds(session.id, guilds);
      this.refreshBlockedUntil.delete(session.id);
      return { ...session, guilds, guildsRefreshedAt: new Date(this.now()).toISOString() };
    } catch (err) {
      if (err instanceof DiscordOAuthError && err.kind === 'unauthorized') {
        // Token revoked (e.g. the user deauthorized the app): the cached permissions can no longer be re-checked,
        // so fail closed instead of trusting them for the rest of the session.
        this.log.info({ userId: session.userId }, 'Discord rejected the dashboard access token; ending the session');
        this.endSession(session);
        return null;
      }
      const retryMs =
        err instanceof DiscordOAuthError && err.kind === 'rate_limited'
          ? Math.max(err.retryAfterMs ?? REFRESH_RETRY_MS, REFRESH_RETRY_MS)
          : REFRESH_RETRY_MS;
      this.refreshBlockedUntil.set(session.id, this.now() + retryMs);
      this.log.warn({ err, userId: session.userId }, 'Refreshing Discord guild list failed; using cached permissions for now');
      return session;
    }
  }

  /** Deletes a session that can no longer be trusted (no token revocation: Discord already rejected it). */
  private endSession(session: WebSession): void {
    this.ctx.repos.webSessions.delete(session.id);
    this.refreshBlockedUntil.delete(session.id);
  }

  // ───────────────────────────── authorization ─────────────────────────────

  /** False once the cached guild permissions are too old to rely on (see MAX_GUILD_STALENESS_MS). */
  guildsTrusted(session: WebSession): boolean {
    const refreshedAt = Date.parse(session.guildsRefreshedAt);
    return Number.isFinite(refreshedAt) && this.now() - refreshedAt <= MAX_GUILD_STALENESS_MS;
  }

  /** Guilds Discord says the user can manage; empty while the cached list is too old to trust. */
  private manageableGuilds(auth: AuthState): WebSessionGuild[] {
    return this.guildsTrusted(auth.session) ? auth.session.guilds.filter(canManageGuild) : [];
  }

  /** Guilds the user can manage AND the bot is in (admins: every bot guild), sorted by name. */
  accessibleGuilds(auth: AuthState): DiscordGuildInfo[] {
    const botGuilds = safeGuilds(this.ctx, this.log);
    const visible = auth.isAdmin
      ? botGuilds
      : (() => {
          const manageable = new Set(this.manageableGuilds(auth).map((g) => g.id));
          return botGuilds.filter((g) => manageable.has(g.id));
        })();
    return [...visible].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  }

  /** Permission check only (no bot-guild lookup): admin, or owner/Administrator/Manage Server per fresh-enough data. */
  canAccessGuild(auth: AuthState, guildId: string): boolean {
    return auth.isAdmin || this.manageableGuilds(auth).some((g) => g.id === guildId);
  }

  /** Throws 403 (or 503 while Discord is connecting / permissions cannot be re-checked) unless the user may manage the guild. */
  assertGuildAccess(auth: AuthState, guildId: string): DiscordGuildInfo {
    if (!this.canAccessGuild(auth, guildId)) {
      const cachedAllowed = auth.session.guilds.some((g) => g.id === guildId && canManageGuild(g));
      if (cachedAllowed && !this.guildsTrusted(auth.session)) throw permissionsUnverified();
      throw forbidden('ما عندك صلاحية على هذا السيرفر (لازم تكون صاحب السيرفر أو عندك Manage Server)');
    }
    const guild = safeGuild(this.ctx, guildId, this.log);
    if (!guild) {
      if (!this.ctx.discord.isReady()) throw discordUnavailable();
      throw forbidden('البوت مو موجود في هذا السيرفر، ادعه أول');
    }
    return guild;
  }

  /**
   * Account-level features (platform lookups, system status) are for admins and users who manage at least one
   * guild the bot is in; any other Discord account that completes the login gets 403.
   */
  assertAnyGuildAccess(auth: AuthState): void {
    if (auth.isAdmin || this.accessibleGuilds(auth).length > 0) return;
    if (auth.session.guilds.some(canManageGuild)) {
      if (!this.guildsTrusted(auth.session)) throw permissionsUnverified();
      if (!safeReady(this.ctx)) throw discordUnavailable();
    }
    throw forbidden('هذي الميزة لمشرفي السيرفرات اللي فيها البوت (صاحب السيرفر أو عنده Manage Server)');
  }

  cookieBase(): { httpOnly: true; secure: boolean; sameSite: 'lax' } {
    return { httpOnly: true, secure: this.secureCookies, sameSite: 'lax' };
  }

  setSessionCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(SESSION_COOKIE, token, { ...this.cookieBase(), path: '/', maxAge: Math.floor(SESSION_TTL_MS / 1000) });
  }

  clearSessionCookie(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, { ...this.cookieBase(), path: '/' });
  }
}

/** Keeps only guilds the user can manage: that is all authorization needs, and it stores less personal data. */
export function toSessionGuilds(guilds: DiscordPartialGuild[]): WebSessionGuild[] {
  return guilds
    .map((g) => ({ id: g.id, name: g.name, icon: g.icon ?? null, owner: g.owner === true, permissions: String(g.permissions ?? '0') }))
    .filter(canManageGuild);
}

const permissionsUnverified = (): HttpError =>
  new HttpError(
    503,
    'permissions_unverified',
    'ما قدرنا نتأكد من صلاحياتك في ديسكورد من فترة، جرّب بعد شوي (وإذا تكرر سجّل خروج وادخل من جديد)',
    undefined,
    { 'retry-after': '60' },
  );

function safeReady(ctx: AppContext): boolean {
  try {
    return ctx.discord.isReady();
  } catch {
    return false;
  }
}

function safeGuilds(ctx: AppContext, log: Logger): DiscordGuildInfo[] {
  try {
    return ctx.discord.guilds();
  } catch (err) {
    log.warn({ err }, 'Listing bot guilds failed');
    return [];
  }
}

function safeGuild(ctx: AppContext, guildId: string, log: Logger): DiscordGuildInfo | null {
  try {
    return ctx.discord.guild(guildId);
  } catch (err) {
    log.warn({ err, guildId }, 'Guild lookup failed');
    return null;
  }
}

/** Only same-site relative paths are allowed as post-login destinations (no open redirects). */
export function sanitizeNext(value: unknown): string {
  if (typeof value !== 'string' || value.length > 300) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (/[\u0000-\u001f\\]/.test(value)) return '/';
  if (value.startsWith('/auth/') || value.startsWith('/api/') || value.startsWith('/webhooks/')) return '/';
  return value;
}

interface SavedState {
  state: string;
  next: string;
  /** The consent screen was already forced once (prevents redirect loops). */
  consent: boolean;
}

function encodeState(saved: SavedState): string {
  return `${saved.state}.${Buffer.from(saved.next).toString('base64url')}.${saved.consent ? 'c' : 'n'}`;
}

function decodeState(value: string): SavedState | null {
  const [state, next, flag] = value.split('.');
  if (!state || next === undefined) return null;
  return { state, next: sanitizeNext(Buffer.from(next, 'base64url').toString('utf8')), consent: flag === 'c' };
}

/** Errors Discord may return for prompt=none when the user still has to approve the app. */
const CONSENT_ERRORS = new Set(['consent_required', 'interaction_required', 'login_required']);

function oauthFailureMessage(err: unknown): { status: number; message: string } {
  if (err instanceof DiscordOAuthError) {
    if (err.kind === 'invalid_grant') return { status: 400, message: 'رابط تسجيل الدخول انتهت صلاحيته أو استُخدم قبل، جرّب مرة ثانية.' };
    if (err.kind === 'rate_limited') return { status: 429, message: 'ديسكورد طالب نهدّي شوي، جرّب بعد دقيقة.' };
    if (err.kind === 'unauthorized') return { status: 401, message: 'ديسكورد رفض الدخول. تأكد إن DISCORD_CLIENT_SECRET صحيح.' };
  }
  return { status: 502, message: 'ديسكورد ما رد علينا الحين، جرّب بعد شوي.' };
}

function sendAuthError(reply: FastifyReply, status: number, message: string): FastifyReply {
  return reply.code(status).header('cache-control', 'no-store').type('text/html; charset=utf-8').send(authErrorPage(message));
}

/** Registers /auth/login, /auth/callback and /auth/logout. */
export function registerAuthRoutes(app: FastifyInstance, auth: AuthService): void {
  const log = childLogger('web.auth');
  const rateLimit = { config: { rateLimit: AUTH_RATE_LIMIT } };
  const stateCookieOptions = { ...auth.cookieBase(), path: '/auth' };

  const startAuthorization = (reply: FastifyReply, next: string, consent: boolean): FastifyReply => {
    const state = randomToken(24);
    reply.setCookie(STATE_COOKIE, encodeState({ state, next, consent }), { ...stateCookieOptions, signed: true, maxAge: STATE_TTL_SEC });
    return reply.header('cache-control', 'no-store').redirect(auth.oauthClient.authorizeUrl(state, consent ? 'consent' : 'none'), 302);
  };

  app.get('/auth/login', rateLimit, async (request: FastifyRequest<{ Querystring: { next?: string } }>, reply) =>
    startAuthorization(reply, sanitizeNext(request.query.next), false),
  );

  app.get(
    '/auth/callback',
    rateLimit,
    async (request: FastifyRequest<{ Querystring: Record<string, string | string[] | undefined> }>, reply) => {
      const query = request.query;
      const one = (key: string): string | undefined => {
        const v = query[key];
        return typeof v === 'string' ? v : undefined;
      };
      const rawState = request.cookies[STATE_COOKIE];
      reply.clearCookie(STATE_COOKIE, stateCookieOptions);
      const unsigned = rawState ? request.unsignCookie(rawState) : null;
      const saved = unsigned?.valid && unsigned.value ? decodeState(unsigned.value) : null;
      const returnedState = one('state');
      const stateOk = !!saved && !!returnedState && safeEqual(saved.state, returnedState);

      const error = one('error');
      if (error) {
        // prompt=none could not complete silently: ask again with the consent screen (once).
        if (CONSENT_ERRORS.has(error) && stateOk && !saved.consent) return startAuthorization(reply, saved.next, true);
        const message = error === 'access_denied' ? 'لغيت تسجيل الدخول من ديسكورد.' : 'ديسكورد رجّع خطأ أثناء تسجيل الدخول.';
        return sendAuthError(reply, 400, message);
      }

      if (!stateOk) {
        return sendAuthError(reply, 400, 'انتهت صلاحية محاولة الدخول (أو فتحتها من متصفح ثاني)، جرّب مرة ثانية.');
      }
      const code = one('code');
      if (!code || code.length > 512) return sendAuthError(reply, 400, 'رابط تسجيل الدخول ناقص، جرّب مرة ثانية.');

      try {
        const tokens = await auth.oauthClient.exchangeCode(code);
        const [user, guilds] = await Promise.all([
          auth.oauthClient.fetchUser(tokens.access_token),
          auth.oauthClient.fetchGuilds(tokens.access_token),
        ]);
        // Re-login replaces the browser's previous session instead of leaving it orphaned.
        const previous = auth.resolveSession(request.cookies[SESSION_COOKIE]);
        if (previous) auth.destroySession(previous);
        const { token } = auth.createSession(user, guilds, tokens.access_token);
        auth.setSessionCookie(reply, token);
        log.info({ userId: user.id, admin: auth.isAdmin(user.id) }, 'Dashboard login');
        return reply.header('cache-control', 'no-store').redirect(saved.next, 302);
      } catch (err) {
        const failure = oauthFailureMessage(err);
        log.warn({ err }, 'Discord OAuth callback failed');
        return sendAuthError(reply, failure.status, failure.message);
      }
    },
  );

  app.post('/auth/logout', rateLimit, async (request, reply) => {
    const session = auth.resolveSession(request.cookies[SESSION_COOKIE]);
    if (session) {
      if (!auth.verifyCsrf(session.id, request.headers[CSRF_HEADER])) {
        throw new HttpError(403, 'csrf', 'انتهت صلاحية الصفحة، حدّثها وجرّب مرة ثانية');
      }
      auth.destroySession(session);
    }
    auth.clearSessionCookie(reply);
    return reply.header('cache-control', 'no-store').send({ ok: true });
  });
}
