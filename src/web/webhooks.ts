/**
 * Platform webhooks (Twitch EventSub, Kick, YouTube WebSub). Each adapter verifies signatures over the
 * exact request bytes, so this plugin replaces every body parser with a raw Buffer parser. Hints are
 * forwarded to the monitor asynchronously: the HTTP response never waits on platform re-checks.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../app/context.js';
import { childLogger } from '../core/logger.js';
import type { PushHint, WebhookAdapter, WebhookRequest } from '../platforms/types.js';

const log = childLogger('web.webhooks');

export const WEBHOOK_BODY_LIMIT = 1024 * 1024;
/** Generous: deliveries come from a few platform IPs in bursts (many streamers going live at once). */
export const WEBHOOK_RATE_LIMIT = { max: 1200, timeWindow: 60_000 };

export async function webhooksPlugin(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;

  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT }, (_request, body, done) => done(null, body));

  let adapters: Array<{ platform: string; adapter: WebhookAdapter }> = [];
  try {
    adapters = ctx.providers.webhooks();
  } catch (err) {
    log.error({ err }, 'Listing webhook adapters failed; webhooks disabled');
  }

  const seen = new Set<string>();
  for (const { platform, adapter } of adapters) {
    const path = adapter.path;
    if (typeof path !== 'string' || !path.startsWith('/')) {
      log.error({ platform, path }, 'Webhook adapter has an invalid path; skipped');
      continue;
    }
    if (seen.has(path)) {
      log.error({ platform, path }, 'Duplicate webhook path; skipped');
      continue;
    }
    seen.add(path);

    app.route({
      method: ['GET', 'POST'],
      url: path,
      config: { rateLimit: WEBHOOK_RATE_LIMIT },
      handler: (request, reply) => handleDelivery(ctx, platform, adapter, request, reply),
    });
    log.info({ platform, path }, 'Webhook route registered');
  }
}

async function handleDelivery(
  ctx: AppContext,
  platform: string,
  adapter: WebhookAdapter,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const delivery: WebhookRequest = {
    headers: request.headers,
    query: flattenQuery(request.query),
    rawBody: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
    method: request.method,
  };

  let result;
  try {
    result = await adapter.handle(delivery);
  } catch (err) {
    log.error({ err, platform }, 'Webhook handler threw');
    return reply.code(500).header('cache-control', 'no-store').type('text/plain; charset=utf-8').send('internal error');
  }

  forwardHints(ctx, platform, result.hints);
  const status = Number.isInteger(result.status) && result.status >= 100 && result.status <= 599 ? result.status : 500;
  return reply
    .code(status)
    .header('cache-control', 'no-store')
    .type(result.contentType ?? 'text/plain; charset=utf-8')
    .send(result.body ?? '');
}

function forwardHints(ctx: AppContext, platform: string, hints: PushHint[] | undefined): void {
  if (!Array.isArray(hints) || hints.length === 0) return;
  setImmediate(() => {
    try {
      ctx.monitor.handleHints(hints);
    } catch (err) {
      log.error({ err, platform, count: hints.length }, 'Forwarding webhook hints failed');
    }
  });
}

/** Fastify may parse repeated keys into arrays; adapters expect single values (first wins). */
export function flattenQuery(query: unknown): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (!query || typeof query !== 'object') return out;
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value) && typeof value[0] === 'string') out[key] = value[0];
  }
  return out;
}
