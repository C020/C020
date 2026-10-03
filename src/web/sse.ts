/**
 * Server-Sent Events for the dashboard (GET /api/guilds/:guildId/events).
 * Each connection subscribes to the app event bus, filtered to its guild, with a heartbeat that also
 * re-validates the web session so a logged-out tab stops receiving data.
 */
import { PassThrough } from 'node:stream';
import type { FastifyReply } from 'fastify';
import type { AppContext } from '../app/context.js';
import { childLogger } from '../core/logger.js';
import type { DtoMapper } from './dto.js';
import { HttpError } from './httpErrors.js';

const log = childLogger('web.sse');

/** A slow/stalled client is dropped instead of buffering events forever. */
const MAX_BUFFERED_BYTES = 512 * 1024;
/** Keeps listener counts on the shared event bus (limit 200 per event) and memory bounded. */
const MAX_CONNECTIONS = 150;

export interface SseHubOptions {
  heartbeatMs?: number;
  maxPerSession?: number;
  /** Re-checks the session on every heartbeat; return false to close the stream. */
  isSessionValid?: (sessionId: string) => boolean;
}

interface Connection {
  sessionId: string;
  close: () => void;
}

export class SseHub {
  private readonly connections = new Set<Connection>();
  private readonly heartbeatMs: number;
  private readonly maxPerSession: number;
  private readonly isSessionValid: (sessionId: string) => boolean;

  constructor(
    private readonly ctx: AppContext,
    private readonly dto: DtoMapper,
    options: SseHubOptions = {},
  ) {
    this.heartbeatMs = options.heartbeatMs ?? 25_000;
    this.maxPerSession = options.maxPerSession ?? 8;
    this.isSessionValid = options.isSessionValid ?? (() => true);
  }

  get size(): number {
    return this.connections.size;
  }

  open(reply: FastifyReply, guildId: string, sessionId: string): FastifyReply {
    const perSession = [...this.connections].filter((c) => c.sessionId === sessionId).length;
    if (perSession >= this.maxPerSession) {
      throw new HttpError(429, 'too_many_streams', 'فاتح اللوحة في صفحات كثيرة، سكّر بعضها وحدّث الصفحة');
    }
    if (this.connections.size >= MAX_CONNECTIONS) {
      throw new HttpError(503, 'too_many_streams', 'السيرفر مشغول الحين، حدّث الصفحة بعد شوي', undefined, { 'retry-after': '30' });
    }

    const stream = new PassThrough();
    const unsubscribers: Array<() => void> = [];
    let closed = false;

    const send = (event: string, data: unknown): void => {
      if (closed) return;
      // JSON.stringify escapes newlines, so the payload always fits on a single "data:" line.
      stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (stream.writableLength > MAX_BUFFERED_BYTES) {
        log.warn({ guildId }, 'SSE client too slow; dropping connection');
        close(true);
      }
    };

    const heartbeat = setInterval(() => {
      if (!this.isSessionValid(sessionId)) {
        close();
        return;
      }
      send('ping', { t: Date.now() });
    }, this.heartbeatMs);
    heartbeat.unref();

    /** Graceful close flushes what is buffered; a hard close drops a stalled connection immediately. */
    const close = (hard = false): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      for (const off of unsubscribers) off();
      this.connections.delete(connection);
      if (hard) {
        stream.destroy();
        reply.raw.destroy();
      } else {
        stream.end();
      }
    };
    const connection: Connection = { sessionId, close: () => close() };
    this.connections.add(connection);

    unsubscribers.push(
      this.ctx.events.on('live.changed', (e) => {
        if (e.guildId === guildId) send('live', { streamerId: e.streamerId, status: e.status });
      }),
      this.ctx.events.on('content.announced', (e) => {
        if (e.guildId !== guildId) return;
        const streamer = safe(() => this.dto.summaries(guildId)(e.streamerId));
        send('content', { streamerId: e.streamerId, streamer, platform: e.platform, title: e.title, url: e.url });
      }),
      this.ctx.events.on('audit', (entry) => {
        // Same visibility as the audit list: this guild's entries plus global (bot-wide) ones.
        if (entry.guildId === guildId || entry.guildId === null) send('audit', entry);
      }),
    );

    // The response closing (client gone, server closing) is the reliable end-of-stream signal.
    reply.raw.once('close', () => close());
    stream.once('close', () => close());
    stream.on('error', () => close(true));

    // Flushes the headers right away and tells EventSource how fast to reconnect.
    stream.write(`retry: 3000\n: connected\n\n`);

    return reply
      .code(200)
      .header('content-type', 'text/event-stream; charset=utf-8')
      .header('cache-control', 'no-cache, no-store, no-transform')
      .header('connection', 'keep-alive')
      .header('x-accel-buffering', 'no')
      .send(stream);
  }

  /** Ends every open stream (server shutdown). */
  closeAll(): void {
    for (const connection of [...this.connections]) connection.close();
  }
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
