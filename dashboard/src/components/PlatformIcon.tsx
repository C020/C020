import type { Platform } from '../api/types';
import { cn, withDefaults } from '../lib/cn';
import { formatCompact } from '../lib/format';
import { PLATFORM_META, platformAlpha } from '../lib/platforms';
import { LiveDot } from './ui/Badge';

/** Simplified brand glyphs (24×24), drawn inline so no icon font or external request is needed. */
const GLYPHS: Record<Platform, string> = {
  twitch:
    'M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0 1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z',
  kick: 'M1.5 1.5h7.6v5.3h2.5V4.1h2.6V1.5h7.6v7.6h-2.6v2.6h-2.6v.6h2.6v2.6h2.6v7.6h-7.6v-2.6h-2.6v-2.6H9.1v5.2H1.5z',
  youtube:
    'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12z',
  tiktok:
    'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z',
};

export interface PlatformIconProps {
  platform: Platform;
  className?: string;
  /** Use the brand color (default) or inherit currentColor. */
  colored?: boolean;
  title?: string;
}

export function PlatformIcon({ platform, className, colored = true, title }: PlatformIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('shrink-0', withDefaults(className, ['size-', 'size-4']))}
      fill={colored ? PLATFORM_META[platform].color : 'currentColor'}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <path d={GLYPHS[platform]} />
    </svg>
  );
}

/** Square tile with the brand glyph (cards, pickers). */
export function PlatformTile({ platform, size = 'md', className }: { platform: Platform; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const dims = { sm: 'size-7 rounded-lg', md: 'size-9 rounded-xl', lg: 'size-11 rounded-2xl' }[size];
  const icon = { sm: 'size-3.5', md: 'size-[18px]', lg: 'size-5' }[size];
  return (
    <span
      className={cn('grid shrink-0 place-items-center ring-1 ring-inset', dims, className)}
      style={{ backgroundColor: platformAlpha(platform, 0.12), boxShadow: `inset 0 0 0 1px ${platformAlpha(platform, 0.25)}` }}
    >
      <PlatformIcon platform={platform} className={icon} />
    </span>
  );
}

export interface PlatformBadgeProps {
  platform: Platform;
  live?: boolean;
  viewers?: number | null;
  label?: string;
  href?: string;
  className?: string;
  title?: string;
}

/** Pill with the brand glyph, optional live dot and viewer count. */
export function PlatformBadge({ platform, live, viewers, label, href, className, title }: PlatformBadgeProps) {
  const meta = PLATFORM_META[platform];
  const content = (
    <>
      <PlatformIcon platform={platform} className="size-3.5" />
      <bdi className="text-zinc-200">{label ?? meta.label}</bdi>
      {live && <LiveDot className="ms-0.5" />}
      {live && viewers != null && <span className="tabular-nums text-zinc-300">{formatCompact(viewers)}</span>}
    </>
  );
  const classes = cn(
    'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium transition-colors',
    href && 'hover:brightness-125',
    className,
  );
  const style = {
    backgroundColor: platformAlpha(platform, live ? 0.16 : 0.08),
    boxShadow: `inset 0 0 0 1px ${platformAlpha(platform, live ? 0.4 : 0.18)}`,
  };
  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={classes} style={style} title={title ?? meta.label} onClick={(e) => e.stopPropagation()}>
        {content}
      </a>
    );
  }
  return (
    <span className={classes} style={style} title={title}>
      {content}
    </span>
  );
}
