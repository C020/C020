import type { Platform, StreamerDto } from '../api/types';

export type StatusFilter = 'all' | 'live' | 'disabled' | 'issues';
export type SortKey = 'live' | 'name' | 'hours' | 'newest';

export const hasIssues = (s: StreamerDto): boolean => s.inGuild === false || s.accounts.length === 0 || s.accounts.some((a) => a.lastError);

/** Search + filters + sort for the streamers list. */
export function filterStreamers(list: StreamerDto[], query: string, status: StatusFilter, platform: Platform | null, sort: SortKey): StreamerDto[] {
  const q = query.trim().toLowerCase();
  const filtered = list.filter((s) => {
    if (status === 'live' && !s.isLive) return false;
    if (status === 'disabled' && s.enabled) return false;
    if (status === 'issues' && !hasIssues(s)) return false;
    if (platform && !s.accounts.some((a) => a.platform === platform)) return false;
    if (!q) return true;
    return (
      s.displayName.toLowerCase().includes(q) ||
      s.discordUserId.includes(q) ||
      s.accounts.some((a) => a.handle.toLowerCase().includes(q) || a.displayName.toLowerCase().includes(q))
    );
  });
  const byName = (a: StreamerDto, b: StreamerDto): number => a.displayName.localeCompare(b.displayName, 'ar');
  return filtered.sort((a, b) => {
    switch (sort) {
      case 'name':
        return byName(a, b);
      case 'hours':
        return b.stats.hours30d - a.stats.hours30d || byName(a, b);
      case 'newest':
        return b.createdAt.localeCompare(a.createdAt);
      case 'live':
      default:
        return Number(b.isLive) - Number(a.isLive) || Number(b.enabled) - Number(a.enabled) || byName(a, b);
    }
  });
}
