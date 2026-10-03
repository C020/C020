import { CONTENT_KIND_LABELS_AR, CONTENT_KINDS, PLATFORM_LABELS, PLATFORMS, type ContentKind, type Platform } from '../../../src/core/types';

export { CONTENT_KIND_LABELS_AR, CONTENT_KINDS, PLATFORM_LABELS, PLATFORMS };
export type { ContentKind, Platform };

export interface PlatformMeta {
  label: string;
  /** Brand color (hex). */
  color: string;
  /** Readable text color on top of the brand color. */
  onColor: string;
  placeholder: string;
  hint: string;
  /** Content kinds this platform can actually produce. */
  contentKinds: ContentKind[];
}

export const PLATFORM_META: Record<Platform, PlatformMeta> = {
  twitch: {
    label: PLATFORM_LABELS.twitch,
    color: '#9146ff',
    onColor: '#ffffff',
    placeholder: 'اسم المستخدم أو twitch.tv/…',
    hint: 'اسم الحساب (login) أو رابط القناة',
    contentKinds: ['vod', 'highlight', 'video', 'clip'],
  },
  kick: {
    label: PLATFORM_LABELS.kick,
    color: '#53fc18',
    onColor: '#0b0f0a',
    placeholder: 'اسم المستخدم أو kick.com/…',
    hint: 'الـ slug اللي في رابط القناة',
    contentKinds: ['vod', 'clip'],
  },
  youtube: {
    label: PLATFORM_LABELS.youtube,
    color: '#ff0000',
    onColor: '#ffffff',
    placeholder: '@handle أو رابط القناة',
    hint: '@handle أو رابط القناة أو آيدي يبدأ بـ UC',
    contentKinds: ['video', 'short', 'vod'],
  },
  tiktok: {
    label: PLATFORM_LABELS.tiktok,
    color: '#fe2c55',
    onColor: '#ffffff',
    placeholder: '@username أو رابط الحساب',
    hint: 'اسم المستخدم (بدون أو مع @) أو رابط الحساب',
    contentKinds: ['video'],
  },
};

export const CONTENT_KIND_HINTS: Record<ContentKind, string> = {
  video: 'فيديو عادي مرفوع (يوتيوب، رفع تويتش، منشور تيك توك)',
  short: 'مقاطع YouTube Shorts',
  vod: 'تسجيل بث سابق (VOD / إعادة البث)',
  highlight: 'هايلايت تويتش',
  clip: 'كليبات مقصوصة من البث (تويتش وكيك)',
};

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
