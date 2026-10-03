/**
 * Platform emojis used in embeds and link buttons.
 *
 * Unicode emojis work everywhere. For real platform logos, upload application emojis named
 * "twitch", "kick", "youtube" and "tiktok" in the Discord Developer Portal (Your App → Emojis):
 * the bot picks them up automatically at startup and falls back to unicode if Discord rejects them.
 */
import type { Platform } from '../core/types.js';
import { PLATFORMS } from '../core/types.js';

export interface EmojiRef {
  /** Inline form for embed text: "💜" or "<:twitch:123>". */
  text: string;
  /** Form for message components. */
  component: { id?: string; name: string; animated?: boolean };
}

export type PlatformEmojis = Record<Platform, EmojiRef>;

const unicode = (char: string): EmojiRef => ({ text: char, component: { name: char } });

export const DEFAULT_PLATFORM_EMOJIS: Readonly<PlatformEmojis> = Object.freeze({
  twitch: unicode('💜'),
  kick: unicode('💚'),
  youtube: unicode('▶️'),
  tiktok: unicode('🎵'),
});

/** Emojis for the non-platform parts of messages (kept here so the look stays consistent). */
export const ICONS = {
  live: '🔴',
  ended: '⚫',
  viewers: '👀',
  game: '🎮',
  started: '⏱️',
  duration: '⏱️',
  peak: '📈',
  average: '📊',
  platforms: '📡',
  total: '👥',
  title: '📝',
  vod: '📼',
  channel: '📺',
  published: '📅',
  views: '👁️',
  content: '🎬',
  clock: '🕒',
  test: '🧪',
} as const;

export interface ApplicationEmojiLike {
  id: string;
  name: string | null;
  animated?: boolean | null;
}

const NAME_PATTERNS: Record<Platform, RegExp> = {
  twitch: /^(?:sb_?)?twitch(?:_?logo)?$/i,
  kick: /^(?:sb_?)?kick(?:_?logo)?$/i,
  youtube: /^(?:sb_?)?(?:youtube|yt)(?:_?logo)?$/i,
  tiktok: /^(?:sb_?)?tiktok(?:_?logo)?$/i,
};

/** Builds the emoji set from the application's custom emojis; platforms without a match keep unicode. */
export function resolvePlatformEmojis(emojis: Iterable<ApplicationEmojiLike>): PlatformEmojis {
  const result: PlatformEmojis = { ...DEFAULT_PLATFORM_EMOJIS };
  const list = [...emojis];
  for (const platform of PLATFORMS) {
    const match = list.find((e) => e.name && /^\d{17,20}$/.test(e.id) && NAME_PATTERNS[platform].test(e.name));
    if (!match?.name) continue;
    const animated = match.animated === true;
    result[platform] = {
      text: `<${animated ? 'a' : ''}:${match.name}:${match.id}>`,
      component: animated ? { id: match.id, name: match.name, animated: true } : { id: match.id, name: match.name },
    };
  }
  return result;
}

export function hasCustomEmojis(emojis: PlatformEmojis): boolean {
  return PLATFORMS.some((p) => emojis[p].component.id !== undefined);
}
