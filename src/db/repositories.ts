import type { SQLInputValue } from 'node:sqlite';
import type { ContentItem, ContentKind, LiveSnapshot, Platform, ResolvedChannel } from '../core/types.js';
import type { KeyValueStore } from '../platforms/types.js';
import { type Db, nowIso, parseJson, transaction } from './database.js';
import {
  type AccountWithChannel,
  type AuditEntry,
  type AuditLevel,
  type Channel,
  type ChannelSubscriber,
  DEFAULT_GUILD_OPTIONS,
  defaultGuildSettings,
  type GuildSettings,
  type GuildSettingsPatch,
  type LiveSegment,
  type LiveSession,
  type SessionCategory,
  type StoredContentItem,
  type Streamer,
  type StreamerAccount,
  type StreamerWithAccounts,
  type WebSession,
  type WebSessionGuild,
} from './models.js';

type Row = Record<string, SQLInputValue>;
const b = (v: unknown): boolean => v === 1 || v === true || v === 1n;
const n = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : (v as number));
const s = (v: unknown): string | null => (v == null ? null : String(v));

// ───────────────────────────── row mappers ─────────────────────────────

function mapSettings(r: Row): GuildSettings {
  return {
    guildId: String(r.guild_id),
    streamerRoleId: s(r.streamer_role_id),
    liveRoleId: s(r.live_role_id),
    liveChannelId: s(r.live_channel_id),
    contentChannelId: s(r.content_channel_id),
    logChannelId: s(r.log_channel_id),
    pingMode: (s(r.ping_mode) ?? 'none') as GuildSettings['pingMode'],
    pingRoleId: s(r.ping_role_id),
    platformsEnabled: parseJson<Platform[]>(s(r.platforms_enabled), []),
    contentKinds: parseJson<ContentKind[]>(s(r.content_kinds), []),
    templates: parseJson(s(r.templates), {}),
    options: { ...DEFAULT_GUILD_OPTIONS, ...parseJson(s(r.options), {}) },
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapStreamer(r: Row): Streamer {
  return {
    id: n(r.id),
    guildId: String(r.guild_id),
    discordUserId: String(r.discord_user_id),
    displayName: String(r.display_name),
    notes: s(r.notes),
    color: r.color == null ? null : n(r.color),
    enabled: b(r.enabled),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapChannel(r: Row, prefix = ''): Channel {
  const g = (k: string) => r[prefix + k];
  return {
    id: n(g('id')),
    platform: String(g('platform')) as Platform,
    platformId: String(g('platform_id')),
    handle: String(g('handle')),
    displayName: String(g('display_name')),
    avatarUrl: s(g('avatar_url')),
    url: String(g('url')),
    meta: parseJson(s(g('meta')), {}),
    isLive: b(g('is_live')),
    liveSnapshot: parseJson<LiveSnapshot | null>(s(g('live_snapshot')), null),
    liveSince: s(g('live_since')),
    offlineSince: s(g('offline_since')),
    missCount: n(g('miss_count') ?? 0),
    lastLiveCheckAt: s(g('last_live_check_at')),
    contentSeeded: b(g('content_seeded')),
    lastContentCheckAt: s(g('last_content_check_at')),
    lastError: s(g('last_error')),
    errorCount: n(g('error_count') ?? 0),
    createdAt: String(g('created_at')),
    updatedAt: String(g('updated_at')),
  };
}

function mapAccount(r: Row, prefix = ''): StreamerAccount {
  const g = (k: string) => r[prefix + k];
  const kinds = s(g('content_kinds'));
  return {
    id: n(g('id')),
    streamerId: n(g('streamer_id')),
    channelId: n(g('channel_id')),
    notifyLive: b(g('notify_live')),
    notifyContent: b(g('notify_content')),
    contentKinds: kinds == null ? null : parseJson<ContentKind[]>(kinds, []),
    createdAt: String(g('created_at')),
  };
}

function mapSession(r: Row): LiveSession {
  return {
    id: n(r.id),
    guildId: String(r.guild_id),
    streamerId: n(r.streamer_id),
    status: String(r.status) as LiveSession['status'],
    startedAt: String(r.started_at),
    endedAt: s(r.ended_at),
    messageChannelId: s(r.message_channel_id),
    messageId: s(r.message_id),
    peakViewers: n(r.peak_viewers),
    viewerSum: n(r.viewer_sum),
    viewerSamples: n(r.viewer_samples),
    categories: parseJson<SessionCategory[]>(s(r.categories), []),
    titles: parseJson<string[]>(s(r.titles), []),
    lastMessageUpdate: s(r.last_message_update),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapSegment(r: Row): LiveSegment {
  return {
    id: n(r.id),
    sessionId: n(r.session_id),
    channelId: n(r.channel_id),
    platform: String(r.platform) as Platform,
    streamId: s(r.stream_id),
    startedAt: String(r.started_at),
    endedAt: s(r.ended_at),
    peakViewers: n(r.peak_viewers),
    lastViewers: r.last_viewers == null ? null : n(r.last_viewers),
    vodUrl: s(r.vod_url),
  };
}

function mapContent(r: Row): StoredContentItem {
  return {
    id: n(r.id),
    channelId: n(r.channel_id),
    contentId: String(r.content_id),
    kind: String(r.kind) as ContentKind,
    title: String(r.title),
    url: String(r.url),
    thumbnailUrl: s(r.thumbnail_url),
    publishedAt: String(r.published_at),
    firstSeenAt: String(r.first_seen_at),
    announced: b(r.announced),
  };
}

function mapAudit(r: Row): AuditEntry {
  return {
    id: n(r.id),
    guildId: s(r.guild_id),
    actor: String(r.actor),
    action: String(r.action),
    level: String(r.level) as AuditLevel,
    message: String(r.message),
    details: parseJson(s(r.details), {}),
    createdAt: String(r.created_at),
  };
}

function mapWebSession(r: Row): WebSession {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    username: String(r.username),
    avatarUrl: s(r.avatar_url),
    guilds: parseJson<WebSessionGuild[]>(s(r.guilds), []),
    guildsRefreshedAt: String(r.guilds_refreshed_at),
    accessToken: s(r.access_token),
    createdAt: String(r.created_at),
    expiresAt: String(r.expires_at),
  };
}

// ───────────────────────────── repositories ─────────────────────────────

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  /** Returns settings, creating defaults on first access. */
  get(guildId: string): GuildSettings {
    const row = this.db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId) as Row | undefined;
    if (row) return mapSettings(row);
    const def = defaultGuildSettings(guildId, nowIso());
    this.db
      .prepare(
        `INSERT OR IGNORE INTO guild_settings (guild_id, platforms_enabled, content_kinds, templates, options, created_at, updated_at)
         VALUES (?, ?, ?, '{}', ?, ?, ?)`,
      )
      .run(guildId, JSON.stringify(def.platformsEnabled), JSON.stringify(def.contentKinds), JSON.stringify(def.options), def.createdAt, def.updatedAt);
    return mapSettings(this.db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId) as Row);
  }

  listGuildIds(): string[] {
    return (this.db.prepare('SELECT guild_id FROM guild_settings').all() as Row[]).map((r) => String(r.guild_id));
  }

  update(guildId: string, patch: GuildSettingsPatch): GuildSettings {
    const cur = this.get(guildId);
    const next: GuildSettings = {
      ...cur,
      ...Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && k !== 'options')),
      options: { ...cur.options, ...(patch.options ?? {}) },
      updatedAt: nowIso(),
    } as GuildSettings;
    this.db
      .prepare(
        `UPDATE guild_settings SET streamer_role_id=?, live_role_id=?, live_channel_id=?, content_channel_id=?, log_channel_id=?,
           ping_mode=?, ping_role_id=?, platforms_enabled=?, content_kinds=?, templates=?, options=?, updated_at=? WHERE guild_id=?`,
      )
      .run(
        next.streamerRoleId,
        next.liveRoleId,
        next.liveChannelId,
        next.contentChannelId,
        next.logChannelId,
        next.pingMode,
        next.pingRoleId,
        JSON.stringify(next.platformsEnabled),
        JSON.stringify(next.contentKinds),
        JSON.stringify(next.templates),
        JSON.stringify(next.options),
        next.updatedAt,
        guildId,
      );
    return next;
  }
}

export class StreamerRepo {
  constructor(private readonly db: Db) {}

  get(id: number): Streamer | null {
    const r = this.db.prepare('SELECT * FROM streamers WHERE id = ?').get(id) as Row | undefined;
    return r ? mapStreamer(r) : null;
  }

  getByDiscordId(guildId: string, discordUserId: string): Streamer | null {
    const r = this.db.prepare('SELECT * FROM streamers WHERE guild_id = ? AND discord_user_id = ?').get(guildId, discordUserId) as Row | undefined;
    return r ? mapStreamer(r) : null;
  }

  list(guildId: string): Streamer[] {
    return (this.db.prepare('SELECT * FROM streamers WHERE guild_id = ? ORDER BY display_name COLLATE NOCASE').all(guildId) as Row[]).map(mapStreamer);
  }

  listAll(): Streamer[] {
    return (this.db.prepare('SELECT * FROM streamers').all() as Row[]).map(mapStreamer);
  }

  create(input: { guildId: string; discordUserId: string; displayName: string; notes?: string | null; color?: number | null; enabled?: boolean }): Streamer {
    const now = nowIso();
    const res = this.db
      .prepare(
        'INSERT INTO streamers (guild_id, discord_user_id, display_name, notes, color, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(input.guildId, input.discordUserId, input.displayName, input.notes ?? null, input.color ?? null, input.enabled === false ? 0 : 1, now, now);
    return this.get(n(res.lastInsertRowid))!;
  }

  update(id: number, patch: Partial<Pick<Streamer, 'displayName' | 'notes' | 'color' | 'enabled'>>): Streamer | null {
    const cur = this.get(id);
    if (!cur) return null;
    const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Streamer;
    this.db
      .prepare('UPDATE streamers SET display_name=?, notes=?, color=?, enabled=?, updated_at=? WHERE id=?')
      .run(next.displayName, next.notes, next.color, next.enabled ? 1 : 0, nowIso(), id);
    return this.get(id);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM streamers WHERE id = ?').run(id);
  }
}

export class ChannelRepo {
  constructor(private readonly db: Db) {}

  get(id: number): Channel | null {
    const r = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as Row | undefined;
    return r ? mapChannel(r) : null;
  }

  getByPlatformId(platform: Platform, platformId: string): Channel | null {
    const r = this.db.prepare('SELECT * FROM channels WHERE platform = ? AND platform_id = ?').get(platform, platformId) as Row | undefined;
    return r ? mapChannel(r) : null;
  }

  /** Channels linked to at least one enabled streamer (with optional platform filter). */
  listTracked(platform?: Platform): Channel[] {
    const sql = `SELECT DISTINCT c.* FROM channels c
      JOIN streamer_accounts a ON a.channel_id = c.id
      JOIN streamers st ON st.id = a.streamer_id AND st.enabled = 1
      ${platform ? 'WHERE c.platform = ?' : ''} ORDER BY c.id`;
    const rows = (platform ? this.db.prepare(sql).all(platform) : this.db.prepare(sql).all()) as Row[];
    return rows.map((r) => mapChannel(r));
  }

  listAll(): Channel[] {
    return (this.db.prepare('SELECT * FROM channels ORDER BY id').all() as Row[]).map((r) => mapChannel(r));
  }

  /** Insert or refresh identity fields of a resolved channel. Returns the stored channel. */
  upsertResolved(rc: ResolvedChannel): Channel {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO channels (platform, platform_id, handle, display_name, avatar_url, url, meta, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(platform, platform_id) DO UPDATE SET handle=excluded.handle, display_name=excluded.display_name,
           avatar_url=excluded.avatar_url, url=excluded.url, meta=excluded.meta, updated_at=excluded.updated_at`,
      )
      .run(rc.platform, rc.platformId, rc.handle, rc.displayName, rc.avatarUrl, rc.url, JSON.stringify(rc.meta ?? {}), now, now);
    return this.getByPlatformId(rc.platform, rc.platformId)!;
  }

  updateMeta(id: number, meta: Record<string, unknown>): void {
    this.db.prepare('UPDATE channels SET meta = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(meta), nowIso(), id);
  }

  /** Persist the live-monitor state of a channel. */
  saveLiveState(
    id: number,
    state: { isLive: boolean; snapshot: LiveSnapshot | null; liveSince: string | null; offlineSince: string | null; missCount: number },
  ): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE channels SET is_live=?, live_snapshot=?, live_since=?, offline_since=?, miss_count=?, last_live_check_at=?,
           last_error=NULL, error_count=0, updated_at=? WHERE id=?`,
      )
      .run(state.isLive ? 1 : 0, state.snapshot ? JSON.stringify(state.snapshot) : null, state.liveSince, state.offlineSince, state.missCount, now, now, id);
  }

  recordError(id: number, message: string): void {
    this.db
      .prepare('UPDATE channels SET last_error=?, error_count=error_count+1, last_live_check_at=?, updated_at=? WHERE id=?')
      .run(message.slice(0, 500), nowIso(), nowIso(), id);
  }

  markContentChecked(id: number, seeded: boolean): void {
    this.db.prepare('UPDATE channels SET last_content_check_at=?, content_seeded=?, updated_at=? WHERE id=?').run(nowIso(), seeded ? 1 : 0, nowIso(), id);
  }

  /** Remove channels no account references anymore. Returns deleted ids. */
  deleteOrphans(): number[] {
    const rows = this.db.prepare('SELECT id FROM channels WHERE id NOT IN (SELECT DISTINCT channel_id FROM streamer_accounts)').all() as Row[];
    const ids = rows.map((r) => n(r.id));
    for (const id of ids) this.db.prepare('DELETE FROM channels WHERE id = ?').run(id);
    return ids;
  }
}

export class AccountRepo {
  constructor(private readonly db: Db) {}

  private readonly joinSql = `SELECT a.id AS a_id, a.streamer_id AS a_streamer_id, a.channel_id AS a_channel_id, a.notify_live AS a_notify_live,
      a.notify_content AS a_notify_content, a.content_kinds AS a_content_kinds, a.created_at AS a_created_at, c.*
    FROM streamer_accounts a JOIN channels c ON c.id = a.channel_id`;

  private mapJoined(r: Row): AccountWithChannel {
    return { ...mapAccount(r, 'a_'), channel: mapChannel(r) };
  }

  get(id: number): AccountWithChannel | null {
    const r = this.db.prepare(`${this.joinSql} WHERE a.id = ?`).get(id) as Row | undefined;
    return r ? this.mapJoined(r) : null;
  }

  listForStreamer(streamerId: number): AccountWithChannel[] {
    return (this.db.prepare(`${this.joinSql} WHERE a.streamer_id = ? ORDER BY c.platform`).all(streamerId) as Row[]).map((r) => this.mapJoined(r));
  }

  create(input: { streamerId: number; channelId: number; notifyLive?: boolean; notifyContent?: boolean; contentKinds?: ContentKind[] | null }): AccountWithChannel {
    const res = this.db
      .prepare(
        `INSERT INTO streamer_accounts (streamer_id, channel_id, notify_live, notify_content, content_kinds, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(streamer_id, channel_id) DO UPDATE SET notify_live=excluded.notify_live, notify_content=excluded.notify_content,
           content_kinds=excluded.content_kinds`,
      )
      .run(
        input.streamerId,
        input.channelId,
        input.notifyLive === false ? 0 : 1,
        input.notifyContent === false ? 0 : 1,
        input.contentKinds ? JSON.stringify(input.contentKinds) : null,
        nowIso(),
      );
    const id =
      n(res.lastInsertRowid) ||
      n((this.db.prepare('SELECT id FROM streamer_accounts WHERE streamer_id=? AND channel_id=?').get(input.streamerId, input.channelId) as Row).id);
    return this.get(id) ?? this.getByPair(input.streamerId, input.channelId)!;
  }

  getByPair(streamerId: number, channelId: number): AccountWithChannel | null {
    const r = this.db.prepare(`${this.joinSql} WHERE a.streamer_id = ? AND a.channel_id = ?`).get(streamerId, channelId) as Row | undefined;
    return r ? this.mapJoined(r) : null;
  }

  update(id: number, patch: { notifyLive?: boolean; notifyContent?: boolean; contentKinds?: ContentKind[] | null }): AccountWithChannel | null {
    const cur = this.get(id);
    if (!cur) return null;
    const kinds = patch.contentKinds === undefined ? cur.contentKinds : patch.contentKinds;
    this.db
      .prepare('UPDATE streamer_accounts SET notify_live=?, notify_content=?, content_kinds=? WHERE id=?')
      .run(
        (patch.notifyLive ?? cur.notifyLive) ? 1 : 0,
        (patch.notifyContent ?? cur.notifyContent) ? 1 : 0,
        kinds ? JSON.stringify(kinds) : null,
        id,
      );
    return this.get(id);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM streamer_accounts WHERE id = ?').run(id);
  }

  /** Every enabled (guild, streamer, account) that tracks the channel. */
  subscribersOf(channelId: number): ChannelSubscriber[] {
    const rows = this.db
      .prepare(
        `SELECT st.*, a.id AS a_id, a.streamer_id AS a_streamer_id, a.channel_id AS a_channel_id, a.notify_live AS a_notify_live,
           a.notify_content AS a_notify_content, a.content_kinds AS a_content_kinds, a.created_at AS a_created_at
         FROM streamer_accounts a JOIN streamers st ON st.id = a.streamer_id
         WHERE a.channel_id = ? AND st.enabled = 1`,
      )
      .all(channelId) as Row[];
    return rows.map((r) => ({ guildId: String(r.guild_id), streamer: mapStreamer(r), account: mapAccount(r, 'a_') }));
  }
}

export class SessionRepo {
  constructor(private readonly db: Db) {}

  get(id: number): LiveSession | null {
    const r = this.db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(id) as Row | undefined;
    return r ? mapSession(r) : null;
  }

  /** The current live session of a streamer, if any. */
  getActive(streamerId: number): LiveSession | null {
    const r = this.db.prepare("SELECT * FROM live_sessions WHERE streamer_id = ? AND status = 'live' ORDER BY id DESC LIMIT 1").get(streamerId) as
      | Row
      | undefined;
    return r ? mapSession(r) : null;
  }

  /** The most recent ended session that ended after `sinceIso` (for reconnect merging). */
  getRecentlyEnded(streamerId: number, sinceIso: string): LiveSession | null {
    const r = this.db
      .prepare("SELECT * FROM live_sessions WHERE streamer_id = ? AND status = 'ended' AND ended_at >= ? ORDER BY id DESC LIMIT 1")
      .get(streamerId, sinceIso) as Row | undefined;
    return r ? mapSession(r) : null;
  }

  listActive(guildId?: string): LiveSession[] {
    const rows = (
      guildId
        ? this.db.prepare("SELECT * FROM live_sessions WHERE status = 'live' AND guild_id = ? ORDER BY started_at").all(guildId)
        : this.db.prepare("SELECT * FROM live_sessions WHERE status = 'live' ORDER BY started_at").all()
    ) as Row[];
    return rows.map(mapSession);
  }

  listRecent(guildId: string, limit = 50, offset = 0): LiveSession[] {
    return (this.db.prepare('SELECT * FROM live_sessions WHERE guild_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?').all(guildId, limit, offset) as Row[]).map(
      mapSession,
    );
  }

  create(input: { guildId: string; streamerId: number; startedAt: string }): LiveSession {
    const now = nowIso();
    const res = this.db
      .prepare("INSERT INTO live_sessions (guild_id, streamer_id, status, started_at, created_at, updated_at) VALUES (?, ?, 'live', ?, ?, ?)")
      .run(input.guildId, input.streamerId, input.startedAt, now, now);
    return this.get(n(res.lastInsertRowid))!;
  }

  save(session: LiveSession): void {
    this.db
      .prepare(
        `UPDATE live_sessions SET status=?, started_at=?, ended_at=?, message_channel_id=?, message_id=?, peak_viewers=?, viewer_sum=?, viewer_samples=?,
           categories=?, titles=?, last_message_update=?, updated_at=? WHERE id=?`,
      )
      .run(
        session.status,
        session.startedAt,
        session.endedAt,
        session.messageChannelId,
        session.messageId,
        session.peakViewers,
        session.viewerSum,
        session.viewerSamples,
        JSON.stringify(session.categories),
        JSON.stringify(session.titles),
        session.lastMessageUpdate,
        nowIso(),
        session.id,
      );
  }

  // segments
  segments(sessionId: number): LiveSegment[] {
    return (this.db.prepare('SELECT * FROM live_segments WHERE session_id = ? ORDER BY started_at').all(sessionId) as Row[]).map(mapSegment);
  }

  openSegment(sessionId: number, channelId: number): LiveSegment | null {
    const r = this.db.prepare('SELECT * FROM live_segments WHERE session_id = ? AND channel_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1').get(sessionId, channelId) as
      | Row
      | undefined;
    return r ? mapSegment(r) : null;
  }

  addSegment(input: { sessionId: number; channelId: number; platform: Platform; streamId: string | null; startedAt: string; viewers: number | null }): LiveSegment {
    const res = this.db
      .prepare('INSERT INTO live_segments (session_id, channel_id, platform, stream_id, started_at, peak_viewers, last_viewers) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.sessionId, input.channelId, input.platform, input.streamId, input.startedAt, input.viewers ?? 0, input.viewers);
    return mapSegment(this.db.prepare('SELECT * FROM live_segments WHERE id = ?').get(n(res.lastInsertRowid)) as Row);
  }

  saveSegment(seg: LiveSegment): void {
    this.db
      .prepare('UPDATE live_segments SET stream_id=?, started_at=?, ended_at=?, peak_viewers=?, last_viewers=?, vod_url=? WHERE id=?')
      .run(seg.streamId, seg.startedAt, seg.endedAt, seg.peakViewers, seg.lastViewers, seg.vodUrl, seg.id);
  }

  /** Total streamed seconds per streamer in a guild since `sinceIso` (for stats/leaderboards). */
  totals(guildId: string, sinceIso: string): { streamerId: number; seconds: number; sessions: number; peakViewers: number }[] {
    const rows = this.db
      .prepare(
        `SELECT streamer_id, COUNT(*) AS sessions, MAX(peak_viewers) AS peak,
           SUM((julianday(COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))) - julianday(started_at)) * 86400) AS secs
         FROM live_sessions WHERE guild_id = ? AND started_at >= ? GROUP BY streamer_id ORDER BY secs DESC`,
      )
      .all(guildId, sinceIso) as Row[];
    return rows.map((r) => ({ streamerId: n(r.streamer_id), seconds: Math.round(Number(r.secs ?? 0)), sessions: n(r.sessions), peakViewers: n(r.peak ?? 0) }));
  }
}

export class ContentRepo {
  constructor(private readonly db: Db) {}

  has(channelId: number, contentId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM content_items WHERE channel_id = ? AND content_id = ?').get(channelId, contentId);
  }

  /** Inserts if new. Returns the stored item and whether it was newly inserted. */
  insert(channelId: number, item: ContentItem, announced: boolean): { item: StoredContentItem; inserted: boolean } {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO content_items (channel_id, content_id, kind, title, url, thumbnail_url, published_at, first_seen_at, announced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(channelId, item.contentId, item.kind, item.title, item.url, item.thumbnailUrl, item.publishedAt, nowIso(), announced ? 1 : 0);
    const row = this.db.prepare('SELECT * FROM content_items WHERE channel_id = ? AND content_id = ?').get(channelId, item.contentId) as Row;
    return { item: mapContent(row), inserted: n(res.changes) > 0 };
  }

  markAnnounced(id: number): void {
    this.db.prepare('UPDATE content_items SET announced = 1 WHERE id = ?').run(id);
  }

  recordNotification(input: { contentItemId: number; guildId: string; streamerId: number | null; messageChannelId: string | null; messageId: string | null }): boolean {
    const res = this.db
      .prepare(
        'INSERT OR IGNORE INTO content_notifications (content_item_id, guild_id, streamer_id, message_channel_id, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(input.contentItemId, input.guildId, input.streamerId, input.messageChannelId, input.messageId, nowIso());
    return n(res.changes) > 0;
  }

  wasNotified(contentItemId: number, guildId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM content_notifications WHERE content_item_id = ? AND guild_id = ?').get(contentItemId, guildId);
  }

  recentForGuild(guildId: string, limit = 30): (StoredContentItem & { streamerId: number | null })[] {
    const rows = this.db
      .prepare(
        `SELECT ci.*, cn.streamer_id AS cn_streamer_id FROM content_notifications cn JOIN content_items ci ON ci.id = cn.content_item_id
         WHERE cn.guild_id = ? ORDER BY cn.id DESC LIMIT ?`,
      )
      .all(guildId, limit) as Row[];
    return rows.map((r) => ({ ...mapContent(r), streamerId: r.cn_streamer_id == null ? null : n(r.cn_streamer_id) }));
  }

  /** Keep the table small: drop items older than N days that were never announced. */
  prune(olderThanDays = 90): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    return n(this.db.prepare('DELETE FROM content_items WHERE first_seen_at < ? AND id NOT IN (SELECT content_item_id FROM content_notifications)').run(cutoff).changes);
  }
}

export class AuditRepo {
  constructor(private readonly db: Db) {}

  add(entry: { guildId?: string | null; actor?: string; action: string; level?: AuditLevel; message: string; details?: Record<string, unknown> }): AuditEntry {
    const res = this.db
      .prepare('INSERT INTO audit_log (guild_id, actor, action, level, message, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(entry.guildId ?? null, entry.actor ?? 'system', entry.action, entry.level ?? 'info', entry.message, JSON.stringify(entry.details ?? {}), nowIso());
    return mapAudit(this.db.prepare('SELECT * FROM audit_log WHERE id = ?').get(n(res.lastInsertRowid)) as Row);
  }

  list(opts: { guildId?: string | null; limit?: number; beforeId?: number; level?: AuditLevel; actionPrefix?: string } = {}): AuditEntry[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.guildId !== undefined) {
      where.push('(guild_id = ? OR guild_id IS NULL)');
      params.push(opts.guildId);
    }
    if (opts.beforeId) {
      where.push('id < ?');
      params.push(opts.beforeId);
    }
    if (opts.level) {
      where.push('level = ?');
      params.push(opts.level);
    }
    if (opts.actionPrefix) {
      where.push('action LIKE ?');
      params.push(`${opts.actionPrefix}%`);
    }
    params.push(Math.min(opts.limit ?? 100, 500));
    const sql = `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(mapAudit);
  }

  prune(olderThanDays = 60): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    return n(this.db.prepare('DELETE FROM audit_log WHERE created_at < ?').run(cutoff).changes);
  }
}

export class WebSessionRepo {
  constructor(private readonly db: Db) {}

  get(id: string): WebSession | null {
    const r = this.db.prepare('SELECT * FROM web_sessions WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    const sess = mapWebSession(r);
    if (sess.expiresAt < nowIso()) {
      this.delete(id);
      return null;
    }
    return sess;
  }

  create(sess: Omit<WebSession, 'createdAt'>): WebSession {
    const now = nowIso();
    this.db
      .prepare(
        'INSERT INTO web_sessions (id, user_id, username, avatar_url, guilds, guilds_refreshed_at, access_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(sess.id, sess.userId, sess.username, sess.avatarUrl, JSON.stringify(sess.guilds), sess.guildsRefreshedAt, sess.accessToken, now, sess.expiresAt);
    return this.get(sess.id)!;
  }

  updateGuilds(id: string, guilds: WebSessionGuild[]): void {
    this.db.prepare('UPDATE web_sessions SET guilds = ?, guilds_refreshed_at = ? WHERE id = ?').run(JSON.stringify(guilds), nowIso(), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM web_sessions WHERE id = ?').run(id);
  }

  pruneExpired(): number {
    return n(this.db.prepare('DELETE FROM web_sessions WHERE expires_at < ?').run(nowIso()).changes);
  }
}

export class KvRepo implements KeyValueStore {
  constructor(private readonly db: Db) {}

  get<T = unknown>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined;
    return r ? parseJson<T | undefined>(String(r.value), undefined) : undefined;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run(key, JSON.stringify(value), nowIso());
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }
}

/** All repositories bundled. Construct once and pass around. */
export class Repositories {
  readonly settings: SettingsRepo;
  readonly streamers: StreamerRepo;
  readonly channels: ChannelRepo;
  readonly accounts: AccountRepo;
  readonly sessions: SessionRepo;
  readonly content: ContentRepo;
  readonly audit: AuditRepo;
  readonly webSessions: WebSessionRepo;
  readonly kv: KvRepo;

  constructor(readonly db: Db) {
    this.settings = new SettingsRepo(db);
    this.streamers = new StreamerRepo(db);
    this.channels = new ChannelRepo(db);
    this.accounts = new AccountRepo(db);
    this.sessions = new SessionRepo(db);
    this.content = new ContentRepo(db);
    this.audit = new AuditRepo(db);
    this.webSessions = new WebSessionRepo(db);
    this.kv = new KvRepo(db);
  }

  tx<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }

  /** Streamer with all accounts + channels. */
  streamerWithAccounts(id: number): StreamerWithAccounts | null {
    const st = this.streamers.get(id);
    return st ? { ...st, accounts: this.accounts.listForStreamer(id) } : null;
  }

  streamersWithAccounts(guildId: string): StreamerWithAccounts[] {
    return this.streamers.list(guildId).map((st) => ({ ...st, accounts: this.accounts.listForStreamer(st.id) }));
  }
}
