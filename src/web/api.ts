/**
 * The /api plugin: session auth + CSRF on every request, guild authorization on guild-scoped routes.
 */
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from './auth.js';
import { CSRF_HEADER, isMutating } from './csrf.js';
import { HttpError, unauthorized } from './httpErrors.js';
import { guildIdOf, requireAuth, type ApiDeps } from './routes/deps.js';
import { registerGuildRoutes } from './routes/guild.js';
import { registerHistoryRoutes } from './routes/history.js';
import { registerMeRoutes } from './routes/me.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerStreamerRoutes } from './routes/streamers.js';
import { registerToolRoutes } from './routes/tools.js';

export const API_RATE_LIMIT = { max: 120, timeWindow: 60_000 };

export async function apiPlugin(api: FastifyInstance, deps: ApiDeps): Promise<void> {
  api.setNotFoundHandler((_request, reply) => {
    void reply.code(404).header('cache-control', 'no-store').send({ error: 'not_found', message: 'المسار غير موجود' });
  });

  // preParsing (not onRequest): route-level onRequest hooks such as the rate limiter must run first,
  // and the body should only be parsed for authenticated users.
  api.addHook('preParsing', async (request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    const session = deps.auth.resolveSession(request.cookies[SESSION_COOKIE]);
    if (!session) throw unauthorized();
    if (isMutating(request.method) && !deps.auth.verifyCsrf(session.id, request.headers[CSRF_HEADER])) {
      throw new HttpError(403, 'csrf', 'انتهت صلاحية الصفحة، حدّثها وجرّب مرة ثانية');
    }
    request.auth = deps.auth.authState(await deps.auth.ensureFreshGuilds(session));
    return payload;
  });

  registerMeRoutes(api, deps);

  await api.register(
    async (g) => {
      g.addHook('preParsing', async (request, _reply, payload) => {
        deps.auth.assertGuildAccess(requireAuth(request), guildIdOf(request));
        return payload;
      });
      registerGuildRoutes(g, deps);
      registerSettingsRoutes(g, deps);
      registerStreamerRoutes(g, deps);
      registerHistoryRoutes(g, deps);
      registerToolRoutes(g, deps);
    },
    { prefix: '/guilds/:guildId' },
  );
}

/** Explains which env vars are missing when the dashboard is turned off. */
export function dashboardDisabledMessage(config: { DISCORD_CLIENT_SECRET?: string; SESSION_SECRET?: string; PUBLIC_URL?: string }): string {
  const missing = [
    !config.DISCORD_CLIENT_SECRET && 'DISCORD_CLIENT_SECRET',
    !config.SESSION_SECRET && 'SESSION_SECRET',
    !config.PUBLIC_URL && 'PUBLIC_URL',
  ].filter((v): v is string => !!v);
  const list = missing.length > 0 ? missing : ['DISCORD_CLIENT_SECRET', 'SESSION_SECRET', 'PUBLIC_URL'];
  return `لوحة التحكم مقفلة لأن هذي القيم ناقصة في ملف الإعدادات (.env): ${list.join('، ')}. أضفها (SESSION_SECRET تقدر تولّده بالأمر npm run secrets) وأعد تشغيل البوت.`;
}
