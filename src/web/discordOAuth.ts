/**
 * Minimal Discord OAuth2 client (authorization code grant) for the dashboard login.
 * Responses are validated so a malformed/changed payload fails loudly instead of creating broken sessions.
 */
import { z } from 'zod';
import type { FetchLike } from '../platforms/http.js';

const DISCORD_API = 'https://discord.com/api/v10';
const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const CDN = 'https://cdn.discordapp.com';
const USER_AGENT = 'stream-bot-dashboard/1.0';

export const OAUTH_SCOPES = ['identify', 'guilds'] as const;

export type DiscordOAuthErrorKind = 'invalid_grant' | 'unauthorized' | 'rate_limited' | 'network' | 'bad_response';

export class DiscordOAuthError extends Error {
  constructor(
    readonly kind: DiscordOAuthErrorKind,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DiscordOAuthError';
  }
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});
export type DiscordTokens = z.infer<typeof tokenSchema>;

const userSchema = z.object({
  id: z.string().regex(/^\d+$/),
  username: z.string(),
  global_name: z.string().nullish(),
  avatar: z.string().nullish(),
  discriminator: z.string().nullish(),
});
export type DiscordUser = z.infer<typeof userSchema>;

const guildSchema = z.object({
  id: z.string().regex(/^\d+$/),
  name: z.string(),
  icon: z.string().nullish(),
  owner: z.boolean().optional(),
  permissions: z.union([z.string(), z.number()]).optional(),
});
export type DiscordPartialGuild = z.infer<typeof guildSchema>;

export interface DiscordOAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class DiscordOAuthClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: DiscordOAuthOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** prompt=none skips the consent screen for users who already approved the app. */
  authorizeUrl(state: string, prompt: 'none' | 'consent' = 'none'): string {
    const params = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri,
      response_type: 'code',
      scope: OAUTH_SCOPES.join(' '),
      state,
      prompt,
    });
    // URLSearchParams encodes spaces as "+"; Discord documents %20 for the scope separator.
    return `${AUTHORIZE_URL}?${params.toString().replace(/\+/g, '%20')}`;
  }

  async exchangeCode(code: string): Promise<DiscordTokens> {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.options.redirectUri });
    const json = await this.request('/oauth2/token', { method: 'POST', body, headers: this.clientAuthHeaders() });
    return parse(tokenSchema, json, 'token');
  }

  async fetchUser(accessToken: string): Promise<DiscordUser> {
    const json = await this.request('/users/@me', { headers: bearer(accessToken) });
    return parse(userSchema, json, 'user');
  }

  /** All guilds of the user (paginated defensively; Discord caps users at 200 guilds). */
  async fetchGuilds(accessToken: string): Promise<DiscordPartialGuild[]> {
    const all: DiscordPartialGuild[] = [];
    let after: string | null = null;
    for (let page = 0; page < 5; page++) {
      const query: string = new URLSearchParams({ limit: '200', ...(after ? { after } : {}) }).toString();
      const json = await this.request(`/users/@me/guilds?${query}`, { headers: bearer(accessToken) });
      const batch = parse(z.array(guildSchema), json, 'guilds');
      all.push(...batch);
      if (batch.length < 200) break;
      after = batch[batch.length - 1]!.id;
    }
    return all;
  }

  /** Best-effort token revocation on logout. Never throws. */
  async revoke(accessToken: string): Promise<void> {
    try {
      const body = new URLSearchParams({ token: accessToken, token_type_hint: 'access_token' });
      await this.request('/oauth2/token/revoke', { method: 'POST', body, headers: this.clientAuthHeaders() }, false);
    } catch {
      // The token expires on its own; nothing else to do.
    }
  }

  private clientAuthHeaders(): Record<string, string> {
    const basic = Buffer.from(`${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(this.options.clientSecret)}`).toString('base64');
    return { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' };
  }

  private async request(path: string, init: RequestInit, expectJson = true): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${DISCORD_API}${path}`, {
        ...init,
        headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new DiscordOAuthError('network', `Discord request failed: ${(err as Error)?.message ?? String(err)}`, null, null, { cause: err });
    }

    const text = await res.text().catch(() => '');
    const json = safeJson(text);
    if (res.ok) {
      if (!expectJson) return null;
      if (json === undefined) throw new DiscordOAuthError('bad_response', `Discord returned non-JSON (${res.status})`, res.status);
      return json;
    }

    if (res.status === 429) {
      const retryAfterSec = Number((json as { retry_after?: unknown } | undefined)?.retry_after ?? res.headers.get('retry-after') ?? 5);
      const retryAfterMs = Math.max(1000, Math.ceil((Number.isFinite(retryAfterSec) ? retryAfterSec : 5) * 1000));
      throw new DiscordOAuthError('rate_limited', 'Discord rate limited the request', 429, retryAfterMs);
    }
    if (res.status === 401) throw new DiscordOAuthError('unauthorized', 'Discord rejected the access token', 401);
    const code = (json as { error?: unknown } | undefined)?.error;
    if (res.status === 400 && (code === 'invalid_grant' || code === 'invalid_request')) {
      throw new DiscordOAuthError('invalid_grant', `Discord rejected the authorization code (${String(code)})`, 400);
    }
    throw new DiscordOAuthError('bad_response', `Discord responded ${res.status}: ${text.slice(0, 200)}`, res.status);
  }
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function safeJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new DiscordOAuthError('bad_response', `Unexpected Discord ${what} payload: ${result.error.issues[0]?.message ?? 'invalid'}`);
  return result.data;
}

// ───────────────────────────── CDN helpers ─────────────────────────────

export function userAvatarUrl(user: Pick<DiscordUser, 'id' | 'avatar' | 'discriminator'>): string {
  if (user.avatar) {
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `${CDN}/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
  }
  // Default avatars: new usernames use (id >> 22) % 6, legacy discriminators use discriminator % 5.
  let index = 0;
  try {
    const disc = Number(user.discriminator ?? '0');
    index = disc > 0 ? disc % 5 : Number((BigInt(user.id) >> 22n) % 6n);
  } catch {
    index = 0;
  }
  return `${CDN}/embed/avatars/${index}.png`;
}

export function displayNameOf(user: Pick<DiscordUser, 'username' | 'global_name'>): string {
  return user.global_name?.trim() || user.username;
}
