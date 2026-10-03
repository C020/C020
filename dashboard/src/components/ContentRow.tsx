import { Film, Play } from 'lucide-react';
import { useState } from 'react';
import type { ContentDto } from '../api/types';
import { useNow } from '../hooks/useNow';
import { formatDateTime, formatRelative } from '../lib/format';
import { CONTENT_KIND_LABELS_AR, PLATFORM_META } from '../lib/platforms';
import { PlatformIcon } from './PlatformIcon';

export function ContentRow({ item }: { item: ContentDto }) {
  const now = useNow(60_000);
  const [thumbFailed, setThumbFailed] = useState(false);
  const vertical = item.kind === 'short' || item.platform === 'tiktok';
  return (
    <a href={item.url} target="_blank" rel="noopener noreferrer" className="group flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-white/[0.04]">
      <div className={vertical ? 'relative h-16 w-11 shrink-0 overflow-hidden rounded-lg bg-zinc-800' : 'relative h-14 w-24 shrink-0 overflow-hidden rounded-lg bg-zinc-800'}>
        {item.thumbnailUrl && !thumbFailed ? (
          <img src={item.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setThumbFailed(true)} className="size-full object-cover" />
        ) : (
          <div className="grid size-full place-items-center text-zinc-600">
            <Film className="size-5" />
          </div>
        )}
        <div className="absolute inset-0 grid place-items-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
          <Play className="size-5 fill-white text-white" />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-[13px] font-medium leading-snug text-zinc-200" dir="auto">
          {item.title || 'بدون عنوان'}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-zinc-500">
          <span className="inline-flex items-center gap-1">
            <PlatformIcon platform={item.platform} className="size-3" />
            {CONTENT_KIND_LABELS_AR[item.kind]}
          </span>
          {item.streamer && <span className="truncate">{item.streamer.displayName}</span>}
          <span title={formatDateTime(item.publishedAt)}>{formatRelative(item.publishedAt, now)}</span>
        </div>
      </div>
      <span className="sr-only">{PLATFORM_META[item.platform].label}</span>
    </a>
  );
}
