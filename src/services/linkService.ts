/**
 * #11 — optional official account linking (Twitch, TikTok).
 *
 * Flow: /link (Discord) → startUrl() (HMAC-signed, 15 min) → GET /link/start → authorizeRedirect() → provider consent
 * → GET /link/callback/:platform → complete(). Twitch is a scope-less identity proof (token discarded). TikTok keeps
 * encrypted tokens (AES-256-GCM) so the TikTok provider can list videos through the official Display API.
 *
 * Tokens are never logged. Every public method is defensive: network/DB failures become LinkFlowError (flow) or null
 * (token source) instead of crashing the process.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { LinkServiceApi, StreamerServiceApi } from '../app/context.js';
import type { AppConfig } from '../config.js';
import { ValidationError, errorMessage } from '../core/errors.js';
import { childLogger } from '../core/logger.js';
import type { AccountLink, Language, LinkPlatform } from '../db/models.js';
import type { Repositories } from '../db/repositories.js';
import type { AuditService } from './audit.js';

const log = childLogger('links');

export const LINK_PLATFORMS: readonly LinkPlatform[] = ['twitch', 'tiktok'];

const MINUTE = 60_000;
const START_TTL_MS = 15 * MINUTE;
const STATE_TTL_MS = 15 * MINUTE;
const NONCE_TTL_MS = 20 * MINUTE;
const REFRESH_MARGIN_MS = 5 * MINUTE;
const HTTP_TIMEOUT_MS = 15_000;
const NONCE_KV_KEY = 'links:usedNonces';
const MAX_STORED_NONCES = 5_000;

export const TWITCH_AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';
export const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
export const TWITCH_REVOKE_URL = 'https://id.twitch.tv/oauth2/revoke';
export const TWITCH_USERS_URL = 'https://api.twitch.tv/helix/users';
export const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
export const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
export const TIKTOK_REVOKE_URL = 'https://open.tiktokapis.com/v2/oauth/revoke/';
export const TIKTOK_USER_INFO_URL = 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,display_name,username,avatar_url';
export const TIKTOK_SCOPES = ['user.info.basic', 'user.info.profile', 'video.list'];

export type LinkErrorCode =
  | 'invalid'
  | 'expired'
  | 'unavailable'
  | 'disabled'
  | 'denied'
  | 'replay'
  | 'exchange_failed'
  | 'already_linked';

/** Flow failure shown on the result page (the route maps `code` to bilingual text). */
export class LinkFlowError extends Error {
  constructor(
    readonly code: LinkErrorCode,
    message: string,
    /** Guild language when the token/state could be read. */
    readonly language: Language | null = null,
  ) {
    super(message);
    this.name = 'LinkFlowError';
  }
}

/** Signed payload of start URLs and OAuth `state`. */
interface FlowPayload {
  g: string;
  u: string;
  p: LinkPlatform;
  n: string;
  exp: number;
  /** 's' = start token, 'o' = OAuth state. */
  k: 's' | 'o';
}

/** What happened to the member's streamer accounts after linking. */
export type LinkAccountOutcome = 'added' | 'verified' | 'mismatch' | 'not_streamer' | 'no_handle' | 'add_failed';

export interface LinkCompletion {
  guildId: string;
  userId: string;
  platform: LinkPlatform;
  language: Language;
  login: string | null;
  displayName: string | null;
  account: LinkAccountOutcome;
}

export interface LinkServiceOptions {
  config: AppConfig;
  repos: Repositories;
  audit: AuditService;
  streamers: StreamerServiceApi;
  fetch?: typeof fetch;
  now?: () => number;
}

interface TikTokTokenResponse {
  access_token?: string;
  expires_in?: number;
  open_id?: string;
  refresh_token?: string;
  refresh_expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

const PLATFORM_LABEL: Record<LinkPlatform, string> = { twitch: 'Twitch', tiktok: 'TikTok' };

const b64url = (buf: Buffer): string => buf.toString('base64url');
const isLinkPlatform = (v: unknown): v is LinkPlatform => v === 'twitch' || v === 'tiktok';
const DISCORD_ID_RE = /^\d{5,25}$/;

export class LinkService implements LinkServiceApi {
  private readonly config: AppConfig;
  private readonly repos: Repositories;
  private readonly audit: AuditService;
  private readonly streamers: StreamerServiceApi;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly signKey: Buffer | null;
  private readonly encKey: Buffer | null;
  private readonly refreshing = new Map<number, Promise<AccountLink | null>>();

  constructor(options: LinkServiceOptions) {
    this.config = options.config;
    this.repos = options.repos;
    this.audit = options.audit;
    this.streamers = options.streamers;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    const secret = this.config.SESSION_SECRET;
    if (secret) {
      const ikm = Buffer.from(`${secret}:links`, 'utf8');
      this.encKey = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'stream-bot/links/token-encryption', 32));
      this.signKey = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'stream-bot/links/flow-signing', 32));
    } else {
      this.encKey = null;
      this.signKey = null;
    }
  }

  // ───────────── availability ─────────────

  isAvailable(platform: LinkPlatform): boolean {
    if (!this.config.PUBLIC_URL || !this.signKey) return false;
    if (platform === 'twitch') return !!this.config.TWITCH_CLIENT_ID && !!this.config.TWITCH_CLIENT_SECRET;
    if (platform === 'tiktok') return !!this.config.TIKTOK_CLIENT_KEY && !!this.config.TIKTOK_CLIENT_SECRET;
    return false;
  }

  redirectUri(platform: LinkPlatform): string {
    return `${this.config.PUBLIC_URL ?? ''}/link/callback/${platform}`;
  }

  /** Guild language (Arabic fallback when settings can't be read). */
  language(guildId: string | null | undefined): Language {
    if (!guildId) return 'ar';
    try {
      return this.repos.settings.get(guildId).features.language === 'en' ? 'en' : 'ar';
    } catch {
      return 'ar';
    }
  }

  private featureEnabled(guildId: string): boolean {
    try {
      return this.repos.settings.get(guildId).features.linking.enabled === true;
    } catch {
      return false;
    }
  }

  // ───────────── start ─────────────

  startUrl(guildId: string, userId: string, platform: LinkPlatform): string {
    if (!this.isAvailable(platform)) {
      throw new ValidationError(
        this.language(guildId) === 'en'
          ? `Linking ${PLATFORM_LABEL[platform]} accounts is not configured on this bot`
          : `ربط حسابات ${PLATFORM_LABEL[platform]} غير مُعد في هذا البوت`,
        'platform',
      );
    }
    const token = this.sign({ g: guildId, u: userId, p: platform, n: b64url(randomBytes(16)), exp: this.now() + START_TTL_MS, k: 's' });
    return `${this.config.PUBLIC_URL}/link/start?t=${encodeURIComponent(token)}`;
  }

  /**
   * Verifies a start token and returns the provider authorize URL plus the nonce the route binds to a cookie.
   * Throws LinkFlowError.
   */
  authorizeRedirect(startToken: string | undefined): { url: string; nonce: string; platform: LinkPlatform; language: Language } {
    const payload = this.verify(startToken, 's');
    const language = this.language(payload.g);
    this.assertUsable(payload, language);
    const state = this.sign({ ...payload, n: b64url(randomBytes(16)), exp: this.now() + STATE_TTL_MS, k: 'o' });
    const nonce = this.verify(state, 'o').n;
    const redirect = this.redirectUri(payload.p);
    let url: URL;
    if (payload.p === 'twitch') {
      url = new URL(TWITCH_AUTHORIZE_URL);
      url.searchParams.set('client_id', this.config.TWITCH_CLIENT_ID!);
      url.searchParams.set('redirect_uri', redirect);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', '');
      url.searchParams.set('force_verify', 'true');
      url.searchParams.set('state', state);
    } else {
      url = new URL(TIKTOK_AUTHORIZE_URL);
      url.searchParams.set('client_key', this.config.TIKTOK_CLIENT_KEY!);
      url.searchParams.set('scope', TIKTOK_SCOPES.join(','));
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', redirect);
      url.searchParams.set('state', state);
    }
    return { url: url.toString(), nonce, platform: payload.p, language };
  }

  /** Language encoded in a (possibly invalid/expired) state — for rendering error pages. Never throws. */
  languageOfState(state: string | undefined): Language | null {
    const payload = this.decode(state);
    return payload ? this.language(payload.g) : null;
  }

  // ───────────── callback ─────────────

  /**
   * Completes the OAuth callback. `cookieNonce` is the nonce the start route stored in the browser; it must match the
   * state (binds the callback to the browser that started the flow). Throws LinkFlowError.
   */
  async complete(
    platform: string,
    query: { code?: string; state?: string; error?: string },
    cookieNonce: string | null | undefined,
  ): Promise<LinkCompletion> {
    if (!isLinkPlatform(platform)) throw new LinkFlowError('invalid', 'unknown platform');
    const payload = this.verify(query.state, 'o');
    const language = this.language(payload.g);
    if (payload.p !== platform) throw new LinkFlowError('invalid', 'platform mismatch', language);
    if (!cookieNonce || !safeEqual(cookieNonce, payload.n)) throw new LinkFlowError('invalid', 'state not bound to this browser', language);
    if (query.error) {
      this.consumeNonce(payload.n);
      throw new LinkFlowError('denied', 'authorization denied', language);
    }
    if (!query.code || query.code.length > 2048) throw new LinkFlowError('invalid', 'missing code', language);
    this.assertUsable(payload, language);
    if (!this.consumeNonce(payload.n)) throw new LinkFlowError('replay', 'state already used', language);

    let identity: Identity;
    try {
      identity = platform === 'twitch' ? await this.exchangeTwitch(query.code, language) : await this.exchangeTikTok(query.code, language);
    } catch (err) {
      if (err instanceof LinkFlowError) throw err;
      throw new LinkFlowError('exchange_failed', `${platform} exchange failed: ${errorMessage(err)}`, language);
    }

    const owner = this.repos.links.byPlatformUser(platform, identity.platformUserId);
    if (owner && owner.discordUserId !== payload.u) {
      throw new LinkFlowError('already_linked', 'platform account linked to another member', language);
    }

    const link = this.repos.links.upsert({
      discordUserId: payload.u,
      platform,
      platformUserId: identity.platformUserId,
      platformLogin: identity.login,
      displayName: identity.displayName,
      accessTokenEnc: identity.tokens ? this.encrypt(identity.tokens.access) : null,
      refreshTokenEnc: identity.tokens?.refresh ? this.encrypt(identity.tokens.refresh) : null,
      scopes: identity.scopes,
      accessExpiresAt: identity.tokens ? new Date(identity.tokens.accessExpiresAt).toISOString() : null,
      refreshExpiresAt: identity.tokens?.refreshExpiresAt ? new Date(identity.tokens.refreshExpiresAt).toISOString() : null,
    });

    const account = await this.syncStreamerAccount(payload.g, payload.u, link);
    this.audit.record({
      guildId: payload.g,
      actor: `user:${payload.u}`,
      action: 'link.created',
      message: `<@${payload.u}> ربط حسابه في ${PLATFORM_LABEL[platform]} رسمياً (${identity.login ?? identity.displayName ?? identity.platformUserId})`,
      details: { platform, platformUserId: identity.platformUserId, login: identity.login, account },
    });
    return { guildId: payload.g, userId: payload.u, platform, language, login: identity.login, displayName: identity.displayName, account };
  }

  private async syncStreamerAccount(guildId: string, userId: string, link: AccountLink): Promise<LinkAccountOutcome> {
    try {
      const streamer = this.repos.streamers.getByDiscordId(guildId, userId);
      if (!streamer) return 'not_streamer';
      const full = this.streamers.get(guildId, streamer.id);
      const same = full.accounts.filter((a) => a.channel.platform === link.platform);
      if (same.length > 0) {
        const match = same.some((a) =>
          link.platform === 'twitch'
            ? a.channel.platformId === link.platformUserId
            : !!link.platformLogin && a.channel.handle.toLowerCase() === link.platformLogin.toLowerCase(),
        );
        return match ? 'verified' : 'mismatch';
      }
      const input = link.platform === 'twitch' ? `id:${link.platformUserId}` : link.platformLogin;
      if (!input) return 'no_handle';
      await this.streamers.addAccount(guildId, streamer.id, { platform: link.platform, input }, `user:${userId}`);
      return 'added';
    } catch (err) {
      log.warn({ guildId, userId, platform: link.platform, err: errorMessage(err) }, 'Could not add the linked account to the streamer');
      return 'add_failed';
    }
  }

  // ───────────── platform exchanges ─────────────

  private async exchangeTwitch(code: string, language: Language): Promise<Identity> {
    const clientId = this.config.TWITCH_CLIENT_ID!;
    const token = await this.postForm<{ access_token?: string }>(TWITCH_TOKEN_URL, {
      client_id: clientId,
      client_secret: this.config.TWITCH_CLIENT_SECRET!,
      code,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri('twitch'),
    });
    const accessToken = token.ok ? token.body?.access_token : undefined;
    if (!accessToken) throw new LinkFlowError('exchange_failed', `twitch token exchange failed (HTTP ${token.status})`, language);
    try {
      const res = await this.request(TWITCH_USERS_URL, { headers: { authorization: `Bearer ${accessToken}`, 'client-id': clientId } });
      const body = (await res.json().catch(() => null)) as { data?: Array<{ id?: string; login?: string; display_name?: string }> } | null;
      const user = body?.data?.[0];
      if (!res.ok || !user?.id || !/^\d{1,20}$/.test(user.id)) throw new LinkFlowError('exchange_failed', `twitch users lookup failed (HTTP ${res.status})`, language);
      return { platformUserId: user.id, login: user.login ?? null, displayName: user.display_name ?? user.login ?? null, scopes: [], tokens: null };
    } finally {
      // Scope-less identity proof: the token is not needed anymore.
      void this.postForm(TWITCH_REVOKE_URL, { client_id: clientId, token: accessToken }).catch(() => undefined);
    }
  }

  private async exchangeTikTok(code: string, language: Language): Promise<Identity> {
    const token = await this.postForm<TikTokTokenResponse>(TIKTOK_TOKEN_URL, {
      client_key: this.config.TIKTOK_CLIENT_KEY!,
      client_secret: this.config.TIKTOK_CLIENT_SECRET!,
      code,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri('tiktok'),
    });
    const body = token.body;
    if (!token.ok || !body?.access_token || !body.open_id || body.error) {
      throw new LinkFlowError('exchange_failed', `tiktok token exchange failed (HTTP ${token.status}${body?.error ? `, ${body.error}` : ''})`, language);
    }
    const res = await this.request(TIKTOK_USER_INFO_URL, { headers: { authorization: `Bearer ${body.access_token}` } }).catch(() => null);
    const info = res ? ((await res.json().catch(() => null)) as { data?: { user?: { open_id?: string; display_name?: string; username?: string } }; error?: { code?: string } } | null) : null;
    const user = info?.data?.user;
    if (!res?.ok || !user || (info?.error?.code && info.error.code !== 'ok')) {
      throw new LinkFlowError('exchange_failed', `tiktok user info failed (HTTP ${res?.status ?? 0})`, language);
    }
    const now = this.now();
    const username = typeof user.username === 'string' && user.username.trim() ? user.username.trim().replace(/^@/, '') : null;
    return {
      platformUserId: body.open_id,
      login: username,
      displayName: user.display_name?.trim() || username,
      scopes: (body.scope ?? '').split(/[,\s]+/).filter(Boolean),
      tokens: {
        access: body.access_token,
        refresh: body.refresh_token ?? null,
        accessExpiresAt: now + Math.max(60, Number(body.expires_in) || 86_400) * 1000,
        refreshExpiresAt: body.refresh_token ? now + Math.max(60, Number(body.refresh_expires_in) || 31_536_000) * 1000 : null,
      },
    };
  }

  // ───────────── token source (TikTok provider) ─────────────

  async tiktokAccessToken(handle: string): Promise<{ accessToken: string; openId: string } | null> {
    if (!this.encKey || !this.config.TIKTOK_CLIENT_KEY || !this.config.TIKTOK_CLIENT_SECRET) return null;
    const clean = handle.trim().replace(/^@/, '');
    if (!clean) return null;
    let link: AccountLink | null;
    try {
      link = this.repos.links.byPlatformLogin('tiktok', clean);
    } catch (err) {
      log.warn({ err: errorMessage(err) }, 'Reading TikTok link failed');
      return null;
    }
    if (!link?.accessTokenEnc) return null;

    const expiresAt = link.accessExpiresAt ? Date.parse(link.accessExpiresAt) : 0;
    if (expiresAt - this.now() <= REFRESH_MARGIN_MS) {
      link = await this.refreshOnce(link);
      if (!link?.accessTokenEnc) return null;
    }
    const accessToken = this.decrypt(link.accessTokenEnc);
    if (!accessToken) {
      this.dropTokens(link, 'decrypt_failed');
      return null;
    }
    return { accessToken, openId: link.platformUserId };
  }

  private refreshOnce(link: AccountLink): Promise<AccountLink | null> {
    const existing = this.refreshing.get(link.id);
    if (existing) return existing;
    const p = this.refresh(link)
      .catch((err: unknown) => {
        log.warn({ linkId: link.id, err: errorMessage(err) }, 'TikTok token refresh crashed');
        return null;
      })
      .finally(() => this.refreshing.delete(link.id));
    this.refreshing.set(link.id, p);
    return p;
  }

  private async refresh(link: AccountLink): Promise<AccountLink | null> {
    const now = this.now();
    const refreshExpiry = link.refreshExpiresAt ? Date.parse(link.refreshExpiresAt) : 0;
    const refreshToken = link.refreshTokenEnc ? this.decrypt(link.refreshTokenEnc) : null;
    if (!refreshToken || refreshExpiry <= now) {
      this.dropTokens(link, 'refresh_expired');
      return null;
    }
    let res: { ok: boolean; status: number; body: TikTokTokenResponse | null };
    try {
      res = await this.postForm<TikTokTokenResponse>(TIKTOK_TOKEN_URL, {
        client_key: this.config.TIKTOK_CLIENT_KEY!,
        client_secret: this.config.TIKTOK_CLIENT_SECRET!,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
    } catch (err) {
      // Transient (network): keep tokens; use the current access token if it hasn't expired yet.
      log.warn({ linkId: link.id, err: errorMessage(err) }, 'TikTok token refresh failed (network)');
      return this.stillValid(link) ? link : null;
    }
    const body = res.body;
    if (res.ok && body?.access_token && !body.error) {
      const accessEnc = this.encrypt(body.access_token);
      const refreshEnc = body.refresh_token ? this.encrypt(body.refresh_token) : link.refreshTokenEnc;
      const tokens = {
        accessTokenEnc: accessEnc,
        refreshTokenEnc: refreshEnc,
        accessExpiresAt: new Date(now + Math.max(60, Number(body.expires_in) || 86_400) * 1000).toISOString(),
        refreshExpiresAt: body.refresh_expires_in ? new Date(now + Number(body.refresh_expires_in) * 1000).toISOString() : link.refreshExpiresAt,
      };
      this.repos.links.updateTokens(link.id, tokens);
      return { ...link, ...tokens };
    }
    // TikTok answers 200 with an `error` field (or 4xx) for revoked/invalid refresh tokens → revoked.
    if (body?.error || (res.status >= 400 && res.status < 500)) {
      this.dropTokens(link, body?.error ?? `http_${res.status}`);
      return null;
    }
    log.warn({ linkId: link.id, status: res.status }, 'TikTok token refresh failed (server)');
    return this.stillValid(link) ? link : null;
  }

  private stillValid(link: AccountLink): boolean {
    return !!link.accessExpiresAt && Date.parse(link.accessExpiresAt) > this.now();
  }

  private dropTokens(link: AccountLink, reason: string): void {
    try {
      this.repos.links.updateTokens(link.id, { accessTokenEnc: null, refreshTokenEnc: null, accessExpiresAt: null, refreshExpiresAt: null });
    } catch (err) {
      log.warn({ linkId: link.id, err: errorMessage(err) }, 'Clearing TikTok tokens failed');
    }
    this.audit.record({
      actor: 'system',
      action: 'link.tokens_revoked',
      level: 'warn',
      message: `انتهت صلاحية ربط تيك توك الرسمي لـ <@${link.discordUserId}> (${link.platformLogin ?? link.platformUserId}). البوت رجع للطريقة غير الرسمية، ويقدر يعيد الربط بأمر /link`,
      details: { linkId: link.id, discordUserId: link.discordUserId, reason },
      mirror: false,
    });
  }

  // ───────────── management ─────────────

  linksFor(userId: string): AccountLink[] {
    try {
      return this.repos.links.forUser(userId);
    } catch (err) {
      log.warn({ err: errorMessage(err) }, 'Reading links failed');
      return [];
    }
  }

  async unlink(userId: string, platform: LinkPlatform, actor: string): Promise<boolean> {
    const link = this.repos.links.get(userId, platform);
    if (!link) return false;
    if (platform === 'tiktok' && link.accessTokenEnc && this.config.TIKTOK_CLIENT_KEY && this.config.TIKTOK_CLIENT_SECRET) {
      const token = this.decrypt(link.accessTokenEnc);
      if (token) {
        await this.postForm(TIKTOK_REVOKE_URL, {
          client_key: this.config.TIKTOK_CLIENT_KEY,
          client_secret: this.config.TIKTOK_CLIENT_SECRET,
          token,
        }).catch((err: unknown) => log.debug({ err: errorMessage(err) }, 'TikTok revoke failed (ignored)'));
      }
    }
    const removed = this.repos.links.delete(userId, platform);
    if (removed) {
      this.audit.record({
        actor,
        action: 'link.removed',
        message: `تم إلغاء ربط ${PLATFORM_LABEL[platform]} الرسمي لـ <@${userId}> (${link.platformLogin ?? link.platformUserId})`,
        details: { discordUserId: userId, platform, platformUserId: link.platformUserId },
        mirror: false,
      });
    }
    return removed;
  }

  // ───────────── crypto ─────────────

  /** AES-256-GCM: "v1.<base64url(iv | tag | ciphertext)>". */
  encrypt(plain: string): string {
    if (!this.encKey) throw new Error('SESSION_SECRET is required to store linked tokens');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `v1.${b64url(Buffer.concat([iv, cipher.getAuthTag(), ct]))}`;
  }

  /** Null when tampered, malformed or encrypted with another secret. */
  decrypt(value: string): string | null {
    if (!this.encKey || !value.startsWith('v1.')) return null;
    try {
      const raw = Buffer.from(value.slice(3), 'base64url');
      if (raw.length < 29) return null;
      const decipher = createDecipheriv('aes-256-gcm', this.encKey, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  private sign(payload: FlowPayload): string {
    const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
    return `${body}.${this.mac(body)}`;
  }

  private mac(body: string): string {
    return b64url(createHmac('sha256', this.signKey!).update(body).digest());
  }

  /** Signature + shape check only (no expiry). */
  private decode(token: string | undefined): FlowPayload | null {
    if (!this.signKey || !token || token.length > 1024) return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    if (!safeEqual(token.slice(dot + 1), this.mac(body))) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<FlowPayload>;
      if (
        typeof p.g !== 'string' ||
        !DISCORD_ID_RE.test(p.g) ||
        typeof p.u !== 'string' ||
        !DISCORD_ID_RE.test(p.u) ||
        !isLinkPlatform(p.p) ||
        typeof p.n !== 'string' ||
        typeof p.exp !== 'number' ||
        (p.k !== 's' && p.k !== 'o')
      ) {
        return null;
      }
      return p as FlowPayload;
    } catch {
      return null;
    }
  }

  private verify(token: string | undefined, kind: FlowPayload['k']): FlowPayload {
    const payload = this.decode(token);
    if (!payload || payload.k !== kind) throw new LinkFlowError('invalid', 'invalid token');
    if (payload.exp <= this.now()) throw new LinkFlowError('expired', 'token expired', this.language(payload.g));
    return payload;
  }

  private assertUsable(payload: FlowPayload, language: Language): void {
    if (!this.isAvailable(payload.p)) throw new LinkFlowError('unavailable', 'platform not configured', language);
    if (!this.featureEnabled(payload.g)) throw new LinkFlowError('disabled', 'linking disabled in this guild', language);
  }

  /** Marks a state nonce as used; false when it was used already (replay). Nonces are remembered 20 minutes. */
  private consumeNonce(nonce: string): boolean {
    const now = this.now();
    let used: Record<string, number> = {};
    try {
      const stored = this.repos.kv.get<Record<string, number>>(NONCE_KV_KEY);
      if (stored && typeof stored === 'object') used = stored;
    } catch {
      /* treat as empty */
    }
    const fresh: Record<string, number> = {};
    for (const [k, exp] of Object.entries(used)) if (typeof exp === 'number' && exp > now) fresh[k] = exp;
    if (fresh[nonce] !== undefined) return false;
    fresh[nonce] = now + NONCE_TTL_MS;
    const entries = Object.entries(fresh);
    const trimmed = entries.length > MAX_STORED_NONCES ? Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_STORED_NONCES)) : fresh;
    try {
      this.repos.kv.set(NONCE_KV_KEY, trimmed);
    } catch (err) {
      log.warn({ err: errorMessage(err) }, 'Storing link nonce failed');
    }
    return true;
  }

  // ───────────── http ─────────────

  private request(url: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  }

  private async postForm<T>(url: string, form: Record<string, string>): Promise<{ ok: boolean; status: number; body: T | null }> {
    const res = await this.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
    const body = (await res.json().catch(() => null)) as T | null;
    return { ok: res.ok, status: res.status, body };
  }
}

interface Identity {
  platformUserId: string;
  login: string | null;
  displayName: string | null;
  scopes: string[];
  tokens: { access: string; refresh: string | null; accessExpiresAt: number; refreshExpiresAt: number | null } | null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
