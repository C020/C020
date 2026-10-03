import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app/context.js';
import type { DiscordGuildInfo } from '../../services/ports.js';
import type { GuildSummary, MeResponse, ProviderStatus, SystemStatus } from '../../shared/api.js';
import { toResolvePreview } from '../dto.js';
import { parseInput, resolveSchema } from '../schemas.js';
import { requireAuth, type ApiDeps } from './deps.js';

/** Account-level routes: /me, /system, /platforms/resolve. */
export function registerMeRoutes(api: FastifyInstance, deps: ApiDeps): void {
  const { ctx } = deps;

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

  api.get('/system', async (): Promise<SystemStatus> => systemStatus(ctx, deps.now()));

  // Each resolve hits a platform API, so it gets its own tighter budget.
  api.post('/platforms/resolve', { config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, async (request) => {
    const body = parseInput(resolveSchema, request.body);
    return toResolvePreview(await ctx.streamers.resolve(body.platform, body.input));
  });
}

export function toGuildSummary(g: DiscordGuildInfo): GuildSummary {
  return { id: g.id, name: g.name, iconUrl: g.iconUrl, memberCount: g.memberCount };
}

export function systemStatus(ctx: AppContext, nowMs: number): SystemStatus {
  const runtime = new Map(attempt(() => ctx.monitor.status(), []).map((s) => [s.platform, s]));
  const pushPlatforms = new Set(attempt(() => ctx.providers.webhooks(), []).map((w) => w.platform));
  const providers: ProviderStatus[] = ctx.providers.all().map((provider) => {
    const rt = runtime.get(provider.platform);
    const health = attempt(() => provider.health(), { configured: false, notes: ['تعذر قراءة حالة المنصة'] });
    return {
      platform: provider.platform,
      configured: attempt(() => provider.isConfigured(), false),
      push: pushPlatforms.has(provider.platform),
      trackedChannels: rt?.trackedChannels ?? 0,
      liveChannels: rt?.liveChannels ?? 0,
      lastSuccessAt: rt?.lastSuccessAt ?? null,
      lastError: rt?.lastError ?? null,
      consecutiveErrors: rt?.consecutiveErrors ?? 0,
      notes: health.notes,
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

function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
