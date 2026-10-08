import { ChevronLeft, Search, TriangleAlert, UserPlus, Users, UserRoundX } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useStreamers, useUpdateStreamer } from '../../api/queries';
import type { Platform, StreamerDto } from '../../api/types';
import { PageHeader } from '../../components/PageHeader';
import { PlatformBadge, PlatformIcon } from '../../components/PlatformIcon';
import { StreamerAvatar } from '../../components/StreamerAvatar';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { Input } from '../../components/ui/Input';
import { Segmented } from '../../components/ui/Segmented';
import { SkeletonRows } from '../../components/ui/Skeleton';
import { Switch } from '../../components/ui/Switch';
import { useGuild } from '../../hooks/useGuild';
import { cn } from '../../lib/cn';
import { formatCompact, formatHours, formatNumber } from '../../lib/format';
import { PLATFORM_META, PLATFORMS, sortPlatforms } from '../../lib/platforms';
import { filterStreamers, hasIssues, type SortKey, type StatusFilter } from '../../lib/streamers';
import { AddStreamerModal } from './AddStreamerModal';
import { StreamerDrawer } from './StreamerDrawer';
import { t } from '../../i18n';

function withCount(label: string, count: number): string {
  return count ? `${label} (${count})` : label;
}

export default function StreamersPage() {
  const { guildId, basePath } = useGuild();
  const { streamerId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const streamers = useStreamers(guildId);

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [sort, setSort] = useState<SortKey>('live');

  const list = streamers.data ?? [];
  const visible = useMemo(() => filterStreamers(list, query, status, platform, sort), [list, query, status, platform, sort]);
  const counts = useMemo(
    () => ({ live: list.filter((s) => s.isLive).length, disabled: list.filter((s) => !s.enabled).length, issues: list.filter(hasIssues).length }),
    [list],
  );

  const addOpen = params.get('add') === '1';
  const setAddOpen = (open: boolean): void => {
    const p = new URLSearchParams(params);
    if (open) p.set('add', '1');
    else p.delete('add');
    setParams(p, { replace: true });
  };

  const selectedId = streamerId ? Number(streamerId) : null;
  const selected = selectedId ? (list.find((s) => s.id === selectedId) ?? null) : null;
  const missing = selectedId !== null && !!streamers.data && !selected;
  const openStreamer = (id: number): void => void navigate(`${basePath}/streamers/${id}${window.location.search}`);
  const closeDrawer = (): void => void navigate(`${basePath}/streamers${window.location.search}`, { replace: true });

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('nav.streamers')}
        icon={<Users className="size-5" />}
        description={streamers.data ? t('streamers.headerCounts', { count: list.length, live: formatNumber(counts.live) }) : t('streamers.headerDesc')}
        actions={
          <Button variant="primary" onClick={() => setAddOpen(true)} icon={<UserPlus className="size-4" />}>
            {t('streamers.add')}
          </Button>
        }
      />

      {list.length > 0 && (
        <Card className="space-y-3 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <Input
              className="lg:w-80"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('streamers.search')}
              leading={<Search className="size-4" />}
              aria-label={t('common.search')}
            />
            <Segmented<StatusFilter>
              size="sm"
              value={status}
              onChange={setStatus}
              ariaLabel={t('streamers.statusFilter')}
              options={[
                { value: 'all', label: t('common.all') },
                { value: 'live', label: withCount(t('streamers.filter.live'), counts.live) },
                { value: 'disabled', label: withCount(t('streamers.filter.disabled'), counts.disabled) },
                { value: 'issues', label: withCount(t('streamers.filter.issues'), counts.issues) },
              ]}
            />
            <div className="flex items-center gap-1.5 lg:ms-auto">
              {PLATFORMS.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={platform === p}
                  title={PLATFORM_META[p].label}
                  onClick={() => setPlatform(platform === p ? null : p)}
                  className={cn(
                    'grid size-8 place-items-center rounded-lg ring-1 ring-inset transition-colors',
                    platform === p ? 'bg-white/[0.08] ring-white/25' : 'ring-white/[0.07] opacity-60 hover:opacity-100',
                  )}
                >
                  <PlatformIcon platform={p} className="size-4" />
                </button>
              ))}
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                aria-label={t('streamers.sort')}
                className="h-8 rounded-lg bg-zinc-900/70 px-2 text-xs text-zinc-300 ring-1 ring-inset ring-white/[0.08] focus:outline-none focus:ring-violet-500/60"
              >
                <option value="live">{t('streamers.sort.live')}</option>
                <option value="name">{t('streamers.sort.name')}</option>
                <option value="hours">{t('streamers.sort.hours')}</option>
                <option value="newest">{t('streamers.sort.newest')}</option>
              </select>
            </div>
          </div>
        </Card>
      )}

      {streamers.isPending ? (
        <Card className="p-5">
          <SkeletonRows rows={6} />
        </Card>
      ) : streamers.isError && !streamers.data ? (
        <Card>
          <ErrorState error={streamers.error} onRetry={() => void streamers.refetch()} retrying={streamers.isFetching} />
        </Card>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Users className="size-6" />}
            title={t('streamers.emptyTitle')}
            description={t('streamers.emptyDesc')}
            action={
              <Button variant="primary" onClick={() => setAddOpen(true)} icon={<UserPlus className="size-4" />}>
                {t('streamers.addFirst')}
              </Button>
            }
          />
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState compact icon={<Search className="size-5" />} title={t('common.noResults')} description={t('streamers.noResultsDesc')} />
        </Card>
      ) : (
        <Card className="divide-y divide-white/[0.05] overflow-hidden">
          {visible.map((s) => (
            <StreamerRow key={s.id} streamer={s} onOpen={() => openStreamer(s.id)} />
          ))}
        </Card>
      )}

      <AddStreamerModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(created) => {
          const p = new URLSearchParams(params);
          p.delete('add');
          navigate(`${basePath}/streamers/${created.id}${p.toString() ? `?${p}` : ''}`, { replace: true });
        }}
      />
      <StreamerDrawer streamer={selected} missing={missing} onClose={closeDrawer} />
    </div>
  );
}

function StreamerRow({ streamer, onOpen }: { streamer: StreamerDto; onOpen: () => void }) {
  const { guildId } = useGuild();
  const update = useUpdateStreamer(guildId);
  const accounts = sortPlatforms(streamer.accounts);
  const errors = accounts.filter((a) => a.lastError).length;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'group grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3.5 transition-colors hover:bg-white/[0.03] focus-visible:bg-white/[0.04] focus-visible:outline-none sm:px-5 md:grid-cols-[auto_minmax(0,1.3fr)_minmax(0,1.4fr)_minmax(0,1fr)_auto_auto]',
        !streamer.enabled && 'opacity-60',
      )}
    >
      <StreamerAvatar name={streamer.displayName} avatarUrl={streamer.avatarUrl} discordUserId={streamer.discordUserId} live={streamer.isLive} size={42} />

      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate font-medium text-zinc-100" dir="auto">{streamer.displayName}</p>
          {streamer.inGuild === false && (
            <span title={t('streamers.leftGuild')}>
              <UserRoundX className="size-4 shrink-0 text-amber-400" />
            </span>
          )}
          {errors > 0 && (
            <span title={t('streamers.accountErrors', { count: errors })}>
              <TriangleAlert className="size-4 shrink-0 text-rose-400" />
            </span>
          )}
        </div>
        <p dir="ltr" className="truncate text-right font-mono ltr:text-left text-[11px] text-zinc-600">
          {streamer.discordUserId}
        </p>
      </div>

      <div className="col-span-3 col-start-1 row-start-2 flex flex-wrap gap-1.5 md:col-span-1 md:col-start-auto md:row-start-auto">
        {accounts.length === 0 ? (
          <Badge tone="warning">{t('streamers.noAccounts')}</Badge>
        ) : (
          accounts.map((a) => <PlatformBadge key={a.id} platform={a.platform} live={a.isLive} viewers={a.snapshot?.viewers} label={a.displayName} title={a.handle} />)
        )}
      </div>

      <div className="hidden text-[12px] text-zinc-500 md:block">
        <span className="tabular-nums text-zinc-300">{formatNumber(streamer.stats.sessions30d)}</span> {t('streamers.streamsUnit', { count: streamer.stats.sessions30d })} •{' '}
        <span className="tabular-nums text-zinc-300">{formatHours(streamer.stats.hours30d)}</span>
        {streamer.stats.peakViewers30d > 0 && (
          <>
            {' '}
            • {t('streamers.peakWord')} <span className="tabular-nums text-zinc-300">{formatCompact(streamer.stats.peakViewers30d)}</span>
          </>
        )}
        <p className="text-[11px] text-zinc-600">{t('streamers.last30')}</p>
      </div>

      <div onClick={(e) => e.stopPropagation()} className="col-start-3 row-start-1 md:col-start-auto md:row-start-auto">
        <Switch
          checked={streamer.enabled}
          onChange={(enabled) => update.mutate({ id: streamer.id, body: { enabled } })}
          label={streamer.enabled ? t('streamers.disable') : t('streamers.enable')}
        />
      </div>

      <ChevronLeft className="hidden size-4 text-zinc-600 transition-transform group-hover:text-zinc-300 md:block ltr:rotate-180 rtl:group-hover:-translate-x-0.5 ltr:group-hover:translate-x-0.5" />
    </div>
  );
}
