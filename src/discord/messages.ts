/**
 * Pure builders for every message the bot posts: the combined live notification, the post-stream summary,
 * the minimal "stream ended" card, new-content notifications, the daily clip digest (#6) and presence-only live
 * cards (#15), plus a converter to the dashboard preview shape. No I/O and no clock reads unless `now` is omitted,
 * so everything here is unit-tested.
 *
 * #16 — every built-in label, field name, button, content kind and duration follows the guild's
 * `features.language`; templates resolve per field: preview override → streamer template (#5) → guild template →
 * default of the guild language.
 *
 * Untrusted text (titles, names, categories) is escaped wherever Discord renders markdown; URLs are
 * validated because a single invalid URL makes Discord reject the whole message.
 */
import type { APIActionRowComponent, APIButtonComponentWithURL, APIEmbed, APIEmbedField } from 'discord.js';
import { ButtonStyle, ComponentType } from 'discord.js';
import type { Platform } from '../core/types.js';
import { PLATFORM_COLORS, PLATFORM_LABELS } from '../core/types.js';
import type { GuildSettings, Language, Streamer, TemplateSpec } from '../db/models.js';
import type { ContentView, DigestView, LivePlatformView, LiveView, PresenceLiveView, SummaryView } from '../services/ports.js';
import type { MessagePreview } from '../shared/api.js';
import { DEFAULT_PLATFORM_EMOJIS, type EmojiRef, ICONS, type PlatformEmojis } from './emojis.js';
import {
  cleanText,
  discordTimestamp,
  escapeMarkdown,
  formatClock,
  formatDurationShort,
  formatNumber,
  maskedLink,
  safeUrl,
  truncate,
} from './format.js';
import { contentKindLabel, joinList, langOf, tm, viewersText } from './i18n/messages.js';
import { buildPing, composeContent, type PingSpec } from './mentions.js';
import { type SampleIdentity, sampleIdentityFor, sampleView } from './samples.js';
import { DISCORD_LIMITS, defaultTemplatesFor, renderTemplate, resolveTemplate, type TemplateType, type TemplateVars } from './templates.js';

export type LinkButtonRow = APIActionRowComponent<APIButtonComponentWithURL>;

export interface MessageContent {
  content: string;
  embeds: APIEmbed[];
  components: LinkButtonRow[];
}

export interface RenderOptions {
  emojis?: PlatformEmojis;
  /** Streamer's Discord avatar when known; falls back to the primary channel avatar. */
  avatarUrl?: string | null;
  /** Clock used for "last updated" timestamps (defaults to Date.now()). */
  now?: number;
  /** Template override (dashboard editor preview); otherwise the guild's saved template is used. */
  template?: TemplateSpec;
}

/** Neutral grey of a finished stream. */
export const ENDED_COLOR = 0x80848e;

/** Discord's own "Streaming" purple, used for presence-only streams on an unknown platform. */
export const STREAMING_COLOR = 0x593695;

const MAX_GAMES_LISTED = 8;
const MAX_PLATFORM_TITLE = 120;

export interface LinkButtonSpec {
  label: string;
  url: string | null | undefined;
  emoji?: EmojiRef['component'];
}

// ───────────────────────────── shared pieces ─────────────────────────────

/** Link buttons, deduplicated by URL, invalid URLs skipped, max 5 per row and 25 in total. */
export function linkButtonRows(specs: LinkButtonSpec[]): LinkButtonRow[] {
  const seen = new Set<string>();
  const buttons: APIButtonComponentWithURL[] = [];
  for (const spec of specs) {
    const url = safeUrl(spec.url, DISCORD_LIMITS.buttonUrl);
    const label = truncate(cleanText(spec.label), DISCORD_LIMITS.buttonLabel);
    if (!url || !label || seen.has(url)) continue;
    seen.add(url);
    const button: APIButtonComponentWithURL = { type: ComponentType.Button, style: ButtonStyle.Link, label, url };
    if (spec.emoji) button.emoji = { ...spec.emoji };
    buttons.push(button);
    if (buttons.length === DISCORD_LIMITS.buttonsPerRow * DISCORD_LIMITS.rows) break;
  }
  const rows: LinkButtonRow[] = [];
  for (let i = 0; i < buttons.length; i += DISCORD_LIMITS.buttonsPerRow) {
    rows.push({ type: ComponentType.ActionRow, components: buttons.slice(i, i + DISCORD_LIMITS.buttonsPerRow) });
  }
  return rows;
}

function field(name: string, value: string, inline: boolean): APIEmbedField | null {
  const n = truncate(name.trim(), DISCORD_LIMITS.fieldName);
  const v = truncate(value.trim(), DISCORD_LIMITS.fieldValue);
  return n && v ? { name: n, value: v, inline } : null;
}

function embedLength(embed: APIEmbed): number {
  let total = (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.footer?.text.length ?? 0) + (embed.author?.name.length ?? 0);
  for (const f of embed.fields ?? []) total += f.name.length + f.value.length;
  return total;
}

/** Keeps an embed within Discord's 6000-character total: shortens the description, then drops trailing fields. */
export function fitEmbed(embed: APIEmbed): APIEmbed {
  const out: APIEmbed = { ...embed, fields: embed.fields ? [...embed.fields] : undefined };
  let excess = embedLength(out) - DISCORD_LIMITS.embedTotal;
  if (excess > 0 && out.description) {
    const keep = Math.max(0, out.description.length - excess);
    out.description = keep > 0 ? truncate(out.description, keep) : undefined;
    excess = embedLength(out) - DISCORD_LIMITS.embedTotal;
  }
  while (excess > 0 && out.fields && out.fields.length > 0) {
    out.fields.pop();
    excess = embedLength(out) - DISCORD_LIMITS.embedTotal;
  }
  if (out.fields?.length === 0) delete out.fields;
  return out;
}

/** Drops undefined/empty keys so payloads (and snapshots in tests) stay clean. */
function compactEmbed(embed: APIEmbed): APIEmbed {
  const out: APIEmbed = {};
  for (const [key, value] of Object.entries(embed) as Array<[keyof APIEmbed, unknown]>) {
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return fitEmbed(out);
}

function author(name: string, iconUrl: string | null | undefined, url: string | null | undefined): APIEmbed['author'] {
  const text = truncate(cleanText(name), DISCORD_LIMITS.authorName);
  if (!text) return undefined;
  const result: NonNullable<APIEmbed['author']> = { name: text };
  const icon = safeUrl(iconUrl);
  const link = safeUrl(url);
  if (icon) result.icon_url = icon;
  if (link) result.url = link;
  return result;
}

function image(url: string | null | undefined): { url: string } | undefined {
  const safe = safeUrl(url);
  return safe ? { url: safe } : undefined;
}

function footer(text: string): APIEmbed['footer'] {
  return text ? { text } : undefined;
}

function isoOrUndefined(value: string | number | null | undefined): string | undefined {
  if (value == null) return undefined;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function sameName(a: string, b: string): boolean {
  const norm = (s: string) => cleanText(s).toLowerCase().replace(/[\s_.-]+/g, '');
  return norm(a) === norm(b);
}

function mentionOf(userId: string): string {
  return /^\d{17,20}$/.test(userId) ? `<@${userId}>` : '';
}

/** Builds plain + markdown-escaped variants of a variable set. Keys listed in `raw` are never escaped. */
function varsPair(values: Record<string, string>, raw: string[]): { plain: TemplateVars; markdown: TemplateVars } {
  const plain: TemplateVars = {};
  const markdown: TemplateVars = {};
  for (const [key, value] of Object.entries(values)) {
    plain[key] = raw.includes(key) ? value : cleanText(value);
    markdown[key] = raw.includes(key) ? value : escapeMarkdown(value);
  }
  return { plain, markdown };
}

function emojiFor(emojis: PlatformEmojis, platform: Platform): EmojiRef {
  return emojis[platform] ?? DEFAULT_PLATFORM_EMOJIS[platform];
}

/** Applies the guild ping in front of the content (live + content posts only; never on summaries or tests). */
export function applyPing(message: MessageContent, ping: PingSpec): MessageContent {
  return { ...message, content: composeContent(ping.content, message.content) };
}

// ───────────────────────────── live (idea #1: one combined message) ─────────────────────────────

function firstText(platforms: LivePlatformView[], pick: (p: LivePlatformView) => string | null | undefined): string {
  for (const p of platforms) {
    const text = cleanText(pick(p));
    if (text) return text;
  }
  return '';
}

/** Where "watch" should go: the live URL reported by the platform, else the channel page. */
export function watchUrl(p: LivePlatformView): string | null {
  return safeUrl(p.snapshot.url) ?? safeUrl(p.channel.url);
}

function primaryCategoryImage(platforms: LivePlatformView[]): string | null {
  for (const p of platforms) {
    if (cleanText(p.snapshot.category)) return safeUrl(p.snapshot.categoryImageUrl);
  }
  return null;
}

function platformLines(p: LivePlatformView, streamerName: string, primaryTitle: string, lang: Language): string {
  const lines: string[] = [];
  const name = cleanText(p.channel.displayName) || cleanText(p.channel.handle);
  const channelUrl = safeUrl(p.channel.url) ?? safeUrl(p.snapshot.url);
  if (name && !sameName(name, streamerName)) lines.push(channelUrl ? `[${escapeMarkdown(name)}](${channelUrl})` : escapeMarkdown(name));

  const stats: string[] = [];
  if (p.snapshot.viewers != null) stats.push(`${ICONS.viewers} ${viewersText(lang, formatNumber(p.snapshot.viewers), p.snapshot.viewers)}`);
  const category = cleanText(p.snapshot.category);
  if (category) stats.push(`${ICONS.game} ${escapeMarkdown(category)}`);
  lines.push(stats.length > 0 ? stats.join(' • ') : `${ICONS.live} ${tm(lang, 'live.now')}`);

  const title = cleanText(p.snapshot.title);
  if (title && title !== primaryTitle) lines.push(`${ICONS.title} ${escapeMarkdown(truncate(title, MAX_PLATFORM_TITLE))}`);
  return lines.join('\n');
}

export function liveTemplateVars(view: LiveView): { plain: TemplateVars; markdown: TemplateVars } {
  const lang = langOf(view.settings);
  const primary = view.platforms[0];
  const game = firstText(view.platforms, (p) => p.snapshot.category);
  const values: Record<string, string> = {
    name: view.streamer.displayName,
    user: view.streamer.displayName,
    mention: mentionOf(view.streamer.discordUserId),
    platform: primary ? PLATFORM_LABELS[primary.platform] : '',
    platforms: joinList([...new Set(view.platforms.map((p) => PLATFORM_LABELS[p.platform]))], lang),
    title: firstText(view.platforms, (p) => p.snapshot.title),
    game,
    category: game,
    viewers: view.totalViewers != null ? formatNumber(view.totalViewers) : '',
    url: primary ? (watchUrl(primary) ?? '') : '',
    started: discordTimestamp(view.session.startedAt, 'R') ?? '',
    handle: primary?.channel.handle ?? '',
  };
  return varsPair(values, ['mention', 'url', 'started']);
}

/** Template layers of a view: the streamer's own templates (#5) and the guild language (#16). */
function layersOf(settings: GuildSettings, streamer: Pick<Streamer, 'templates'> | null | undefined) {
  return { streamer: streamer?.templates ?? null, language: langOf(settings) };
}

export function buildLiveMessage(view: LiveView, options: RenderOptions = {}): MessageContent {
  const emojis = options.emojis ?? DEFAULT_PLATFORM_EMOJIS;
  const now = options.now ?? Date.now();
  const lang = langOf(view.settings);
  const template = resolveTemplate('live', view.settings.templates, options.template, layersOf(view.settings, view.streamer));
  const { plain, markdown } = liveTemplateVars(view);
  const rendered = renderTemplate(template, plain, markdown);
  const primary = view.platforms[0];
  const primaryTitle = String(plain.title ?? '');
  const avatar = safeUrl(options.avatarUrl) ?? view.platforms.map((p) => safeUrl(p.channel.avatarUrl)).find(Boolean) ?? null;
  const primaryUrl = String(plain.url ?? '') || null;

  const multi = view.platforms.length > 1;
  const fields = view.platforms.map((p) =>
    field(`${emojiFor(emojis, p.platform).text} ${PLATFORM_LABELS[p.platform]}`, platformLines(p, view.streamer.displayName, primaryTitle, lang), true),
  );
  const reporting = view.platforms.filter((p) => p.snapshot.viewers != null).length;
  if (multi && reporting > 1 && view.totalViewers != null) {
    fields.push(field(`${ICONS.total} ${tm(lang, 'live.total')}`, viewersText(lang, formatNumber(view.totalViewers), view.totalViewers), true));
  }
  const started = discordTimestamp(view.session.startedAt, 'R');
  if (started) fields.push(field(`${ICONS.started} ${tm(lang, 'live.started')}`, started, true));

  const thumbnailUrl = view.platforms.map((p) => safeUrl(p.snapshot.thumbnailUrl)).find(Boolean) ?? null;
  const embed = compactEmbed({
    author: author(view.streamer.displayName, avatar, primaryUrl),
    title: rendered.title || undefined,
    url: primaryUrl ?? undefined,
    description: rendered.description || undefined,
    color: template.color ?? view.streamer.color ?? (primary ? PLATFORM_COLORS[primary.platform] : PLATFORM_COLORS.twitch),
    fields: fields.filter((f): f is APIEmbedField => f !== null),
    image: image(thumbnailUrl),
    thumbnail: image(primaryCategoryImage(view.platforms) ?? avatar),
    footer: footer(rendered.footer),
    timestamp: isoOrUndefined(now),
  });

  const sameLabelCount = (platform: Platform) => view.platforms.filter((p) => p.platform === platform).length;
  const components = linkButtonRows(
    view.platforms.map((p) => ({
      label:
        sameLabelCount(p.platform) > 1
          ? tm(lang, 'live.watchOnChannel', { platform: PLATFORM_LABELS[p.platform], channel: cleanText(p.channel.displayName) || p.channel.handle })
          : tm(lang, 'live.watchOn', { platform: PLATFORM_LABELS[p.platform] }),
      url: watchUrl(p),
      emoji: emojiFor(emojis, p.platform).component,
    })),
  );

  return { content: rendered.content, embeds: [embed], components };
}

// ───────────────────────────── summary (idea #2) ─────────────────────────────

interface SummaryChannel {
  platform: Platform;
  channelId: number;
  displayName: string;
  handle: string;
  url: string;
  peak: number;
  vodUrl: string | null;
}

/** One entry per channel (a reconnect creates several segments of the same channel). */
function summaryChannels(view: SummaryView): SummaryChannel[] {
  const byChannel = new Map<number, SummaryChannel>();
  for (const seg of view.segments) {
    const existing = byChannel.get(seg.channelId);
    if (existing) {
      existing.peak = Math.max(existing.peak, seg.peakViewers);
      existing.vodUrl = safeUrl(seg.vodUrl) ?? existing.vodUrl;
      continue;
    }
    byChannel.set(seg.channelId, {
      platform: seg.platform,
      channelId: seg.channelId,
      displayName: cleanText(seg.channel.displayName) || cleanText(seg.channel.handle),
      handle: seg.channel.handle,
      url: seg.channel.url,
      peak: seg.peakViewers,
      vodUrl: safeUrl(seg.vodUrl),
    });
  }
  return [...byChannel.values()];
}

export function summaryTemplateVars(view: SummaryView): { plain: TemplateVars; markdown: TemplateVars } {
  const lang = langOf(view.settings);
  const channels = summaryChannels(view);
  const values: Record<string, string> = {
    name: view.streamer.displayName,
    user: view.streamer.displayName,
    mention: mentionOf(view.streamer.discordUserId),
    duration: formatDurationShort(view.durationSec, lang),
    peak: view.peakViewers > 0 ? formatNumber(view.peakViewers) : '',
    avg: view.avgViewers != null ? formatNumber(view.avgViewers) : '',
    games: joinList(view.categories.map((c) => cleanText(c.name)), lang),
    platforms: joinList([...new Set(channels.map((c) => PLATFORM_LABELS[c.platform]))], lang),
    title: cleanText(view.titles[view.titles.length - 1]),
  };
  return varsPair(values, ['mention']);
}

function gamesValue(view: SummaryView, lang: Language): string {
  const games = view.categories.filter((c) => cleanText(c.name));
  if (games.length === 0) return '';
  const lines = games.slice(0, MAX_GAMES_LISTED).map((c) => {
    const time = c.seconds >= 60 ? ` — ${formatDurationShort(c.seconds, lang)}` : '';
    return `• ${escapeMarkdown(c.name)}${time}`;
  });
  if (games.length > MAX_GAMES_LISTED) lines.push(tm(lang, 'summary.moreGames', { count: games.length - MAX_GAMES_LISTED }));
  return lines.join('\n');
}

function platformsValue(channels: SummaryChannel[], emojis: PlatformEmojis, lang: Language): string {
  return channels
    .map((c) => {
      const url = safeUrl(c.url);
      const label = PLATFORM_LABELS[c.platform];
      const name = c.displayName ? (url ? `[${escapeMarkdown(c.displayName)}](${url})` : escapeMarkdown(c.displayName)) : label;
      const peak = c.peak > 0 ? ` — ${tm(lang, 'summary.peakShort', { count: formatNumber(c.peak) })}` : '';
      return `${emojiFor(emojis, c.platform).text} ${label}: ${name}${peak}`;
    })
    .join('\n');
}

/**
 * Kick's videos page for a channel (`https://kick.com/<slug>/videos`). Kick often lists a recording only some
 * time after the stream, so without a known VOD the summary still links to where it will appear.
 */
export function kickVideosUrl(channel: { url: string; handle: string }): string | null {
  const page = safeUrl(channel.url);
  if (page) {
    const url = new URL(page);
    const slug = url.pathname.split('/').filter(Boolean)[0];
    if (/(^|\.)kick\.com$/i.test(url.hostname) && slug) return `https://kick.com/${slug}/videos`;
  }
  const handle = channel.handle.trim().replace(/^@/, '');
  return /^[\w-]{1,64}$/.test(handle) ? `https://kick.com/${handle}/videos` : null;
}

function channelButtons(channels: SummaryChannel[], emojis: PlatformEmojis, lang: Language): LinkButtonSpec[] {
  return channels.map((c) => ({
    label: tm(lang, 'summary.channelOn', { platform: PLATFORM_LABELS[c.platform] }),
    url: c.url,
    emoji: emojiFor(emojis, c.platform).component,
  }));
}

function summaryButtons(channels: SummaryChannel[], emojis: PlatformEmojis, lang: Language): LinkButtonRow[] {
  const vods: LinkButtonSpec[] = channels
    .filter((c) => c.vodUrl)
    .map((c) => ({ label: tm(lang, 'summary.replayOn', { platform: PLATFORM_LABELS[c.platform] }), url: c.vodUrl, emoji: { name: ICONS.vod } }));
  const kickVideos: LinkButtonSpec[] = channels
    .filter((c) => c.platform === 'kick' && !c.vodUrl)
    .map((c) => ({ label: tm(lang, 'summary.replays', { platform: PLATFORM_LABELS.kick }), url: kickVideosUrl(c), emoji: { name: ICONS.vod } }));
  return linkButtonRows([...vods, ...kickVideos, ...channelButtons(channels, emojis, lang)]);
}

function summaryAvatar(view: SummaryView, options: RenderOptions): string | null {
  return safeUrl(options.avatarUrl) ?? view.segments.map((s) => safeUrl(s.channel.avatarUrl)).find(Boolean) ?? null;
}

export function buildSummaryMessage(view: SummaryView, options: RenderOptions = {}): MessageContent {
  const emojis = options.emojis ?? DEFAULT_PLATFORM_EMOJIS;
  const lang = langOf(view.settings);
  const template = resolveTemplate('summary', view.settings.templates, options.template, layersOf(view.settings, view.streamer));
  const { plain, markdown } = summaryTemplateVars(view);
  const rendered = renderTemplate(template, plain, markdown);
  const channels = summaryChannels(view);
  const avatar = summaryAvatar(view, options);

  const start = discordTimestamp(view.session.startedAt, 'f');
  const end = discordTimestamp(view.session.endedAt, 't');
  const fields = [
    field(`${ICONS.duration} ${tm(lang, 'summary.duration')}`, formatDurationShort(view.durationSec, lang), true),
    field(`${ICONS.peak} ${tm(lang, 'summary.peak')}`, view.peakViewers > 0 ? formatNumber(view.peakViewers) : '—', true),
    field(`${ICONS.average} ${tm(lang, 'summary.average')}`, view.avgViewers != null ? formatNumber(view.avgViewers) : '—', true),
    field(`${ICONS.game} ${tm(lang, 'summary.games')}`, gamesValue(view, lang), false),
    field(`${ICONS.platforms} ${tm(lang, 'summary.platforms')}`, platformsValue(channels, emojis, lang), false),
    start && end ? field(`${ICONS.clock} ${tm(lang, 'summary.time')}`, tm(lang, 'summary.timeRange', { start, end }), false) : null,
  ];

  const embed = compactEmbed({
    author: author(view.streamer.displayName, avatar, channels[0]?.url),
    title: rendered.title || undefined,
    description: rendered.description || undefined,
    color: template.color ?? ENDED_COLOR,
    fields: fields.filter((f): f is APIEmbedField => f !== null),
    image: image(view.imageUrl),
    thumbnail: avatar && safeUrl(view.imageUrl) !== avatar ? image(avatar) : undefined,
    footer: footer(rendered.footer),
    timestamp: isoOrUndefined(view.session.endedAt ?? options.now ?? Date.now()),
  });

  return { content: rendered.content, embeds: [embed], components: summaryButtons(channels, emojis, lang) };
}

/** Minimal card used when summaries are disabled, so the channel never keeps a stale "live" message. */
export function buildEndedMessage(view: SummaryView, options: RenderOptions = {}): MessageContent {
  const emojis = options.emojis ?? DEFAULT_PLATFORM_EMOJIS;
  const lang = langOf(view.settings);
  const channels = summaryChannels(view);
  const avatar = summaryAvatar(view, options);
  const embed = compactEmbed({
    author: author(view.streamer.displayName, avatar, channels[0]?.url),
    title: `${ICONS.ended} ${tm(lang, 'ended.title')}`,
    description: `${ICONS.duration} ${tm(lang, 'ended.duration', { duration: formatDurationShort(view.durationSec, lang) })}`,
    color: ENDED_COLOR,
    timestamp: isoOrUndefined(view.session.endedAt ?? options.now ?? Date.now()),
  });
  return { content: '', embeds: [embed], components: linkButtonRows(channelButtons(channels, emojis, lang)) };
}

// ───────────────────────────── new content ─────────────────────────────

function numberField(item: ContentView['item'], key: 'durationSec' | 'viewCount'): number | null {
  const value = (item as unknown as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function contentTemplateVars(view: ContentView): { plain: TemplateVars; markdown: TemplateVars } {
  const lang = langOf(view.settings);
  const duration = numberField(view.item, 'durationSec');
  const views = numberField(view.item, 'viewCount');
  const values: Record<string, string> = {
    name: view.streamer.displayName,
    user: view.streamer.displayName,
    mention: mentionOf(view.streamer.discordUserId),
    platform: PLATFORM_LABELS[view.channel.platform],
    kind: contentKindLabel(view.item.kind, lang),
    title: view.item.title,
    url: safeUrl(view.item.url) ?? '',
    channel: view.channel.displayName,
    handle: view.channel.handle,
    duration: duration != null ? formatClock(duration) : '',
    views: views != null ? formatNumber(views) : '',
  };
  return varsPair(values, ['mention', 'url']);
}

export function buildContentMessage(view: ContentView, options: RenderOptions = {}): MessageContent {
  const emojis = options.emojis ?? DEFAULT_PLATFORM_EMOJIS;
  const lang = langOf(view.settings);
  const template = resolveTemplate('content', view.settings.templates, options.template, layersOf(view.settings, view.streamer));
  const { plain, markdown } = contentTemplateVars(view);
  const rendered = renderTemplate(template, plain, markdown);
  const platform = view.channel.platform;
  const url = safeUrl(view.item.url);

  const duration = numberField(view.item, 'durationSec');
  const views = numberField(view.item, 'viewCount');
  const published = discordTimestamp(view.item.publishedAt, 'R');
  const fields = [
    duration != null ? field(`${ICONS.duration} ${tm(lang, 'content.duration')}`, formatClock(duration), true) : null,
    views != null ? field(`${ICONS.views} ${tm(lang, 'content.views')}`, formatNumber(views), true) : null,
    published ? field(`${ICONS.published} ${tm(lang, 'content.published')}`, published, true) : null,
  ];

  const embed = compactEmbed({
    author: author(view.channel.displayName || view.streamer.displayName, view.channel.avatarUrl, view.channel.url),
    title: rendered.title || undefined,
    url: url ?? undefined,
    description: rendered.description || undefined,
    color: template.color ?? view.streamer.color ?? PLATFORM_COLORS[platform],
    fields: fields.filter((f): f is APIEmbedField => f !== null),
    image: image(view.item.thumbnailUrl),
    footer: footer(rendered.footer),
    timestamp: isoOrUndefined(view.item.publishedAt) ?? isoOrUndefined(options.now ?? Date.now()),
  });

  const components = linkButtonRows([
    { label: tm(lang, 'content.watch'), url, emoji: emojiFor(emojis, platform).component },
    { label: tm(lang, 'content.channel'), url: view.channel.url, emoji: { name: ICONS.channel } },
  ]);
  return { content: rendered.content, embeds: [embed], components };
}

// ───────────────────────────── #6 daily clip digest ─────────────────────────────

const DIGEST_DESCRIPTION_BUDGET = 3_900;
const DIGEST_TITLE_MAX = 100;
const DIGEST_BUTTONS = 5;

function digestTitle(entry: DigestView['entries'][number], lang: Language): string {
  return cleanText(entry.item.title) || contentKindLabel(entry.item.kind, lang);
}

function digestViews(entry: DigestView['entries'][number]): number | null {
  const value = entry.item.viewCount;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** One line per clip: "**N.** 💜 [title](url) — streamer • 👀 views". */
function digestLine(entry: DigestView['entries'][number], index: number, emojis: PlatformEmojis, lang: Language): string {
  const title = truncate(digestTitle(entry, lang), DIGEST_TITLE_MAX);
  const who = cleanText(entry.streamer?.displayName) || cleanText(entry.channel.displayName) || cleanText(entry.channel.handle);
  const views = digestViews(entry);
  const parts = [`**${index + 1}.** ${emojiFor(emojis, entry.channel.platform).text} ${maskedLink(title, entry.item.url)}`];
  if (who) parts.push(` — ${escapeMarkdown(who)}`);
  if (views != null) parts.push(` • ${ICONS.viewers} ${formatNumber(views)}`);
  return parts.join('');
}

/**
 * The daily clip digest: one embed listing the best clips (within Discord's description limit), the top clip's
 * image and link buttons for the top 5. Never pings (it is a daily recap, not a live alert).
 */
export function buildDigestMessage(view: DigestView, options: RenderOptions = {}): MessageContent {
  const emojis = options.emojis ?? DEFAULT_PLATFORM_EMOJIS;
  const lang = langOf(view.settings);
  const entries = view.entries;

  const lines: string[] = [];
  let length = 0;
  for (const [i, entry] of entries.entries()) {
    const line = digestLine(entry, i, emojis, lang);
    const remainingAfter = entries.length - i - 1;
    // Keep room for the "… and N more" line whenever more clips follow.
    const reserve = remainingAfter > 0 ? 40 : 0;
    if (length + line.length + 1 + reserve > DIGEST_DESCRIPTION_BUDGET) {
      lines.push(tm(lang, 'digest.more', { count: entries.length - i }));
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }

  const total = Math.max(view.total, entries.length);
  const footerText =
    total > entries.length
      ? tm(lang, 'digest.footer.capped', { shown: entries.length, total })
      : entries.length === 1
        ? tm(lang, 'digest.footer.one')
        : tm(lang, 'digest.footer.all', { count: entries.length });

  const top = entries[0];
  const date = cleanText(view.date);
  const embed = compactEmbed({
    title: truncate(`${ICONS.content} ${tm(lang, 'digest.title')}${date ? ` • ${date}` : ''}`, DISCORD_LIMITS.title),
    description: lines.join('\n') || undefined,
    color: top ? (top.streamer?.color ?? PLATFORM_COLORS[top.channel.platform]) : PLATFORM_COLORS.twitch,
    image: image(top?.item.thumbnailUrl),
    footer: footer(footerText),
    timestamp: isoOrUndefined(options.now ?? Date.now()),
  });

  const components = linkButtonRows(
    entries.slice(0, DIGEST_BUTTONS).map((entry, i) => ({
      label: `${i + 1}. ${digestTitle(entry, lang)}`,
      url: entry.item.url,
      emoji: emojiFor(emojis, entry.channel.platform).component,
    })),
  );
  return { content: '', embeds: [embed], components };
}

// ───────────────────────────── #15 presence-only streams ─────────────────────────────

function presenceName(view: PresenceLiveView): string {
  return cleanText(view.streamer?.displayName) || cleanText(view.displayName);
}

export function presenceTemplateVars(view: PresenceLiveView): { plain: TemplateVars; markdown: TemplateVars } {
  const name = presenceName(view);
  const platform = view.platform ? PLATFORM_LABELS[view.platform] : '';
  const game = cleanText(view.game);
  const values: Record<string, string> = {
    name,
    user: cleanText(view.displayName) || name,
    mention: mentionOf(view.userId),
    platform,
    platforms: platform,
    title: cleanText(view.title),
    game,
    category: game,
    viewers: '',
    url: safeUrl(view.url) ?? '',
    started: discordTimestamp(view.startedAt, 'R') ?? '',
    handle: '',
  };
  return varsPair(values, ['mention', 'url', 'started']);
}

function presenceAvatar(view: PresenceLiveView, options: RenderOptions): string | null {
  return safeUrl(options.avatarUrl) ?? safeUrl(view.avatarUrl);
}

/**
 * Simple live card for a stream detected only through the member's Discord "Streaming" status. Uses the live
 * template (streamer layer included) so customized wording applies; the built-in "updates automatically" footer is
 * replaced by "from Discord status" because presence cards are not refreshed.
 */
export function buildPresenceLiveMessage(view: PresenceLiveView, options: RenderOptions = {}): MessageContent {
  const emojis = options.emojis ?? DEFAULT_PLATFORM_EMOJIS;
  const lang = langOf(view.settings);
  const template = resolveTemplate('live', view.settings.templates, options.template, layersOf(view.settings, view.streamer));
  const { plain, markdown } = presenceTemplateVars(view);
  const rendered = renderTemplate(template, plain, markdown);
  const url = safeUrl(view.url);
  const avatar = presenceAvatar(view, options);
  const usesDefaultFooter = template.footer === defaultTemplatesFor(lang).live.footer;

  const started = discordTimestamp(view.startedAt, 'R');
  const fields = [
    view.platform ? field(`${ICONS.platforms} ${tm(lang, 'presence.platform')}`, `${emojiFor(emojis, view.platform).text} ${PLATFORM_LABELS[view.platform]}`, true) : null,
    field(`${ICONS.game} ${tm(lang, 'presence.game')}`, escapeMarkdown(view.game), true),
    started ? field(`${ICONS.started} ${tm(lang, 'live.started')}`, started, true) : null,
  ];

  const embed = compactEmbed({
    author: author(presenceName(view), avatar, url),
    title: rendered.title || undefined,
    url: url ?? undefined,
    description: rendered.description || undefined,
    color: template.color ?? view.streamer?.color ?? (view.platform ? PLATFORM_COLORS[view.platform] : STREAMING_COLOR),
    fields: fields.filter((f): f is APIEmbedField => f !== null),
    thumbnail: image(avatar),
    footer: footer(usesDefaultFooter ? `${ICONS.platforms} ${tm(lang, 'presence.footer')}` : rendered.footer),
    timestamp: isoOrUndefined(view.startedAt) ?? isoOrUndefined(options.now ?? Date.now()),
  });

  const components = linkButtonRows([
    {
      label: view.platform ? tm(lang, 'live.watchOn', { platform: PLATFORM_LABELS[view.platform] }) : tm(lang, 'presence.watch'),
      url,
      emoji: view.platform ? emojiFor(emojis, view.platform).component : { name: ICONS.live },
    },
  ]);
  return { content: rendered.content, embeds: [embed], components };
}

/** Short "stream ended" card replacing a presence live card (never pings, never silent-flagged: it is an edit). */
export function buildPresenceEndedMessage(view: PresenceLiveView, options: RenderOptions = {}): MessageContent {
  const emojis = options.emojis ?? DEFAULT_PLATFORM_EMOJIS;
  const lang = langOf(view.settings);
  const url = safeUrl(view.url);
  const avatar = presenceAvatar(view, options);
  const startMs = Date.parse(view.startedAt);
  const endValue = view.endedAt ? Date.parse(view.endedAt) : (options.now ?? Date.now());
  const endMs = Number.isFinite(endValue) ? endValue : (options.now ?? Date.now());
  const lines: string[] = [];
  const title = cleanText(view.title);
  if (title) lines.push(`**${escapeMarkdown(truncate(title, MAX_PLATFORM_TITLE))}**`);
  if (Number.isFinite(startMs)) {
    lines.push(`${ICONS.duration} ${tm(lang, 'ended.duration', { duration: formatDurationShort(Math.max(0, endMs - startMs) / 1000, lang) })}`);
  }
  const embed = compactEmbed({
    author: author(presenceName(view), avatar, url),
    title: `${ICONS.ended} ${tm(lang, 'ended.title')}`,
    description: lines.join('\n') || undefined,
    color: ENDED_COLOR,
    footer: footer(`${ICONS.platforms} ${tm(lang, 'presence.footer')}`),
    timestamp: isoOrUndefined(endMs),
  });
  const components = linkButtonRows([
    {
      label: view.platform ? tm(lang, 'summary.channelOn', { platform: PLATFORM_LABELS[view.platform] }) : tm(lang, 'presence.channel'),
      url,
      emoji: view.platform ? emojiFor(emojis, view.platform).component : { name: ICONS.channel },
    },
  ]);
  return { content: '', embeds: [embed], components };
}

// ───────────────────────────── dashboard preview ─────────────────────────────

/** Converts a payload to the dashboard's Discord-like preview JSON (src/shared/api.ts). */
export function toPreview(payload: MessageContent): MessagePreview {
  const embeds: MessagePreview['embeds'] = payload.embeds.map((e) => {
    const out: MessagePreview['embeds'][number] = {};
    if (e.title) out.title = e.title;
    if (e.description) out.description = e.description;
    if (e.url) out.url = e.url;
    if (e.color != null) out.color = e.color;
    if (e.author) out.author = { name: e.author.name, ...(e.author.icon_url ? { icon_url: e.author.icon_url } : {}), ...(e.author.url ? { url: e.author.url } : {}) };
    if (e.thumbnail?.url) out.thumbnail = { url: e.thumbnail.url };
    if (e.image?.url) out.image = { url: e.image.url };
    if (e.fields?.length) out.fields = e.fields.map((f) => ({ name: f.name, value: f.value, ...(f.inline ? { inline: true } : {}) }));
    if (e.footer) out.footer = { text: e.footer.text, ...(e.footer.icon_url ? { icon_url: e.footer.icon_url } : {}) };
    if (e.timestamp) out.timestamp = e.timestamp;
    return out;
  });
  const buttons: MessagePreview['buttons'] = payload.components.flatMap((row) =>
    row.components.map((b) => {
      const emoji = b.emoji?.id ? `<${b.emoji.animated ? 'a' : ''}:${b.emoji.name ?? 'emoji'}:${b.emoji.id}>` : b.emoji?.name;
      return { label: b.label ?? '', url: b.url, ...(emoji ? { emoji } : {}) };
    }),
  );
  return { content: payload.content ? payload.content : null, embeds, buttons };
}

/** Builds the message for a notification type from its view (used by preview/test). */
export function buildMessage(
  type: TemplateType,
  view: LiveView | SummaryView | ContentView,
  options: RenderOptions = {},
): MessageContent {
  switch (type) {
    case 'live':
      return buildLiveMessage(view as LiveView, options);
    case 'summary':
      return buildSummaryMessage(view as SummaryView, options);
    case 'content':
      return buildContentMessage(view as ContentView, options);
  }
}

export interface PreviewOptions {
  /** Template being edited: the guild template, or — with `streamer` — that streamer's template for `type`. */
  template?: TemplateSpec;
  /** #5 — preview as this streamer: real name, mention, color and saved template overrides. */
  streamer?: Streamer | null;
  now?: number;
  /** Fake streamer identity when no streamer is given (default: localized sample streamer). */
  identity?: SampleIdentity;
  /** Avatar to show (e.g. the streamer's cached Discord avatar). */
  avatarUrl?: string | null;
  /** Emojis to render (the dashboard renders text, so unicode by default). */
  emojis?: PlatformEmojis;
}

/**
 * Dashboard preview of a notification type with realistic sample data (pure).
 *
 * Without a streamer, `template` overrides the guild template field by field (the Templates page editor).
 * With a streamer, `template` is that streamer's template being edited: it REPLACES the streamer's saved template
 * for `type` (an omitted field inherits the guild template, exactly like after saving), so the preview always
 * matches what will be sent. Live/content previews show the ping new posts would carry; summaries never ping.
 */
export function buildPreviewMessage(settings: GuildSettings, type: TemplateType, opts: PreviewOptions = {}): MessagePreview {
  const now = opts.now ?? Date.now();
  const base = opts.identity ?? sampleIdentityFor(langOf(settings));
  const streamer = opts.streamer ?? null;
  const identity: SampleIdentity = streamer
    ? { displayName: streamer.displayName, discordUserId: streamer.discordUserId, avatarUrl: opts.avatarUrl ?? base.avatarUrl }
    : { ...base, avatarUrl: opts.avatarUrl ?? base.avatarUrl };
  const view = sampleView(type, settings, now, identity);
  if (streamer) {
    const templates = { ...(streamer.templates ?? {}) };
    if (opts.template) templates[type] = opts.template;
    view.streamer = { ...streamer, templates };
  }
  const message = buildMessage(type, view, {
    emojis: opts.emojis ?? DEFAULT_PLATFORM_EMOJIS,
    avatarUrl: identity.avatarUrl,
    template: streamer ? undefined : opts.template,
    now,
  });
  return toPreview(type === 'summary' ? message : applyPing(message, buildPing(settings, type)));
}
