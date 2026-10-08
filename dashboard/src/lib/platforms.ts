import { CONTENT_KIND_LABELS_AR, CONTENT_KINDS, PLATFORM_LABELS, PLATFORMS, type ContentKind, type Platform } from '../../../src/core/types';

import { translatedRecord } from '../i18n/core';

export { CONTENT_KIND_LABELS_AR, CONTENT_KINDS, PLATFORM_LABELS, PLATFORMS };
export type { ContentKind, Platform };

export interface PlatformMeta {
  readonly label: string;
  /** Brand color (hex). */
  color: string;
  /** Readable text color on top of the brand color. */
  onColor: string;
  /** Translated on read. */
  readonly placeholder: string;
  /** Translated on read. */
  readonly hint: string;
  /** Content kinds this platform can actually produce. */
  contentKinds: ContentKind[];
}

const PLATFORM_TEXT = translatedRecord({
  twitchPlaceholder: 'platforms.twitch.placeholder',
  twitchHint: 'platforms.twitch.hint',
  kickPlaceholder: 'platforms.kick.placeholder',
  kickHint: 'platforms.kick.hint',
  youtubePlaceholder: 'platforms.youtube.placeholder',
  youtubeHint: 'platforms.youtube.hint',
  tiktokPlaceholder: 'platforms.tiktok.placeholder',
  tiktokHint: 'platforms.tiktok.hint',
});

export const PLATFORM_META: Record<Platform, PlatformMeta> = {
  twitch: {
    label: PLATFORM_LABELS.twitch,
    color: '#9146ff',
    onColor: '#ffffff',
    get placeholder() {
      return PLATFORM_TEXT[`twitchPlaceholder`];
    },
    get hint() {
      return PLATFORM_TEXT[`twitchHint`];
    },
    contentKinds: ['vod', 'highlight', 'video', 'clip'],
  },
  kick: {
    label: PLATFORM_LABELS.kick,
    color: '#53fc18',
    onColor: '#0b0f0a',
    get placeholder() {
      return PLATFORM_TEXT[`kickPlaceholder`];
    },
    get hint() {
      return PLATFORM_TEXT[`kickHint`];
    },
    contentKinds: ['vod', 'clip'],
  },
  youtube: {
    label: PLATFORM_LABELS.youtube,
    color: '#ff0000',
    onColor: '#ffffff',
    get placeholder() {
      return PLATFORM_TEXT[`youtubePlaceholder`];
    },
    get hint() {
      return PLATFORM_TEXT[`youtubeHint`];
    },
    contentKinds: ['video', 'short', 'vod'],
  },
  tiktok: {
    label: PLATFORM_LABELS.tiktok,
    color: '#fe2c55',
    onColor: '#ffffff',
    get placeholder() {
      return PLATFORM_TEXT[`tiktokPlaceholder`];
    },
    get hint() {
      return PLATFORM_TEXT[`tiktokHint`];
    },
    contentKinds: ['video'],
  },
};

/** Content kind names in the dashboard language (translated on read). */
export const CONTENT_KIND_LABELS: Readonly<Record<ContentKind, string>> = translatedRecord({
  video: 'contentKind.video',
  short: 'contentKind.short',
  vod: 'contentKind.vod',
  highlight: 'contentKind.highlight',
  clip: 'contentKind.clip',
});

export const CONTENT_KIND_HINTS: Readonly<Record<ContentKind, string>> = translatedRecord({
  video: 'contentKind.videoHint',
  short: 'contentKind.shortHint',
  vod: 'contentKind.vodHint',
  highlight: 'contentKind.highlightHint',
  clip: 'contentKind.clipHint',
});

/** Rgba string of a platform color, for glows and translucent backgrounds. */
export function platformAlpha(platform: Platform, alpha: number): string {
  const hex = PLATFORM_META[platform].color.slice(1);
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `rgb(${r} ${g} ${b} / ${alpha})`;
}

export function sortPlatforms<T extends { platform: Platform }>(items: T[]): T[] {
  return [...items].sort((a, b) => PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform));
}
