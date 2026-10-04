import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app/context.js';
import type { DiscordGuildInfo } from '../../services/ports.js';
import type { GuildSummary, MeResponse, ProviderStatus, SystemStatus } from '../../shared/api.js';
import { toResolvePreview } from '../dto.js';
import { HttpError } from '../httpErrors.js';
import { parseInput, resolveSchema } from '../schemas.js';
import { requireAuth, type ApiDeps } from './deps.js';

/**
 * Per-user budget for platform lookups, on top of the per-IP route limit: lookups spend the bot's shared platform
 * quotas (YouTube units, TikTok's WAF tolerance), and one account can come from many IPs.
 */
export const RESOLVE_USER_LIMITS: readonly SlidingLimit[] = [
  { max: 20, windowMs: 60_000 },
  { max: 150, windowMs: 60 * 60_000 },
];

/** Account-level routes: /me, /system, /platforms/resolve. */
export function registerMeRoutes(api: FastifyInstance, deps: ApiDeps): void {
  const { ctx } = deps;
  const resolveBudget = new UserBudget(RESOLVE_USER_LIMITS, deps.now);

  api.get('/me', async (request): Promise<MeResponse> => {
    const auth = requireAuth(request);
    const bot = attempt(() => ctx.discord.botUser(), null);
    return {
      user: { id: auth.session.userId, username: auth.session.username, avatarUrl: auth.session.avatarUrl },
      csrfToken: deps.auth.csrfToken(auth.session.id),
      guilds: deps.auth.accessibleGuilds(auth).map(toGuildSummary),
      bot: bot ? { ...bot, ready: attempt(() => ctx.discord.isReady(), false) } : null,
      inviteUrl: attempt(() => ctx.discord.inviteUrl(), fallbackInviteUrl(ctx)),
    };
  });

  // Provider notes and errors mention other guilds' accounts and bot configuration: full details are for admins.
  api.get('/system', async (request): Promise<SystemStatus> => {
    const auth = requireAuth(request);
    deps.auth.assertAnyGuildAccess(auth);
    return systemStatus(ctx, deps.now(), { detailed: auth.isAdmin });
  });

  // Each resolve hits a platform API, so it gets its own tighter budget (per IP here, per user below).
  api.post('/platforms/resolve', { config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, async (request) => {
    const auth = requireAuth(request);
    deps.auth.assertAnyGuildAccess(auth);
    const body = parseInput(resolveSchema, request.body);
    const waitSec = resolveBudget.take(auth.session.userId);
    if (waitSec !== null) {
      throw new HttpError(429, 'rate_limited', `تحققت من حسابات كثيرة، هدّ شوي وجرّب بعد ${waitSec} ثانية`, undefined, {
        'retry-after': String(waitSec),
      });
    }
    return toResolvePreview(await ctx.streamers.resolve(body.platform, body.input));
  });
}

export function toGuildSummary(g: DiscordGuildInfo): GuildSummary {
  return { id: g.id, name: g.name, iconUrl: g.iconUrl, memberCount: g.memberCount };
}

/**
 * Bot-wide status. `detailed` (bot admins) includes provider notes and raw error strings; guild managers get the
 * same counts and flags with generic wording, because notes can name other guilds' accounts and bot configuration
 * (RSSHub URL, EventSub/WebSub state, credential errors).
 */
export function systemStatus(ctx: AppContext, nowMs: number, options: { detailed: boolean } = { detailed: true }): SystemStatus {
  const runtime = new Map(attempt(() => ctx.monitor.status(), []).map((s) => [s.platform, s]));
  const pushPlatforms = new Set(attempt(() => ctx.providers.webhooks(), []).map((w) => w.platform));
  const providers: ProviderStatus[] = ctx.providers.all().map((provider) => {
    const rt = runtime.get(provider.platform);
    const configured = attempt(() => provider.isConfigured(), false);
    const lastError = rt?.lastError ?? null;
    const notes = options.detailed
      ? attempt(() => provider.health(), { configured: false, notes: ['تعذر قراءة حالة المنصة'] }).notes
      : configured
        ? []
        : ['المنصة غير مفعّلة في إعدادات البوت، كلّم مسؤول البوت لو تحتاجها.'];
    return {
      platform: provider.platform,
      configured,
      push: pushPlatforms.has(provider.platform),
      trackedChannels: rt?.trackedChannels ?? 0,
      liveChannels: rt?.liveChannels ?? 0,
      lastSuccessAt: rt?.lastSuccessAt ?? null,
      lastError: options.detailed || lastError === null ? lastError : 'آخر فحص للمنصة فشل، التفاصيل عند مسؤول البوت.',
      consecutiveErrors: rt?.consecutiveErrors ?? 0,
      notes,
    };
  });
  return {
    version: ctx.version,
    uptimeSec: Math.max(0, Math.floor((nowMs - ctx.startedAt) / 1000)),
    webhooksEnabled: ctx.config.webhooksEnabled,
    publicUrl: ctx.config.PUBLIC_URL ?? null,
    providers,
  };
}

function fallbackInviteUrl(ctx: AppContext): string {
  const params = new URLSearchParams({ client_id: ctx.config.DISCORD_CLIENT_ID, scope: 'bot applications.commands', permissions: '268520448' });
  return `https://discord.com/oauth2/authorize?${params.toString().replace(/\+/g, '%20')}`;
}

export interface SlidingLimit {
  max: number;
  windowMs: number;
}

/** In-memory sliding-window counters keyed by user id (single process, so no shared store is needed). */
export class UserBudget {
  private readonly hits = new Map<string, number[]>();
  private readonly longestMs: number;

  constructor(
    private readonly limits: readonly SlidingLimit[],
    private readonly now: () => number,
  ) {
    this.longestMs = Math.max(0, ...limits.map((l) => l.windowMs));
  }

  /** Counts one request; returns null when allowed, otherwise the seconds to wait (the request is not counted). */
  take(key: string): number | null {
    const nowMs = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => nowMs - t < this.longestMs);
    for (const { max, windowMs } of this.limits) {
      const inWindow = recent.filter((t) => nowMs - t < windowMs);
      if (inWindow.length >= max) {
        this.hits.set(key, recent);
        const freesAt = inWindow[inWindow.length - max]! + windowMs;
        return Math.max(1, Math.ceil((freesAt - nowMs) / 1000));
      }
    }
    recent.push(nowMs);
    this.hits.set(key, recent);
    if (this.hits.size > 1000) this.prune(nowMs);
    return null;
  }

  private prune(nowMs: number): void {
    for (const [key, list] of this.hits) {
      if (list.every((t) => nowMs - t >= this.longestMs)) this.hits.delete(key);
    }
  }
}

function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
