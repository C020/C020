import { Clock, ExternalLink, Eye, Gamepad2, MessageSquare } from 'lucide-react';
import { useState } from 'react';
import type { LiveNowItem } from '../api/types';
import { useNow } from '../hooks/useNow';
import { cn } from '../lib/cn';
import { formatClockDuration, formatCompact, formatNumber, formatTime, secondsBetween } from '../lib/format';
import { platformAlpha, sortPlatforms } from '../lib/platforms';
import { PlatformBadge, PlatformIcon } from './PlatformIcon';
import { StreamerAvatar } from './StreamerAvatar';
import { t } from '../i18n';

/** Picks the platform shown in the banner: the one with the most viewers. */
function primaryPlatform(item: LiveNowItem): LiveNowItem['platforms'][number] | undefined {
  return [...item.platforms].sort((a, b) => (b.snapshot.viewers ?? -1) - (a.snapshot.viewers ?? -1))[0];
}

export function LiveCard({ item }: { item: LiveNowItem }) {
  const now = useNow(1000);
  const primary = primaryPlatform(item);
  const snapshot = primary?.snapshot;
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumbnail = !thumbFailed ? snapshot?.thumbnailUrl : null;
  const viewers = item.totalViewers ?? item.platforms.reduce((n, p) => n + (p.snapshot.viewers ?? 0), 0);
  const platforms = sortPlatforms(item.platforms);

  return (
    <article className="glass group relative flex flex-col overflow-hidden rounded-2xl transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-[0_24px_48px_-24px_rgb(244_63_94/0.35)]">
      <div className="relative aspect-video overflow-hidden bg-zinc-900">
        {thumbnail ? (
          <img
            src={thumbnail}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setThumbFailed(true)}
            className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <div
            className="grid size-full place-items-center"
            style={{
              background: `radial-gradient(120% 120% at 0% 0%, ${platformAlpha(primary?.platform ?? 'twitch', 0.35)}, transparent 60%), radial-gradient(120% 120% at 100% 100%, rgb(244 63 94 / 0.25), transparent 60%)`,
            }}
          >
            {primary && <PlatformIcon platform={primary.platform} className="size-10 opacity-80" />}
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-zinc-950/90 via-zinc-950/10 to-transparent" />
        <div className="absolute inset-x-3 top-3 flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-2 py-0.5 text-[11px] font-bold tracking-wide text-white shadow-lg shadow-rose-900/40">
            <span className="size-1.5 animate-pulse rounded-full bg-white" />
            LIVE
          </span>
          <span className="inline-flex items-center gap-1 rounded-md bg-black/60 px-2 py-0.5 text-[12px] font-medium tabular-nums text-white backdrop-blur" title={t('live.viewersTitle', { n: formatNumber(viewers) })}>
            <Eye className="size-3.5" />
            {formatCompact(viewers)}
          </span>
        </div>
        <div className="absolute inset-x-3 bottom-3 flex items-center justify-between gap-2 text-[12px] text-zinc-200">
          <span className="inline-flex items-center gap-1 rounded-md bg-black/50 px-2 py-0.5 tabular-nums backdrop-blur" dir="ltr" title={t('live.startedAt', { time: formatTime(item.startedAt) })}>
            <Clock className="size-3.5" />
            {formatClockDuration(secondsBetween(item.startedAt, now))}
          </span>
          {item.peakViewers > 0 && <span className="rounded-md bg-black/50 px-2 py-0.5 backdrop-blur">{t('live.peak', { n: formatCompact(item.peakViewers) })}</span>}
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <StreamerAvatar name={item.streamer.displayName} avatarUrl={item.streamer.avatarUrl} discordUserId={item.streamer.discordUserId} size={40} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-zinc-100">{item.streamer.displayName}</p>
            <p className={cn('mt-0.5 line-clamp-2 text-[13px] leading-relaxed', snapshot?.title ? 'text-zinc-300' : 'italic text-zinc-500')} dir="auto">
              {snapshot?.title || t('common.untitled')}
            </p>
          </div>
        </div>

        {snapshot?.category && (
          <div className="flex items-center gap-2 text-[13px] text-zinc-400">
            {snapshot.categoryImageUrl ? (
              <img src={snapshot.categoryImageUrl} alt="" referrerPolicy="no-referrer" className="h-7 w-5 rounded-[3px] object-cover ring-1 ring-white/10" />
            ) : (
              <Gamepad2 className="size-4 shrink-0" />
            )}
            <span className="truncate" dir="auto">
              {snapshot.category}
            </span>
          </div>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          {platforms.map((p) => (
            <PlatformBadge key={p.channelId} platform={p.platform} live viewers={p.snapshot.viewers} href={p.url} title={p.displayName} />
          ))}
        </div>

        {item.messageUrl && (
          <a
            href={item.messageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="-mx-4 -mb-4 mt-1 flex items-center justify-center gap-1.5 border-t border-white/[0.06] py-2.5 text-[12.5px] text-zinc-400 transition-colors hover:bg-white/[0.03] hover:text-zinc-200"
          >
            <MessageSquare className="size-3.5" />
            {t('live.openInDiscord')}
            <ExternalLink className="size-3" />
          </a>
        )}
      </div>
    </article>
  );
}
