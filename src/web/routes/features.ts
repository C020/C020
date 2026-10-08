/** v2 tools: interactive panels (#1/#9), manual posts (#14), clip digest (#6), statistics (#13). */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../../app/context.js';
import type { ManualPostPreviewDto, SessionDetailDto, StreamerStatsDto } from '../../shared/api.js';
import { deletedStreamerSummary } from '../dto.js';
import { discordUnavailable, HttpError, notFound } from '../httpErrors.js';
import {
  manualInspectSchema,
  manualPostSchema,
  panelParams,
  parseInput,
  sessionParams,
  streamerParams,
  streamerStatsQuery,
} from '../schemas.js';
import { discordAction, guildIdOf, requireAuth, type ApiDeps } from './deps.js';

export function registerFeatureRoutes(g: FastifyInstance, deps: ApiDeps): void {
  const { ctx, dto } = deps;

  // ───────────── panels ─────────────
  g.post('/panels/:kind', { config: { rateLimit: { max: 6, timeWindow: 60_000 } } }, async (request) => {
    const { guildId, kind } = parseInput(panelParams, request.params);
    if (!safeReady(ctx)) throw discordUnavailable();
    const ref = await discordAction(request, 'Posting panel', 'ما قدرنا ننشر اللوحة، تأكد إن الروم محدد وإن البوت يقدر يرسل فيه', () =>
      ctx.discord.postPanel(guildId, kind),
    );
    ctx.audit.record({
      guildId,
      actor: requireAuth(request).actor,
      action: 'panels.post',
      message: kind === 'notify' ? 'تم نشر لوحة رتبة الإشعارات' : 'تم نشر لوحة التقديم كستريمر',
      details: { kind, channelId: ref.channelId, messageId: ref.messageId },
    });
    return { ok: true as const, messageUrl: dto.messageUrl(guildId, { messageChannelId: ref.channelId, messageId: ref.messageId }) ?? '' };
  });

  // ───────────── manual posts ─────────────
  g.post('/manual-posts/inspect', { config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, async (request): Promise<ManualPostPreviewDto> => {
    const guildId = guildIdOf(request);
    const manual = manualPosts(ctx, guildId);
    const { url } = parseInput(manualInspectSchema, request.body);
    const preview = await guarded(request, 'Inspecting manual post', 'ما قدرنا نفحص الرابط الحين، جرّب بعد شوي', () => manual.inspect(guildId, url));
    return { ...preview, streamer: preview.streamer ? { ...preview.streamer } : null };
  });

  g.post('/manual-posts', { config: { rateLimit: { max: 10, timeWindow: 60_000 } } }, async (request) => {
    const guildId = guildIdOf(request);
    const manual = manualPosts(ctx, guildId);
    const body = parseInput(manualPostSchema, request.body);
    if (body.streamerId != null) {
      const streamer = ctx.repos.streamers.get(body.streamerId);
      if (!streamer || streamer.guildId !== guildId) throw notFound('الستريمر غير موجود');
    }
    const result = await guarded(request, 'Manual post', 'ما قدرنا ننشر المقطع، تأكد إن روم المقاطع محدد وإن البوت يقدر يرسل فيه', () =>
      manual.post(guildId, body, requireAuth(request).actor),
    );
    const ref = result.messageRef;
    return { ok: true as const, messageUrl: ref ? dto.messageUrl(guildId, { messageChannelId: ref.channelId, messageId: ref.messageId }) : null };
  });

  // ───────────── clip digest ─────────────
  g.post('/digest/post-now', { config: { rateLimit: { max: 4, timeWindow: 60_000 } } }, async (request) => {
    const guildId = guildIdOf(request);
    const content = ctx.content;
    if (typeof content.postDigestNow !== 'function') throw new HttpError(503, 'unavailable', 'نشر ملخص الكليبات غير متاح حالياً');
    const ref = await guarded(request, 'Posting clip digest', 'ما قدرنا ننشر ملخص الكليبات الحين، جرّب بعد شوي', () =>
      content.postDigestNow!(guildId, requireAuth(request).actor),
    );
    return { ok: true as const, messageUrl: ref ? dto.messageUrl(guildId, { messageChannelId: ref.channelId, messageId: ref.messageId }) : null };
  });

  // ───────────── statistics ─────────────
  g.get('/sessions/:sessionId', async (request): Promise<SessionDetailDto> => {
    const { guildId, sessionId } = parseInput(sessionParams, request.params);
    const session = ctx.repos.sessions.get(sessionId);
    if (!session || session.guildId !== guildId) throw notFound('البث غير موجود');
    let samples: ReturnType<AppContext['stats']['sessionSamples']> = [];
    try {
      samples = ctx.stats ? ctx.stats.sessionSamples(sessionId) : ctx.repos.samples.forSession(sessionId);
    } catch (err) {
      request.log.warn({ err, sessionId }, 'Reading viewer samples failed');
    }
    const streamer = dto.summaries(guildId)(session.streamerId) ?? deletedStreamerSummary(session.streamerId);
    return dto.sessionDetail(session, streamer, samples);
  });

  g.get('/streamers/:id/stats', async (request): Promise<StreamerStatsDto> => {
    const { guildId, id } = parseInput(streamerParams, request.params);
    const { days } = parseInput(streamerStatsQuery, request.query);
    const streamer = ctx.repos.streamers.get(id);
    if (!streamer || streamer.guildId !== guildId) throw notFound('الستريمر غير موجود');
    if (!ctx.stats) throw new HttpError(503, 'unavailable', 'الإحصائيات غير متاحة الحين، جرّب بعد شوي');
    let data: ReturnType<AppContext['stats']['streamerStats']>;
    try {
      data = ctx.stats.streamerStats(guildId, id, days);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      request.log.warn({ err, streamerId: id }, 'Computing streamer stats failed');
      throw new HttpError(500, 'internal', 'الإحصائيات غير متاحة الحين، جرّب بعد شوي');
    }
    return dto.streamerStats(streamer, data);
  });
}

/** #14 — the manual-post endpoints only work when the guild enabled the feature. */
function manualPosts(ctx: AppContext, guildId: string): AppContext['manualPosts'] {
  if (!ctx.repos.settings.get(guildId).features.manualPosts.enabled) {
    throw new HttpError(403, 'feature_disabled', 'النشر اليدوي مقفل في هذا السيرفر، فعّله من الإعدادات أول', 'features.manualPosts.enabled');
  }
  if (!ctx.manualPosts) throw new HttpError(503, 'unavailable', 'ما قدرنا نكمّل الطلب الحين، جرّب بعد شوي');
  return ctx.manualPosts;
}

/** Service call whose user-facing errors pass through; anything unexpected becomes a 502 with a hint. */
function guarded<T>(request: FastifyRequest, what: string, hint: string, fn: () => Promise<T>): Promise<T> {
  return discordAction(request, what, hint, fn);
}

function safeReady(ctx: AppContext): boolean {
  try {
    return ctx.discord.isReady();
  } catch {
    return false;
  }
}
