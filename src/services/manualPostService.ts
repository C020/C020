/**
 * #14 — manual posting of a clip/VOD link (optional; automatic detection remains the default).
 *
 * inspect(url) parses Kick / Twitch / YouTube / TikTok links, matches the registered streamer that owns the
 * channel when the URL (or the oEmbed author) names it, enriches title/thumbnail best effort (YouTube and TikTok
 * oEmbed, short timeout, failures ignored) and reports where the post would go (routing applied).
 *
 * post() stores the item under the matched channel (dedupe via content_notifications) and posts it through the
 * Notifier. When no registered channel matches, the post uses a synthetic channel built from the URL and the
 * dedupe marker lives in kv (`manual:posted:<guild>:<platform>:<contentId>`); contentItemId is then 0.
 */
import type { ManualPostPreview, ManualPostServiceApi } from '../app/context.js';
import { errorMessage, ValidationError } from '../core/errors.js';
import type { AppEvents } from '../core/events.js';
import { childLogger } from '../core/logger.js';
import type { ContentItem, ContentKind, Platform } from '../core/types.js';
import { isContentKind } from '../core/types.js';
import type { Channel, GuildSettings, Language, Streamer, StreamerWithAccounts } from '../db/models.js';
import type { Repositories } from '../db/repositories.js';
import { defineMessages } from '../discord/i18n/index.js';
import type { AuditService } from './audit.js';
import type { ContentView, MessageRef, Notifier } from './ports.js';
import { resolveContentChannelId } from './routing.js';

const log = childLogger('manual-posts');

export const MAX_MANUAL_URL_LENGTH = 500;
const MAX_TITLE_LENGTH = 256;
const OEMBED_TIMEOUT_MS = 5_000;
const INVISIBLE_CHARS_RE = /[­؜᠎​-‏‪-‮⁠-⁩﻿]/g;

export const manualPostMessages = defineMessages({
  disabled: { ar: 'النشر اليدوي مو مفعّل في هذا السيرفر (فعّله من لوحة التحكم)', en: 'Manual posting is not enabled on this server (enable it in the dashboard)' },
  badUrl: { ar: 'الرابط غير صحيح', en: 'Invalid link' },
  unsupported: {
    ar: 'الرابط غير مدعوم — أرسل رابط كليب أو فيديو من كيك، تويتش، يوتيوب أو تيك توك',
    en: 'Unsupported link — send a clip or video link from Kick, Twitch, YouTube or TikTok',
  },
  noChannel: { ar: 'ما فيه روم محتوى محدد لهذا النوع، حدده من الإعدادات', en: 'No content channel is set for this kind — set one in the settings' },
  alreadyPosted: { ar: 'هذا المقطع منشور من قبل في السيرفر', en: 'This content was already posted on this server' },
  streamerNotFound: { ar: 'الستريمر غير موجود', en: 'Streamer not found' },
  badKind: { ar: 'نوع المحتوى غير معروف', en: 'Unknown content kind' },
  postFailed: { ar: 'ما قدرت أرسل الرسالة — تأكد من صلاحيات البوت في روم المحتوى', en: "Couldn't send the message — check the bot's permissions in the content channel" },
  defaultTitleClip: { ar: 'كليب جديد', en: 'New clip' },
  defaultTitleVod: { ar: 'تسجيل بث', en: 'Stream recording' },
  defaultTitleVideo: { ar: 'مقطع جديد', en: 'New video' },
  audit: { ar: 'نشر يدوي: {title} ({url})', en: 'Manual post: {title} ({url})' },
});

/** Result of parsing a supported URL. */
export interface ParsedContentUrl {
  platform: Platform;
  kind: ContentKind;
  contentId: string;
  /** Channel handle / slug named by the URL (lowercase, without "@"), when the URL contains it. */
  handle: string | null;
  /** Canonical URL of the content. */
  url: string;
}

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Parses a Kick / Twitch / YouTube / TikTok content URL. Returns null for anything unsupported. */
export function parseContentUrl(raw: string): ParsedContentUrl | null {
  const text = raw.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, '');
  const parts = u.pathname.split('/').filter(Boolean).map((p) => decodeSafe(p));
  const id = (v: string | null | undefined): string | null => (v && SAFE_ID_RE.test(v) ? v : null);
  const handleOf = (v: string | undefined): string | null => {
    const h = v?.replace(/^@/, '').toLowerCase();
    return h && /^[a-z0-9_.-]{1,64}$/.test(h) ? h : null;
  };

  if (host === 'kick.com') {
    const slug = handleOf(parts[0]);
    const clipParam = id(u.searchParams.get('clip'));
    if (parts[0] === 'video' && id(parts[1])) return { platform: 'kick', kind: 'vod', contentId: parts[1]!, handle: null, url: `https://kick.com/video/${parts[1]}` };
    if (slug && parts[1] === 'clips' && id(parts[2])) return { platform: 'kick', kind: 'clip', contentId: parts[2]!, handle: slug, url: `https://kick.com/${slug}/clips/${parts[2]}` };
    if (slug && clipParam) return { platform: 'kick', kind: 'clip', contentId: clipParam, handle: slug, url: `https://kick.com/${slug}/clips/${clipParam}` };
    if (slug && parts[1] === 'videos' && id(parts[2])) return { platform: 'kick', kind: 'vod', contentId: parts[2]!, handle: slug, url: `https://kick.com/${slug}/videos/${parts[2]}` };
    return null;
  }
  if (host === 'clips.twitch.tv') {
    const slug = parts[0] === 'embed' ? id(u.searchParams.get('clip')) : id(parts[0]);
    return slug ? { platform: 'twitch', kind: 'clip', contentId: slug, handle: null, url: `https://clips.twitch.tv/${slug}` } : null;
  }
  if (host === 'twitch.tv') {
    if (parts[0] === 'videos' && parts[1] && /^\d{1,20}$/.test(parts[1])) {
      return { platform: 'twitch', kind: 'vod', contentId: parts[1], handle: null, url: `https://www.twitch.tv/videos/${parts[1]}` };
    }
    const ch = handleOf(parts[0]);
    if (ch && parts[1] === 'clip' && id(parts[2])) return { platform: 'twitch', kind: 'clip', contentId: parts[2]!, handle: ch, url: `https://clips.twitch.tv/${parts[2]}` };
    return null;
  }
  if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtu.be') {
    let vid: string | null = null;
    let kind: ContentKind = 'video';
    if (host === 'youtu.be') vid = parts[0] ?? null;
    else if (parts[0] === 'watch') vid = u.searchParams.get('v');
    else if (parts[0] === 'shorts') {
      vid = parts[1] ?? null;
      kind = 'short';
    } else if (parts[0] === 'live' || parts[0] === 'embed') vid = parts[1] ?? null;
    if (!vid || !/^[A-Za-z0-9_-]{11}$/.test(vid)) return null;
    return { platform: 'youtube', kind, contentId: vid, handle: null, url: kind === 'short' ? `https://www.youtube.com/shorts/${vid}` : `https://www.youtube.com/watch?v=${vid}` };
  }
  if (host === 'tiktok.com') {
    const user = handleOf(parts[0]?.startsWith('@') ? parts[0] : undefined);
    if (user && parts[1] === 'video' && parts[2] && /^\d{5,25}$/.test(parts[2])) {
      return { platform: 'tiktok', kind: 'video', contentId: parts[2], handle: user, url: `https://www.tiktok.com/@${user}/video/${parts[2]}` };
    }
    return null;
  }
  return null;
}

function decodeSafe(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

interface Enrichment {
  title: string | null;
  thumbnailUrl: string | null;
  authorHandle: string | null;
  authorName: string | null;
}

export interface ManualPostServiceDeps {
  repos: Repositories;
  audit: AuditService;
  events: AppEvents;
  notifier: Notifier;
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetch?: typeof fetch;
  clock?: () => number;
}

interface Target {
  streamer: Streamer | null;
  channel: Channel | null;
}

const manualKey = (guildId: string, platform: Platform, contentId: string): string => `manual:posted:${guildId}:${platform}:${contentId}`;

export class ManualPostService implements ManualPostServiceApi {
  private readonly repos: Repositories;
  private readonly audit: AuditService;
  private readonly events: AppEvents;
  private readonly notifier: Notifier;
  private readonly fetchFn: typeof fetch | null;
  private readonly clock: () => number;
  private readonly inflight = new Set<string>();

  constructor(deps: ManualPostServiceDeps) {
    this.repos = deps.repos;
    this.audit = deps.audit;
    this.events = deps.events;
    this.notifier = deps.notifier;
    this.fetchFn = deps.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    this.clock = deps.clock ?? Date.now;
  }

  async inspect(guildId: string, url: string): Promise<ManualPostPreview> {
    const settings = this.enabledSettings(guildId);
    const lang = settings.features.language;
    const parsed = this.parse(url, lang);
    const enrich = await this.enrich(parsed);
    const target = this.match(guildId, parsed, enrich, null, lang);
    return {
      platform: parsed.platform,
      kind: parsed.kind,
      contentId: parsed.contentId,
      url: parsed.url,
      title: enrich.title,
      thumbnailUrl: enrich.thumbnailUrl,
      streamer: target.streamer ? { id: target.streamer.id, displayName: target.streamer.displayName } : null,
      channelId: resolveContentChannelId(settings, parsed.platform, parsed.kind),
      alreadyPosted: this.alreadyPosted(guildId, parsed, target.channel),
    };
  }

  async post(
    guildId: string,
    input: { url: string; title?: string | null; thumbnailUrl?: string | null; streamerId?: number | null; kind?: ContentKind | null },
    actor: string,
  ): Promise<{ messageRef: MessageRef | null; contentItemId: number }> {
    const settings = this.enabledSettings(guildId);
    const lang = settings.features.language;
    const parsed = this.parse(input?.url, lang);
    if (input.kind != null) {
      if (!isContentKind(input.kind)) throw new ValidationError(manualPostMessages(lang, 'badKind'), 'kind');
      parsed.kind = input.kind;
    }
    if (!resolveContentChannelId(settings, parsed.platform, parsed.kind)) throw new ValidationError(manualPostMessages(lang, 'noChannel'), 'channel');

    const key = `${guildId}:${parsed.platform}:${parsed.contentId}`;
    if (this.inflight.has(key)) throw new ValidationError(manualPostMessages(lang, 'alreadyPosted'), 'url');
    this.inflight.add(key);
    try {
      const enrich = await this.enrich(parsed);
      const target = this.match(guildId, parsed, enrich, input.streamerId ?? null, lang);
      if (this.alreadyPosted(guildId, parsed, target.channel)) throw new ValidationError(manualPostMessages(lang, 'alreadyPosted'), 'url');

      const title = cleanTitle(input.title) ?? enrich.title ?? defaultTitle(parsed.kind, lang);
      const thumbnailUrl = cleanHttpUrl(input.thumbnailUrl) ?? enrich.thumbnailUrl;
      const channelView = target.channel
        ? { id: target.channel.id, platform: target.channel.platform, displayName: target.channel.displayName, handle: target.channel.handle, url: target.channel.url, avatarUrl: target.channel.avatarUrl }
        : syntheticChannel(parsed, enrich);
      const item: ContentItem = {
        platform: parsed.platform,
        platformId: target.channel?.platformId ?? channelView.handle,
        contentId: parsed.contentId,
        kind: parsed.kind,
        title,
        url: parsed.url,
        thumbnailUrl,
        publishedAt: new Date(this.clock()).toISOString(),
        durationSec: null,
        viewCount: null,
      };
      const stored = target.channel ? this.repos.content.insert(target.channel.id, item, false).item : null;
      const streamer = target.streamer ?? syntheticStreamer(guildId, channelView.displayName, this.clock());
      const view: ContentView = { guildId, settings, streamer, channel: channelView, item: stored ? { ...stored, title, thumbnailUrl } : item };

      let ref: MessageRef | null = null;
      let failure: string | null = null;
      try {
        ref = await this.notifier.postContent(view);
      } catch (err) {
        failure = errorMessage(err);
      }
      if (!ref) {
        log.warn({ guildId, url: parsed.url, failure }, 'Manual post failed');
        throw new ValidationError(manualPostMessages(lang, 'postFailed'), 'channel');
      }
      const postedRef = ref;
      if (stored) {
        this.repos.tx(() => {
          this.repos.content.recordNotification({
            contentItemId: stored.id,
            guildId,
            streamerId: target.streamer?.id ?? null,
            messageChannelId: postedRef.channelId,
            messageId: postedRef.messageId,
          });
          this.repos.content.markAnnounced(stored.id);
        });
      } else {
        try {
          this.repos.kv.set(manualKey(guildId, parsed.platform, parsed.contentId), { at: new Date(this.clock()).toISOString(), ...postedRef });
        } catch (err) {
          log.warn({ err }, 'Storing the manual post marker failed');
        }
      }
      this.audit.record({
        guildId,
        actor,
        action: 'content.manual',
        message: manualPostMessages(lang, 'audit', { title: title.length > 120 ? `${title.slice(0, 119)}…` : title, url: parsed.url }),
        details: { platform: parsed.platform, kind: parsed.kind, contentId: parsed.contentId, url: parsed.url, streamerId: target.streamer?.id ?? null, messageId: postedRef.messageId },
        mirror: true,
      });
      if (target.streamer) {
        this.events.emit('content.announced', { guildId, streamerId: target.streamer.id, platform: parsed.platform, title, url: parsed.url });
      }
      return { messageRef: postedRef, contentItemId: stored?.id ?? 0 };
    } finally {
      this.inflight.delete(key);
    }
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private enabledSettings(guildId: string): GuildSettings {
    const settings = this.repos.settings.get(guildId);
    if (!settings.features.manualPosts.enabled) throw new ValidationError(manualPostMessages(settings.features.language, 'disabled'));
    return settings;
  }

  private parse(url: unknown, lang: Language): ParsedContentUrl {
    if (typeof url !== 'string') throw new ValidationError(manualPostMessages(lang, 'badUrl'), 'url');
    const cleaned = url.replace(INVISIBLE_CHARS_RE, '').trim().replace(/^<(.*)>$/, '$1');
    if (!cleaned || cleaned.length > MAX_MANUAL_URL_LENGTH) throw new ValidationError(manualPostMessages(lang, 'badUrl'), 'url');
    const parsed = parseContentUrl(cleaned);
    if (!parsed) throw new ValidationError(manualPostMessages(lang, 'unsupported'), 'url');
    return parsed;
  }

  private match(guildId: string, parsed: ParsedContentUrl, enrich: Enrichment, streamerId: number | null, lang: Language): Target {
    const streamers = this.repos.streamersWithAccounts(guildId);
    const handles = new Set([parsed.handle, enrich.authorHandle].filter((h): h is string => !!h).map(normHandle));
    const owns = (s: StreamerWithAccounts) =>
      s.accounts.find((a) => a.channel.platform === parsed.platform && (handles.has(normHandle(a.channel.handle)) || handles.has(normHandle(urlHandle(a.channel.url) ?? ''))));

    if (streamerId != null) {
      const streamer = streamers.find((s) => s.id === streamerId);
      if (!streamer) throw new ValidationError(manualPostMessages(lang, 'streamerNotFound'), 'streamerId');
      const account = owns(streamer) ?? streamer.accounts.find((a) => a.channel.platform === parsed.platform);
      return { streamer: stripAccounts(streamer), channel: account?.channel ?? null };
    }
    if (handles.size === 0) return { streamer: null, channel: null };
    const ordered = [...streamers].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.id - b.id);
    for (const s of ordered) {
      const account = owns(s);
      if (account) return { streamer: stripAccounts(s), channel: account.channel };
    }
    return { streamer: null, channel: null };
  }

  private alreadyPosted(guildId: string, parsed: ParsedContentUrl, channel: Channel | null): boolean {
    try {
      if (this.repos.kv.get(manualKey(guildId, parsed.platform, parsed.contentId)) !== undefined) return true;
      const rows = this.repos.db
        .prepare(
          `SELECT ci.id FROM content_items ci JOIN channels c ON c.id = ci.channel_id
           WHERE c.platform = ? AND ci.content_id = ? ${channel ? 'AND ci.channel_id = ?' : ''}`,
        )
        .all(...(channel ? [parsed.platform, parsed.contentId, channel.id] : [parsed.platform, parsed.contentId])) as Array<{ id: number | bigint }>;
      return rows.some((r) => this.repos.content.wasNotified(Number(r.id), guildId));
    } catch (err) {
      log.warn({ err }, 'Already-posted check failed');
      return false;
    }
  }

  /** Best-effort oEmbed (YouTube, TikTok). Never throws. */
  private async enrich(parsed: ParsedContentUrl): Promise<Enrichment> {
    const empty: Enrichment = { title: null, thumbnailUrl: null, authorHandle: null, authorName: null };
    if (!this.fetchFn) return empty;
    const endpoint =
      parsed.platform === 'youtube'
        ? `https://www.youtube.com/oembed?url=${encodeURIComponent(parsed.url)}&format=json`
        : parsed.platform === 'tiktok'
          ? `https://www.tiktok.com/oembed?url=${encodeURIComponent(parsed.url)}`
          : null;
    if (!endpoint) return empty;
    try {
      const res = await this.fetchFn(endpoint, { signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS), headers: { accept: 'application/json' } });
      if (!res.ok) return empty;
      const body = (await res.json()) as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
      const authorUrl = str(body.author_url);
      return {
        title: cleanTitle(str(body.title)),
        thumbnailUrl: cleanHttpUrl(str(body.thumbnail_url)),
        authorHandle: str(body.author_unique_id)?.toLowerCase() ?? (authorUrl ? urlHandle(authorUrl) : null),
        authorName: str(body.author_name),
      };
    } catch (err) {
      log.debug({ err, platform: parsed.platform }, 'oEmbed enrichment failed');
      return empty;
    }
  }
}

function normHandle(h: string): string {
  return h.replace(/^@/, '').trim().toLowerCase();
}

/** "@handle" from a profile URL (youtube.com/@x, tiktok.com/@x, kick.com/x, twitch.tv/x). */
function urlHandle(url: string): string | null {
  try {
    const u = new URL(url);
    const first = u.pathname.split('/').filter(Boolean)[0];
    if (!first) return null;
    if (/youtube\.com$/.test(u.hostname) || /tiktok\.com$/.test(u.hostname)) return first.startsWith('@') ? normHandle(first) : null;
    return normHandle(first);
  } catch {
    return null;
  }
}

function stripAccounts(s: StreamerWithAccounts): Streamer {
  const { accounts: _accounts, ...streamer } = s;
  return streamer;
}

function cleanTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.replace(INVISIBLE_CHARS_RE, '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > MAX_TITLE_LENGTH ? `${t.slice(0, MAX_TITLE_LENGTH - 1)}…` : t;
}

function cleanHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function defaultTitle(kind: ContentKind, lang: Language): string {
  if (kind === 'clip') return manualPostMessages(lang, 'defaultTitleClip');
  if (kind === 'vod' || kind === 'highlight') return manualPostMessages(lang, 'defaultTitleVod');
  return manualPostMessages(lang, 'defaultTitleVideo');
}

const PLATFORM_HOME: Record<Platform, string> = {
  twitch: 'https://www.twitch.tv/',
  kick: 'https://kick.com/',
  youtube: 'https://www.youtube.com/',
  tiktok: 'https://www.tiktok.com/',
};

function syntheticChannel(parsed: ParsedContentUrl, enrich: Enrichment): ContentView['channel'] {
  const handle = parsed.handle ?? enrich.authorHandle ?? '';
  const url =
    handle && parsed.platform !== 'youtube'
      ? `${PLATFORM_HOME[parsed.platform]}${parsed.platform === 'tiktok' ? '@' : ''}${handle}`
      : handle
        ? `https://www.youtube.com/@${handle}`
        : PLATFORM_HOME[parsed.platform];
  return { id: 0, platform: parsed.platform, displayName: enrich.authorName ?? (handle || parsed.platform), handle: handle || parsed.platform, url, avatarUrl: null };
}

function syntheticStreamer(guildId: string, displayName: string, now: number): Streamer {
  const at = new Date(now).toISOString();
  return { id: 0, guildId, discordUserId: '', displayName, notes: null, color: null, templates: {}, enabled: true, createdAt: at, updatedAt: at };
}
