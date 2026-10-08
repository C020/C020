/**
 * Web server: platform webhooks (always on), health check, and — when configured — the dashboard
 * (Discord OAuth login, JSON API, SSE, SPA hosting).
 */
import { resolve } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { AppContext } from '../app/context.js';
import { childLogger } from '../core/logger.js';
import type { LinkService } from '../services/linkService.js';
import { API_RATE_LIMIT, apiPlugin, dashboardDisabledMessage } from './api.js';
import { AuthService, registerAuthRoutes } from './auth.js';
import { DiscordOAuthClient } from './discordOAuth.js';
import { DtoMapper } from './dto.js';
import { HttpError, installErrorHandler } from './httpErrors.js';
import { MemberCache } from './memberCache.js';
import type { ApiDeps } from './routes/deps.js';
import { registerLinkRoutes } from './routes/link.js';
import { helmetOptions, TRUSTED_PROXIES } from './security.js';
import { SseHub } from './sse.js';
import { registerStatic, spaFallback } from './static.js';
import type { WebServerOptions } from './types.js';
import { webhooksPlugin } from './webhooks.js';

export type { WebServerOptions } from './types.js';

const API_BODY_LIMIT = 256 * 1024;
const SESSION_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface WebServer {
  app: FastifyInstance;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createWebServer(ctx: AppContext, options: WebServerOptions = {}): Promise<WebServer> {
  const log = options.logger ?? childLogger('web');
  const now = options.now ?? Date.now;
  const publicDir = options.publicDir ?? resolve(process.cwd(), 'dist/public');
  if (ctx.config.dashboardEnabled && (ctx.config.SESSION_SECRET?.length ?? 0) < 32) {
    log.warn('SESSION_SECRET is shorter than 32 characters; generate a strong one with `npm run secrets`');
  }

  const app = Fastify({
    // pino's Logger is a FastifyBaseLogger; the cast keeps the default instance type used by the plugins.
    loggerInstance: log as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: TRUSTED_PROXIES,
    bodyLimit: API_BODY_LIMIT,
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 200 },
  });

  app.decorateRequest('auth', null);
  installErrorHandler(app);
  acceptEmptyJsonBodies(app);
  app.addHook('onResponse', async (request, reply) => logResponse(request, reply));

  await app.register(fastifyCookie, ctx.config.SESSION_SECRET ? { secret: ctx.config.SESSION_SECRET } : {});
  await app.register(fastifyHelmet, helmetOptions(ctx.config));
  // Registered before the rate limiter so loading dashboard assets never counts against the API budget.
  await registerStatic(app, publicDir);
  await app.register(fastifyRateLimit, {
    global: true,
    ...API_RATE_LIMIT,
    errorResponseBuilder: (_request, context) => {
      const seconds = Math.max(1, Math.ceil(context.ttl / 1000));
      return new HttpError(context.statusCode, 'rate_limited', `طلبات كثيرة، هدّ شوي وجرّب بعد ${seconds} ثانية`, undefined, {
        'retry-after': String(seconds),
      });
    },
  });

  app.get('/healthz', { config: { rateLimit: false } }, async () => ({
    ok: true,
    discord: safeReady(ctx),
    uptimeSec: Math.max(0, Math.floor((now() - ctx.startedAt) / 1000)),
  }));

  await app.register(webhooksPlugin, { ctx });

  // #11 — public OAuth pages for optional account linking (independent of the dashboard login).
  const linkService = asLinkService(ctx.links);
  if (linkService) registerLinkRoutes(app, ctx, linkService);

  const timers: NodeJS.Timeout[] = [];
  let sse: SseHub | null = null;

  if (ctx.config.dashboardEnabled) {
    const oauth = new DiscordOAuthClient({
      clientId: ctx.config.DISCORD_CLIENT_ID,
      clientSecret: ctx.config.DISCORD_CLIENT_SECRET!,
      redirectUri: `${ctx.config.PUBLIC_URL}/auth/callback`,
      fetch: options.fetch,
    });
    const auth = new AuthService({ ctx, oauth, now });
    const members = new MemberCache(ctx.discord, { now });
    const dto = new DtoMapper(ctx, members, now);
    sse = new SseHub(ctx, dto, {
      heartbeatMs: options.sseHeartbeatMs,
      // Same rules as a new request: the session must exist and not be expired, and its (periodically refreshed)
      // guild permissions must still allow this guild. The bot's own guild membership is not re-checked here.
      isSessionValid: async (sessionId, guildId) => {
        const session = ctx.repos.webSessions.get(sessionId);
        if (!session || Date.parse(session.expiresAt) <= now()) return false;
        const fresh = await auth.ensureFreshGuilds(session);
        return fresh !== null && auth.canAccessGuild(auth.authState(fresh), guildId);
      },
    });
    const deps: ApiDeps = { ctx, auth, dto, members, sse, now };

    registerAuthRoutes(app, auth);
    await app.register((api) => apiPlugin(api, deps), { prefix: '/api' });

    const prune = (): void => {
      try {
        const removed = ctx.repos.webSessions.pruneExpired();
        if (removed > 0) log.debug({ removed }, 'Pruned expired dashboard sessions');
      } catch (err) {
        log.warn({ err }, 'Pruning dashboard sessions failed');
      }
    };
    prune();
    const timer = setInterval(prune, SESSION_PRUNE_INTERVAL_MS);
    timer.unref();
    timers.push(timer);
  } else {
    const message = dashboardDisabledMessage(ctx.config);
    const disabled = async (_request: FastifyRequest, reply: FastifyReply) =>
      reply.code(503).header('cache-control', 'no-store').send({ error: 'dashboard_disabled', message });
    app.all('/api', disabled);
    app.all('/api/*', disabled);
    app.all('/auth/*', disabled);
  }

  app.setNotFoundHandler(spaFallback(publicDir));

  // Open SSE streams would otherwise keep close() waiting forever.
  app.addHook('preClose', async () => sse?.closeAll());
  app.addHook('onClose', async () => {
    for (const timer of timers) clearInterval(timer);
  });

  return {
    app,
    async start() {
      await app.listen({ host: ctx.config.HOST, port: ctx.config.PORT });
    },
    async stop() {
      await app.close();
    },
  };
}

/**
 * Many fetch wrappers send "content-type: application/json" on every request, including bodiless
 * POST/DELETE calls; treat an empty body as "no body" instead of failing with 400.
 * Non-empty bodies still go through Fastify's hardened parser (prototype-poisoning protection).
 */
function acceptEmptyJsonBodies(app: FastifyInstance): void {
  const defaultParser = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') {
      done(null, undefined);
      return;
    }
    defaultParser(request, text, done);
  });
}

/** ctx.links is typed as the API; the OAuth routes need the concrete LinkService (flow methods). */
export function asLinkService(links: unknown): LinkService | null {
  if (typeof links !== 'object' || links === null) return null;
  const l = links as Record<string, unknown>;
  return typeof l.authorizeRedirect === 'function' && typeof l.complete === 'function' && typeof l.languageOfState === 'function'
    ? (links as LinkService)
    : null;
}

function safeReady(ctx: AppContext): boolean {
  try {
    return ctx.discord.isReady();
  } catch {
    return false;
  }
}

/** One line per request; the route pattern is logged instead of the URL so OAuth codes never hit the logs. */
function logResponse(request: FastifyRequest, reply: FastifyReply): void {
  const entry = {
    method: request.method,
    route: request.routeOptions.url ?? 'not-found',
    status: reply.statusCode,
    ms: Math.round(reply.elapsedTime),
    ip: request.ip,
  };
  if (reply.statusCode >= 500) request.log.warn(entry, 'Request failed');
  else request.log.debug(entry, 'Request');
}
