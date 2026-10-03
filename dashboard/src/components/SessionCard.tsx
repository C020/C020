import { CalendarClock, Clock, ExternalLink, Eye, Gamepad2, MessageSquare, PlayCircle, TrendingUp } from 'lucide-react';
import type { ReactNode } from 'react';
import type { SessionDto } from '../api/types';
import { useNow } from '../hooks/useNow';
import { cn } from '../lib/cn';
import { formatCompact, formatDateTime, formatDurationLong, formatDurationShort, formatRelative, secondsBetween } from '../lib/format';
import { PLATFORM_META } from '../lib/platforms';
import { PlatformBadge, PlatformIcon } from './PlatformIcon';
import { StreamerAvatar } from './StreamerAvatar';
import { Badge, LiveDot } from './ui/Badge';

const CATEGORY_COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#ec4899', '#10b981', '#6366f1', '#f97316'];

function sessionDuration(session: SessionDto, now: number): number {
  return session.status === 'live' ? secondsBetween(session.startedAt, now) : session.durationSec;
}

/** Compact one-line session (overview feed). */
export function SessionRow({ session }: { session: SessionDto }) {
  const now = useNow(30_000);
  const live = session.status === 'live';
  return (
    <div className="flex items-center gap-3 py-3">
      <StreamerAvatar name={session.streamer.displayName} avatarUrl={session.streamer.avatarUrl} discordUserId={session.streamer.discordUserId} live={live} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-zinc-200">{session.streamer.displayName}</p>
          <div className="flex shrink-0 items-center gap-1">
            {session.platforms.map((p) => (
              <PlatformIcon key={p} platform={p} className="size-3.5" title={PLATFORM_META[p].label} />
            ))}
          </div>
        </div>
        <p className="truncate text-xs text-zinc-500" dir="auto">
          {session.categories[0]?.name ?? session.titles[session.titles.length - 1] ?? '—'}
        </p>
      </div>
      <div className="shrink-0 text-end">
        <p className="text-[13px] tabular-nums text-zinc-300">{formatDurationShort(sessionDuration(session, now))}</p>
        <p className="text-[11px] text-zinc-500">{live ? <span className="text-rose-300">لايف الحين</span> : formatRelative(session.endedAt ?? session.startedAt, now)}</p>
      </div>
    </div>
  );
}

/** Full session card with categories breakdown, VODs and stats (history page). */
export function SessionCard({ session }: { session: SessionDto }) {
  const now = useNow(live(session) ? 1000 : 60_000);
  const duration = sessionDuration(session, now);
  const totalCategorySeconds = session.categories.reduce((n, c) => n + c.seconds, 0);
  const lastTitle = session.titles[session.titles.length - 1];

  return (
    <article className="glass rounded-2xl p-4 sm:p-5">
      <div className="flex flex-wrap items-start gap-3">
        <StreamerAvatar name={session.streamer.displayName} avatarUrl={session.streamer.avatarUrl} discordUserId={session.streamer.discordUserId} live={live(session)} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-zinc-100">{session.streamer.displayName}</h3>
            {live(session) ? (
              <Badge tone="live">
                <LiveDot />
                لايف الحين
              </Badge>
            ) : (
              <Badge tone="neutral">انتهى</Badge>
            )}
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500" title={formatDateTime(session.startedAt)}>
            <CalendarClock className="size-3.5" />
            {formatDateTime(session.startedAt)}
            {session.endedAt && <span className="text-zinc-600">← {formatRelative(session.endedAt, now)}</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {session.platforms.map((p) => (
            <PlatformBadge key={p} platform={p} />
          ))}
        </div>
      </div>

      {lastTitle && (
        <p className="mt-3 line-clamp-2 text-[13.5px] leading-relaxed text-zinc-300" dir="auto">
          {lastTitle}
          {session.titles.length > 1 && <span className="ms-2 text-xs text-zinc-500">(+{session.titles.length - 1} عناوين)</span>}
        </p>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat icon={<Clock className="size-4" />} label="المدة" value={formatDurationLong(duration)} />
        <Stat icon={<TrendingUp className="size-4" />} label="أعلى مشاهدين" value={formatCompact(session.peakViewers)} />
        <Stat icon={<Eye className="size-4" />} label="متوسط المشاهدين" value={session.avgViewers == null ? '—' : formatCompact(Math.round(session.avgViewers))} />
        <Stat icon={<Gamepad2 className="size-4" />} label="الأقسام" value={String(session.categories.length)} />
      </dl>

      {session.categories.length > 0 && (
        <div className="mt-4 space-y-2">
          {totalCategorySeconds > 0 && (
            <div className="flex h-2 overflow-hidden rounded-full bg-white/[0.04]">
              {session.categories.map((c, i) => (
                <div
                  key={`${c.name}-${i}`}
                  title={`${c.name} • ${formatDurationShort(c.seconds)}`}
                  style={{ width: `${(c.seconds / totalCategorySeconds) * 100}%`, backgroundColor: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }}
                />
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {session.categories.map((c, i) => (
              <span key={`${c.name}-${i}`} className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.04] py-1 pe-2 ps-1 text-xs text-zinc-300 ring-1 ring-inset ring-white/[0.06]">
                {c.imageUrl ? (
                  <img src={c.imageUrl} alt="" referrerPolicy="no-referrer" className="h-5 w-[15px] rounded-[2px] object-cover" />
                ) : (
                  <span className="size-2.5 rounded-full" style={{ backgroundColor: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }} />
                )}
                <span dir="auto">{c.name}</span>
                {c.seconds > 0 && <span className="tabular-nums text-zinc-500">{formatDurationShort(c.seconds)}</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {(session.vodUrls.length > 0 || session.messageUrl) && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
          {session.vodUrls.map((vod) => (
            <a
              key={vod.url}
              href={vod.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.04] px-2.5 text-xs text-zinc-300 ring-1 ring-inset ring-white/[0.08] transition-colors hover:bg-white/[0.08]"
            >
              <PlayCircle className="size-3.5" />
              إعادة {PLATFORM_META[vod.platform].label}
              <PlatformIcon platform={vod.platform} className="size-3.5" />
            </a>
          ))}
          {session.messageUrl && (
            <a href={session.messageUrl} target="_blank" rel="noopener noreferrer" className="ms-auto inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200">
              <MessageSquare className="size-3.5" />
              رسالة ديسكورد
              <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      )}
    </article>
  );
}

function live(session: SessionDto): boolean {
  return session.status === 'live';
}

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className={cn('rounded-xl bg-white/[0.03] px-3 py-2.5 ring-1 ring-inset ring-white/[0.05]')}>
      <dt className="flex items-center gap-1.5 text-[11.5px] text-zinc-500">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 truncate text-sm font-semibold tabular-nums text-zinc-100">{value}</dd>
    </div>
  );
}
