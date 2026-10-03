/**
 * Twitch EventSub over the webhook transport.
 *
 * Deliveries are only *hints*: the monitor re-checks the channel through Helix polling, which stays the
 * source of truth. This module verifies/parses deliveries and keeps the remote subscription set in sync
 * with the tracked broadcasters (self-healing: failed/revoked subscriptions are recreated on the next sync).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { errorMessage, RateLimitedError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { ChannelRef } from '../core/types.js';
import type { HttpRequestOptions } from './http.js';
import type { KeyValueStore, PushHint, WebhookAdapter, WebhookRequest, WebhookResponse } from './types.js';

export const EVENTSUB_PATH = '/webhooks/twitch';

/** Subscriptions created per tracked broadcaster (all cost 1 with an app token, no user authorization needed). */
export const EVENTSUB_SUBSCRIPTIONS = [
  { type: 'stream.online', version: '1' },
  { type: 'stream.offline', version: '1' },
  { type: 'channel.update', version: '2' },
] as const;

const MAX_MESSAGE_AGE_MS = 10 * 60_000;
/** A subscription still waiting for callback verification after this long is considered broken. */
const PENDING_VERIFICATION_GRACE_MS = 10 * 60_000;
const DEDUPE_CAPACITY = 5_000;
const SYNC_CONCURRENCY = 4;
/** 100 pages x 100 = Twitch's 10k max_total_cost; anything beyond is a pagination loop. */
const MAX_LIST_PAGES = 100;
const MAX_REMEMBERED_REVOCATIONS = 20;
const DEFAULT_RESYNC_DELAY_MS = 60_000;
const FINGERPRINT_KV_KEY = 'twitch:eventsub_fingerprint';
const TWITCH_ID_RE = /^\d{1,20}$/;

// ───────────────────────────── transport port ─────────────────────────────

export interface HelixRequest {
  method?: 'GET' | 'POST' | 'DELETE';
  query?: HttpRequestOptions['query'];
  body?: unknown;
  /** 4xx statuses returned as a result (with the parsed error body) instead of thrown. */
  okStatuses?: readonly number[];
  /** Return { status: 404, data: null } instead of throwing. */
  allow404?: boolean;
}

export interface HelixResult<T> {
  status: number;
  data: T;
}

/** The slice of the authenticated Helix client this module needs (implemented in twitch.ts). */
export interface HelixTransport {
  request<T>(path: string, req?: HelixRequest): Promise<HelixResult<T>>;
}

// ───────────────────────────── Twitch payloads ─────────────────────────────

interface EventSubSubscription {
  id: string;
  status: string;
  type: string;
  version: string;
  condition?: Record<string, string | undefined>;
  created_at?: string;
  transport?: { method?: string; callback?: string };
}

interface EventSubListPage {
  data?: EventSubSubscription[];
  total?: number;
  total_cost?: number;
  max_total_cost?: number;
  pagination?: { cursor?: string };
}

interface EventSubDelivery {
  challenge?: string;
  subscription?: EventSubSubscription;
  event?: Record<string, unknown>;
}

// ───────────────────────────── public status ─────────────────────────────

export interface EventSubSyncStatus {
  at: string;
  /** Distinct broadcasters that should be subscribed. */
  channels: number;
  /** Subscriptions enabled (or awaiting verification) after the sync. */
  active: number;
  created: number;
  deleted: number;
  failed: number;
  totalCost: number | null;
  maxTotalCost: number | null;
  /** Twitch refused new subscriptions (cost limit / too many for one condition). */
  limitReached: boolean;
  /** Set when the whole sync could not run (e.g. listing failed). */
  error: string | null;
}

export interface EventSubRevocation {
  at: string;
  type: string;
  status: string;
  broadcasterId: string | null;
}

export interface TwitchEventSubOptions {
  api: HelixTransport;
  /** Webhook signing secret (10-100 ASCII chars). */
  secret: string;
  /** Absolute HTTPS callback, e.g. https://bot.example.com/webhooks/twitch */
  callbackUrl: string;
  logger: Logger;
  kv: KeyValueStore;
  now?: () => number;
  /** Delay before re-syncing after Twitch revoked a subscription for delivery failures. */
  resyncDelayMs?: number;
}

// ───────────────────────────── helpers ─────────────────────────────

/** Verifies `Twitch-Eventsub-Message-Signature` (sha256=<hex> over id + timestamp + raw body). */
export function verifyEventSubSignature(
  secret: string,
  messageId: string,
  timestamp: string,
  rawBody: Buffer,
  signatureHeader: string,
): boolean {
  const hex = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim())?.[1];
  if (!hex) return false;
  const expected = createHmac('sha256', secret).update(messageId).update(timestamp).update(rawBody).digest();
  const given = Buffer.from(hex, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function readHeader(req: WebhookRequest, name: string): string | undefined {
  let value = req.headers[name];
  if (value === undefined) {
    const entry = Object.entries(req.headers).find(([key]) => key.toLowerCase() === name);
    value = entry?.[1];
  }
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() || undefined;
}

/** Insertion-ordered set that forgets the oldest entries beyond `capacity`. */
class BoundedSet {
  private readonly items = new Set<string>();

  constructor(private readonly capacity: number) {}

  has(key: string): boolean {
    return this.items.has(key);
  }

  add(key: string): void {
    this.items.delete(key);
    this.items.add(key);
    while (this.items.size > this.capacity) {
      const oldest = this.items.values().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
  }
}

/** Runs `worker` over `items` with at most `limit` in flight. `worker` must not throw. */
async function runPool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

const subscriptionKey = (type: string, version: string, broadcasterId: string) => `${type}@${version}:${broadcasterId}`;

const response = (status: number, body?: string, hints: PushHint[] = []): WebhookResponse =>
  body === undefined ? { status, hints } : { status, body, contentType: 'text/plain; charset=utf-8', hints };

// ───────────────────────────── adapter ─────────────────────────────

export class TwitchEventSubAdapter implements WebhookAdapter {
  readonly path = EVENTSUB_PATH;

  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly seenMessages = new BoundedSet(DEDUPE_CAPACITY);
  private readonly revocations: EventSubRevocation[] = [];
  private lastSync: EventSubSyncStatus | null = null;

  private syncRun: Promise<void> | null = null;
  private syncDirty = false;
  private latestChannels: ChannelRef[] | null = null;
  private resyncTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: TwitchEventSubOptions) {
    this.logger = opts.logger.child({ component: 'eventsub' });
    this.now = opts.now ?? Date.now;
  }

  get callbackUrl(): string {
    return this.opts.callbackUrl;
  }

  status(): { lastSync: EventSubSyncStatus | null; revocations: EventSubRevocation[] } {
    return { lastSync: this.lastSync, revocations: [...this.revocations] };
  }

  /** Cancels a pending re-sync timer (call on shutdown). */
  dispose(): void {
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = null;
  }

  // ─────────────── deliveries ───────────────

  async handle(req: WebhookRequest): Promise<WebhookResponse> {
    if (req.method.toUpperCase() !== 'POST') return response(405, 'Method Not Allowed');

    const messageId = readHeader(req, 'twitch-eventsub-message-id');
    const timestamp = readHeader(req, 'twitch-eventsub-message-timestamp');
    const signature = readHeader(req, 'twitch-eventsub-message-signature');
    const messageType = readHeader(req, 'twitch-eventsub-message-type');
    if (!messageId || !timestamp || !signature || !messageType) {
      this.logger.warn('Rejected EventSub delivery without Twitch headers');
      return response(403, 'Forbidden');
    }
    if (!verifyEventSubSignature(this.opts.secret, messageId, timestamp, req.rawBody, signature)) {
      this.logger.warn({ messageId, messageType }, 'Rejected EventSub delivery with an invalid signature');
      return response(403, 'Forbidden');
    }
    const sentAt = Date.parse(timestamp);
    if (!Number.isFinite(sentAt) || Math.abs(this.now() - sentAt) > MAX_MESSAGE_AGE_MS) {
      this.logger.warn({ messageId, timestamp }, 'Rejected stale EventSub delivery (possible replay)');
      return response(403, 'Forbidden');
    }

    let payload: EventSubDelivery;
    try {
      payload = JSON.parse(req.rawBody.toString('utf8')) as EventSubDelivery;
    } catch {
      return response(400, 'Bad Request');
    }

    if (messageType === 'webhook_callback_verification') {
      if (typeof payload.challenge !== 'string' || payload.challenge === '') return response(400, 'Bad Request');
      this.logger.info({ type: payload.subscription?.type, id: payload.subscription?.id }, 'Confirmed EventSub subscription callback');
      return response(200, payload.challenge);
    }

    // Delivery is at-least-once: acknowledge redeliveries without acting on them twice.
    if (this.seenMessages.has(messageId)) return response(204);
    this.seenMessages.add(messageId);

    if (messageType === 'notification') return response(204, undefined, this.toHints(payload));
    if (messageType === 'revocation') return response(204, undefined, this.onRevocation(payload));

    this.logger.debug({ messageType }, 'Ignoring unknown EventSub message type');
    return response(204);
  }

  private toHints(payload: EventSubDelivery): PushHint[] {
    const sub = payload.subscription;
    const fromEvent = payload.event?.broadcaster_user_id;
    const broadcasterId = typeof fromEvent === 'string' && fromEvent ? fromEvent : sub?.condition?.broadcaster_user_id;
    if (!sub || !broadcasterId) return [];

    const type: PushHint['type'] | null =
      sub.type === 'stream.online' ? 'live' : sub.type === 'stream.offline' ? 'offline' : sub.type === 'channel.update' ? 'metadata' : null;
    if (!type) {
      this.logger.debug({ type: sub.type }, 'Ignoring EventSub notification of an unhandled type');
      return [];
    }
    this.logger.debug({ type: sub.type, broadcasterId }, 'EventSub notification');
    return [{ type, platform: 'twitch', platformId: broadcasterId }];
  }

  private onRevocation(payload: EventSubDelivery): PushHint[] {
    const sub = payload.subscription;
    const broadcasterId = sub?.condition?.broadcaster_user_id ?? null;
    const revocation: EventSubRevocation = {
      at: new Date(this.now()).toISOString(),
      type: sub?.type ?? 'unknown',
      status: sub?.status ?? 'unknown',
      broadcasterId,
    };
    this.revocations.unshift(revocation);
    this.revocations.length = Math.min(this.revocations.length, MAX_REMEMBERED_REVOCATIONS);
    this.logger.warn(revocation, 'Twitch revoked an EventSub subscription');

    // Delivery failures (e.g. our server was down) are recoverable: recreate soon instead of waiting for
    // the next periodic sync. Other reasons (user_removed, version_removed) would just fail again.
    if (revocation.status === 'notification_failures_exceeded') this.scheduleResync();

    // We may have missed transitions while the subscription was failing: ask for a fresh check.
    return broadcasterId ? [{ type: 'metadata', platform: 'twitch', platformId: broadcasterId }] : [];
  }

  private scheduleResync(): void {
    if (this.resyncTimer || !this.latestChannels) return;
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      if (this.latestChannels) void this.sync(this.latestChannels);
    }, this.opts.resyncDelayMs ?? DEFAULT_RESYNC_DELAY_MS);
    this.resyncTimer.unref?.();
  }

  // ─────────────── subscription sync ───────────────

  /**
   * Reconciles remote subscriptions with `channels`. Concurrent calls are coalesced: a call made while a
   * sync runs schedules one more pass with the latest channel list and resolves when that pass is done.
   */
  sync(channels: ChannelRef[]): Promise<void> {
    this.latestChannels = channels;
    if (this.syncRun) {
      this.syncDirty = true;
      return this.syncRun;
    }
    this.syncRun = (async () => {
      try {
        do {
          this.syncDirty = false;
          await this.runSync(this.latestChannels ?? []);
        } while (this.syncDirty);
      } finally {
        this.syncRun = null;
      }
    })();
    return this.syncRun;
  }

  private async runSync(channels: ChannelRef[]): Promise<void> {
    const startedAt = this.now();
    const desired = new Set(channels.filter((c) => c.platform === 'twitch' && TWITCH_ID_RE.test(c.platformId)).map((c) => c.platformId));
    const status: EventSubSyncStatus = {
      at: new Date(startedAt).toISOString(),
      channels: desired.size,
      active: 0,
      created: 0,
      deleted: 0,
      failed: 0,
      totalCost: null,
      maxTotalCost: null,
      limitReached: false,
      error: null,
    };

    try {
      const listing = await this.listOwnSubscriptions();
      status.totalCost = listing.totalCost;
      status.maxTotalCost = listing.maxTotalCost;

      // When the signing secret (or callback) changed, existing subscriptions would deliver messages we
      // can no longer verify, so they all have to be recreated.
      const fingerprint = this.fingerprint();
      const credentialsChanged = this.readFingerprint() !== fingerprint;
      if (credentialsChanged && listing.subscriptions.length > 0) {
        this.logger.info({ count: listing.subscriptions.length }, 'EventSub secret/callback changed: recreating subscriptions');
      }

      const { keep, remove } = this.plan(listing.subscriptions, desired, credentialsChanged, startedAt);
      const missing: Array<{ type: string; version: string; broadcasterId: string }> = [];
      for (const broadcasterId of desired) {
        for (const spec of EVENTSUB_SUBSCRIPTIONS) {
          if (!keep.has(subscriptionKey(spec.type, spec.version, broadcasterId))) missing.push({ ...spec, broadcasterId });
        }
      }

      let deleteFailures = 0;
      await runPool(remove, SYNC_CONCURRENCY, async (sub) => {
        if (await this.deleteSubscription(sub)) status.deleted++;
        else deleteFailures++;
      });

      let existed = 0;
      let createFailures = 0;
      let skipped = 0;
      await runPool(missing, SYNC_CONCURRENCY, async (spec) => {
        // Once Twitch says we hit a limit, further creates would fail the same way.
        if (status.limitReached) {
          skipped++;
          return;
        }
        const outcome = await this.createSubscription(spec.type, spec.version, spec.broadcasterId);
        if (outcome === 'created') status.created++;
        else if (outcome === 'exists') existed++;
        else if (outcome === 'limit') {
          status.limitReached = true;
          skipped++;
        } else createFailures++;
      });

      status.active = keep.size + status.created + existed;
      status.failed = deleteFailures + createFailures + skipped;
      if (deleteFailures === 0) this.writeFingerprint(fingerprint);

      const level = status.failed > 0 || status.limitReached ? 'warn' : 'info';
      this.logger[level]({ ...status, tookMs: this.now() - startedAt }, 'EventSub subscriptions synced');
    } catch (err) {
      status.error = errorMessage(err);
      this.logger.error({ err: status.error }, 'EventSub sync failed; relying on polling until the next sync');
    }
    this.lastSync = status;
  }

  private plan(
    subscriptions: EventSubSubscription[],
    desired: ReadonlySet<string>,
    recreateAll: boolean,
    now: number,
  ): { keep: Map<string, EventSubSubscription>; remove: EventSubSubscription[] } {
    const keep = new Map<string, EventSubSubscription>();
    const remove: EventSubSubscription[] = [];
    for (const sub of subscriptions) {
      const broadcasterId = sub.condition?.broadcaster_user_id;
      const wanted =
        !!broadcasterId &&
        desired.has(broadcasterId) &&
        EVENTSUB_SUBSCRIPTIONS.some((spec) => spec.type === sub.type && spec.version === sub.version);
      if (!wanted || recreateAll) {
        remove.push(sub);
        continue;
      }
      const key = subscriptionKey(sub.type, sub.version, broadcasterId);
      const createdAt = sub.created_at ? Date.parse(sub.created_at) : Number.NaN;
      const healthy =
        sub.status === 'enabled' ||
        (sub.status === 'webhook_callback_verification_pending' && Number.isFinite(createdAt) && now - createdAt < PENDING_VERIFICATION_GRACE_MS);
      if (healthy && !keep.has(key)) keep.set(key, sub);
      else remove.push(sub); // failed / revoked / stuck pending / duplicate → recreate
    }
    return { keep, remove };
  }

  private async listOwnSubscriptions(): Promise<{
    subscriptions: EventSubSubscription[];
    totalCost: number | null;
    maxTotalCost: number | null;
  }> {
    const subscriptions: EventSubSubscription[] = [];
    let totalCost: number | null = null;
    let maxTotalCost: number | null = null;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const { data } = await this.opts.api.request<EventSubListPage>('/eventsub/subscriptions', { query: { after: cursor } });
      totalCost = typeof data?.total_cost === 'number' ? data.total_cost : totalCost;
      maxTotalCost = typeof data?.max_total_cost === 'number' ? data.max_total_cost : maxTotalCost;
      for (const sub of data?.data ?? []) {
        // Other deployments may share this Client ID: only manage subscriptions pointing at our callback.
        if (sub.transport?.method === 'webhook' && sub.transport.callback === this.opts.callbackUrl) subscriptions.push(sub);
      }
      cursor = data?.pagination?.cursor || undefined;
      if (!cursor || !data?.data?.length) break;
    }
    return { subscriptions, totalCost, maxTotalCost };
  }

  private async deleteSubscription(sub: EventSubSubscription): Promise<boolean> {
    try {
      await this.opts.api.request('/eventsub/subscriptions', { method: 'DELETE', query: { id: sub.id }, allow404: true });
      this.logger.debug({ id: sub.id, type: sub.type, status: sub.status }, 'Deleted EventSub subscription');
      return true;
    } catch (err) {
      this.logger.warn({ id: sub.id, type: sub.type, err: errorMessage(err) }, 'Could not delete EventSub subscription');
      return false;
    }
  }

  private async createSubscription(
    type: string,
    version: string,
    broadcasterId: string,
  ): Promise<'created' | 'exists' | 'limit' | 'failed'> {
    try {
      const { status, data } = await this.opts.api.request<{ message?: string }>('/eventsub/subscriptions', {
        method: 'POST',
        body: {
          type,
          version,
          condition: { broadcaster_user_id: broadcasterId },
          transport: { method: 'webhook', callback: this.opts.callbackUrl, secret: this.opts.secret },
        },
        okStatuses: [409, 429],
      });
      if (status === 409) return 'exists';
      if (status === 429) {
        this.logger.warn({ type, broadcasterId, message: data?.message }, 'Twitch refused new EventSub subscriptions (limit reached)');
        return 'limit';
      }
      return 'created';
    } catch (err) {
      if (err instanceof RateLimitedError) {
        this.logger.warn({ retryAfterMs: err.retryAfterMs }, 'Helix rate limit hit while creating EventSub subscriptions; continuing next sync');
        return 'limit';
      }
      this.logger.warn({ type, broadcasterId, err: errorMessage(err) }, 'Could not create EventSub subscription');
      return 'failed';
    }
  }

  private fingerprint(): string {
    return createHash('sha256').update(`${this.opts.secret}\n${this.opts.callbackUrl}`).digest('hex').slice(0, 32);
  }

  private readFingerprint(): string | undefined {
    try {
      return this.opts.kv.get<string>(FINGERPRINT_KV_KEY);
    } catch {
      return undefined;
    }
  }

  private writeFingerprint(value: string): void {
    try {
      this.opts.kv.set(FINGERPRINT_KV_KEY, value);
    } catch (err) {
      this.logger.warn({ err: errorMessage(err) }, 'Could not persist EventSub fingerprint');
    }
  }
}
