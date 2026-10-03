import type { FastifyInstance } from 'fastify';
import type { MessagePreview } from '../../shared/api.js';
import { HttpError } from '../httpErrors.js';
import { parseInput, previewSchema, testSchema } from '../schemas.js';
import { discordAction, guildIdOf, requireAuth, type ApiDeps } from './deps.js';

export function registerToolRoutes(g: FastifyInstance, deps: ApiDeps): void {
  const { ctx, dto } = deps;

  // Test messages land in a real channel: keep them rare.
  g.post('/test', { config: { rateLimit: { max: 10, timeWindow: 60_000 } } }, async (request) => {
    const guildId = guildIdOf(request);
    const { type } = parseInput(testSchema, request.body);
    const ref = await discordAction(request, 'Sending test message', 'ديسكورد رفض رسالة التجربة، تأكد إن البوت يقدر يرسل ويضيف روابط في الروم', () =>
      ctx.discord.sendTest(guildId, type),
    );
    if (!ref) {
      throw new HttpError(
        400,
        'validation',
        'ما قدرنا نرسل رسالة التجربة: تأكد إنك محدد الروم في الإعدادات وإن البوت يقدر يشوفه ويرسل فيه',
        type === 'content' ? 'contentChannelId' : 'liveChannelId',
      );
    }
    ctx.audit.record({
      guildId,
      actor: requireAuth(request).actor,
      action: 'tools.test',
      message: `تم إرسال رسالة تجربة (${type === 'live' ? 'بث' : type === 'summary' ? 'ملخص' : 'مقطع'})`,
      details: { type, channelId: ref.channelId, messageId: ref.messageId },
    });
    return { ok: true as const, messageUrl: dto.messageUrl(guildId, { messageChannelId: ref.channelId, messageId: ref.messageId }) };
  });

  g.post('/sync-roles', { config: { rateLimit: { max: 6, timeWindow: 60_000 } } }, async (request) => {
    const guildId = guildIdOf(request);
    return discordAction(request, 'Role sync', 'ما قدرنا نزامن الرتب، تأكد إن عند البوت صلاحية Manage Roles وإن رتبته فوق الرتب', () =>
      ctx.sessions.syncRoles(guildId, requireAuth(request).actor),
    );
  });

  g.post('/preview', async (request): Promise<MessagePreview> => {
    const guildId = guildIdOf(request);
    const { type, template } = parseInput(previewSchema, request.body);
    return discordAction(request, 'Rendering preview', 'ما قدرنا نجهّز المعاينة الحين، جرّب بعد شوي', () => ctx.discord.preview(guildId, type, template));
  });
}
