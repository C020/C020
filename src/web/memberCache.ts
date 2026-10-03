import { childLogger, type Logger } from '../core/logger.js';
import type { DiscordGateway, DiscordMemberInfo } from '../services/ports.js';

/** Result of a member lookup: found, confirmed absent, or unknown (gateway not ready / lookup failed). */
export type MemberLookup = { status: 'member'; member: DiscordMemberInfo } | { status: 'absent' } | { status: 'unknown' };

interface Entry {
  value: MemberLookup;
  expiresAt: number;
}

export interface MemberCacheOptions {
  ttlMs?: number;
  /** Shorter TTL for "not a member" (people join) and failed lookups (Discord recovers). */
  negativeTtlMs?: number;
  maxEntries?: number;
  concurrency?: number;
  now?: () => number;
  logger?: Logger;
}

const UNKNOWN: MemberLookup = { status: 'unknown' };

/**
 * Small TTL cache in front of DiscordGateway.fetchMember so dashboard lists can show avatars and
 * "still in guild" without a Discord request per row on every page load.
 */
export class MemberCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<MemberLookup>>();
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly maxEntries: number;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(
    private readonly gateway: DiscordGateway,
    options: MemberCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.negativeTtlMs = options.negativeTtlMs ?? 60_000;
    this.maxEntries = options.maxEntries ?? 5000;
    this.concurrency = options.concurrency ?? 4;
    this.now = options.now ?? Date.now;
    this.log = options.logger ?? childLogger('web.members');
  }

  /** Cached value without any Discord call (unknown when not cached or expired). */
  peek(guildId: string, userId: string): MemberLookup {
    const entry = this.entries.get(key(guildId, userId));
    if (!entry || entry.expiresAt <= this.now()) return UNKNOWN;
    return entry.value;
  }

  /** Cached or fetched lookup. Never throws. */
  get(guildId: string, userId: string): Promise<MemberLookup> {
    const k = key(guildId, userId);
    const entry = this.entries.get(k);
    if (entry && entry.expiresAt > this.now()) return Promise.resolve(entry.value);
    const pending = this.inflight.get(k);
    if (pending) return pending;
    const promise = this.fetch(guildId, userId).finally(() => this.inflight.delete(k));
    this.inflight.set(k, promise);
    return promise;
  }

  /**
   * Fetches the given members (bounded concurrency) but waits at most `budgetMs`; lookups still running
   * keep filling the cache in the background for the next request.
   */
  async warm(guildId: string, userIds: string[], budgetMs: number): Promise<void> {
    const missing = [...new Set(userIds)].filter((id) => this.peek(guildId, id).status === 'unknown' && !this.isFresh(guildId, id));
    if (missing.length === 0 || !this.gateway.isReady()) return;
    const queue = [...missing];
    const worker = async (): Promise<void> => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) await this.get(guildId, id);
    };
    const all = Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, worker));
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs);
      timer.unref();
    });
    await Promise.race([all, budget]);
    clearTimeout(timer);
  }

  /** Lookup with a deadline: unknown when Discord is slower than `budgetMs`. */
  async getWithin(guildId: string, userId: string, budgetMs: number): Promise<MemberLookup> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<MemberLookup>((resolve) => {
      timer = setTimeout(() => resolve(UNKNOWN), budgetMs);
      timer.unref();
    });
    const result = await Promise.race([this.get(guildId, userId), timeout]);
    clearTimeout(timer);
    return result;
  }

  invalidate(guildId: string, userId: string): void {
    this.entries.delete(key(guildId, userId));
  }

  private isFresh(guildId: string, userId: string): boolean {
    const entry = this.entries.get(key(guildId, userId));
    return !!entry && entry.expiresAt > this.now();
  }

  private async fetch(guildId: string, userId: string): Promise<MemberLookup> {
    if (!this.gateway.isReady()) return UNKNOWN;
    let value: MemberLookup;
    try {
      const member = await this.gateway.fetchMember(guildId, userId);
      value = member ? { status: 'member', member } : { status: 'absent' };
    } catch (err) {
      this.log.debug({ err, guildId, userId }, 'Member lookup failed');
      value = UNKNOWN;
    }
    this.store(key(guildId, userId), value);
    return value;
  }

  private store(k: string, value: MemberLookup): void {
    const ttl = value.status === 'member' ? this.ttlMs : this.negativeTtlMs;
    this.entries.delete(k);
    this.entries.set(k, { value, expiresAt: this.now() + ttl });
    // Map keeps insertion order, so the first keys are the oldest.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

function key(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}
