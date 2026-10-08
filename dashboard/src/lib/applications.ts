/** Pure helpers for the applications page (#9). */
import type { Platform } from '../api/types';

export type DecidedTab = 'pending' | 'approved' | 'rejected';

export function decidableStatus(value: string | null): DecidedTab {
  return value === 'approved' || value === 'rejected' ? value : 'pending';
}

const HANDLE = /^@?([A-Za-z0-9_.-]{1,64})$/;

/**
 * Clickable profile URL for what an applicant typed (a URL on the right platform, or a bare handle);
 * null when it cannot be turned into a safe link.
 */
export function applicationAccountUrl(platform: Platform, input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      return url.toString();
    } catch {
      return null;
    }
  }
  const m = HANDLE.exec(value);
  if (!m) return null;
  const handle = m[1]!;
  switch (platform) {
    case 'twitch':
      return `https://www.twitch.tv/${handle}`;
    case 'kick':
      return `https://kick.com/${handle}`;
    case 'youtube':
      return `https://www.youtube.com/@${handle}`;
    case 'tiktok':
      return `https://www.tiktok.com/@${handle}`;
  }
}

/** Pending count shown in the nav badge ("99+" past 99). */
export function pendingBadge(count: number | null | undefined): string | null {
  if (!count || count <= 0 || !Number.isFinite(count)) return null;
  return count > 99 ? '99+' : String(Math.trunc(count));
}
