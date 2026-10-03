import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app/context.js';
import { PLATFORM_LABELS, type Platform } from '../../core/types.js';
import type { GuildSettings } from '../../db/models.js';
import type { LiveView } from '../../services/ports.js';
import type { DiagnosticsDto, DiscordLookups, GuildOverview, MemberDto } from '../../shared/api.js';
import { deletedStreamerSummary } from '../dto.js';
import { discordUnavailable, HttpError, notFound } from '../httpErrors.js';
import { memberParams, parseInput } from '../schemas.js';
import { guildIdOf, requireAuth, type ApiDeps } from './deps.js';
import { toGuildSummary } from './me.js';

const DAY_MS = 86_400_000;
const PROVIDER_FAILING_THRESHOLD = 3;

export function registerGuildRoutes(g: FastifyInstance, deps: ApiDeps): void {
  const { ctx, dto } = deps;

  g.get('/overview', async (request): Promise<GuildOverview> => {
    const guildId = guildIdOf(request);
    const auth = requireAuth(request);
    const guild = deps.auth.assertGuildAccess(auth, guildId);
    const settings = ctx.repos.settings.get(guildId);
    const streamers = ctx.streamers.list(guildId);
    const nowMs = deps.now();
    const since7d = new Date(nowMs - 7 * DAY_MS).toISOString();

    let liveViews: LiveView[] = [];
    try {
      liveViews = ctx.sessions.liveViews(guildId);
    } catch (err) {
      request.log.warn({ err, guildId }, 'Building live views failed');
    }
    const diagnostics = await diagnose(ctx, guildId, settings, streamers.flatMap((s) => s.accounts.map((a) => a.channel.platform)));
    const summaries = dto.summaries(guildId);
    dto.prefetchMembers(
      guildId,
      streamers.map((s) => s.discordUserId),
    );

    return {
      guild: toGuildSummary(guild),
      diagnostics,
      counts: {
        streamers: streamers.length,
        accounts: streamers.reduce((n, s) => n + s.accounts.length, 0),
        liveNow: liveViews.length,
        sessionsLast7d: ctx.repos.sessions.totals(guildId, since7d).reduce((n, r) => n + r.sessions, 0),
        contentLast7d: ctx.repos.content.recentForGuild(guildId, 500).filter((c) => c.firstSeenAt >= since7d).length,
      },
      liveNow: liveViews.map((v) => dto.liveNow(v)),
      recentSessions: ctx.repos.sessions
        .listRecent(guildId, 5, 0)
        .map((s) => dto.session(s, summaries(s.streamerId) ?? deletedStreamerSummary(s.streamerId))),
      recentContent: dto.contentList(ctx.repos.content.recentForGuild(guildId, 6), summaries),
      recentAudit: ctx.repos.audit.list({ guildId, limit: 10 }),
    };
  });

  g.get('/discord', async (request): Promise<DiscordLookups> => {
    const guildId = guildIdOf(request);
    if (!ctx.discord.isReady()) throw discordUnavailable();
    try {
      const [roles, channels] = await Promise.all([ctx.discord.roles(guildId), ctx.discord.textChannels(guildId)]);
      return {
        roles: [...roles].sort((a, b) => b.position - a.position).map((r) => ({ ...r })),
        channels: channels.map((c) => ({ ...c })),
      };
    } catch (err) {
      request.log.warn({ err, guildId }, 'Discord lookups failed');
      throw new HttpError(502, 'discord_error', 'ما قدرنا نجيب الرتب والرومات من ديسكورد الحين، جرّب بعد شوي');
    }
  });

  g.get('/members/:userId', async (request): Promise<MemberDto> => {
    const { guildId, userId } = parseInput(memberParams, request.params);
    if (!ctx.discord.isReady()) throw discordUnavailable();
    const lookup = await deps.members.get(guildId, userId);
    if (lookup.status === 'absent') throw notFound('هذا العضو مو موجود في السيرفر');
    if (lookup.status === 'unknown') {
      // Do not keep a transient failure cached for the "add streamer" form.
      deps.members.invalidate(guildId, userId);
      throw new HttpError(502, 'discord_error', 'ما قدرنا نجيب بيانات العضو من ديسكورد الحين، جرّب بعد شوي');
    }
    const m = lookup.member;
    return {
      id: m.id,
      username: m.username,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl,
      bot: m.bot,
      alreadyStreamer: ctx.repos.streamers.getByDiscordId(guildId, userId) !== null,
    };
  });

  g.get('/events', async (request, reply) => {
    const guildId = guildIdOf(request);
    return deps.sse.open(reply, guildId, requireAuth(request).session.id);
  });
}

/**
 * Discord-side diagnostics (role hierarchy, permissions...) plus problems only the web layer can see:
 * platforms that have accounts but no credentials, or that keep failing.
 */
async function diagnose(ctx: AppContext, guildId: string, settings: GuildSettings, accountPlatforms: Platform[]): Promise<DiagnosticsDto> {
  let base: DiagnosticsDto;
  try {
    const d = await ctx.discord.diagnose(guildId, settings);
    base = { botInGuild: d.botInGuild, botHasManageRoles: d.botHasManageRoles, problems: [...d.problems] };
  } catch {
    base = {
      botInGuild: safe(() => ctx.discord.guild(guildId)) !== null,
      botHasManageRoles: false,
      problems: [{ code: 'discord_unavailable', message: 'ما قدرنا نفحص صلاحيات البوت الحين، جرّب تحدّث الصفحة بعد شوي', level: 'warn' }],
    };
  }

  const used = new Set(accountPlatforms.filter((p) => settings.platformsEnabled.includes(p)));
  const runtime = new Map((safe(() => ctx.monitor.status()) ?? []).map((s) => [s.platform, s]));
  for (const platform of used) {
    const label = PLATFORM_LABELS[platform];
    const provider = safe(() => ctx.providers.get(platform));
    if (provider && !safe(() => provider.isConfigured())) {
      base.problems.push({
        code: `provider_not_configured:${platform}`,
        message: `فيه حسابات ${label} بس مفاتيح ${label} مو مضافة في ملف الإعدادات (.env)، فما راح تنراقب`,
        level: 'error',
      });
      continue;
    }
    const rt = runtime.get(platform);
    if (rt && rt.consecutiveErrors >= PROVIDER_FAILING_THRESHOLD) {
      base.problems.push({
        code: `provider_failing:${platform}`,
        message: `فحص ${label} يفشل من فترة (${rt.consecutiveErrors} مرات متتالية)${rt.lastError ? `: ${rt.lastError.slice(0, 160)}` : ''}`,
        level: 'warn',
      });
    }
  }
  return base;
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
