import { Activity, CircleAlert, Info, ListFilter, Search, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAuditFeed } from '../api/queries';
import type { AuditLevel } from '../api/types';
import { AuditRow } from '../components/AuditRow';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Input } from '../components/ui/Input';
import { Segmented } from '../components/ui/Segmented';
import { SkeletonRows } from '../components/ui/Skeleton';
import { useGuild } from '../hooks/useGuild';
import { useInView } from '../hooks/useInView';
import { useSession } from '../hooks/useSession';
import { auditCategory, AUDIT_CATEGORY_LABELS, type AuditCategory } from '../lib/audit';
import { formatWeekday, localDayKey } from '../lib/format';
import { t } from '../i18n';

type LevelFilter = AuditLevel | 'all';

export default function ActivityPage() {
  const { guildId } = useGuild();
  const me = useSession();
  const [level, setLevel] = useState<LevelFilter>('all');
  const [category, setCategory] = useState<AuditCategory | 'all'>('all');
  const [search, setSearch] = useState('');
  const feed = useAuditFeed(guildId, level);

  const entries = useMemo(() => feed.data?.pages.flat() ?? [], [feed.data]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter(
      (e) => (category === 'all' || auditCategory(e.action) === category) && (!q || e.message.toLowerCase().includes(q) || e.action.toLowerCase().includes(q)),
    );
  }, [entries, category, search]);

  // Group by day for readability.
  const groups = useMemo(() => {
    const out: Array<{ day: string; items: typeof filtered }> = [];
    for (const entry of filtered) {
      const day = localDayKey(entry.createdAt);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(entry);
      else out.push({ day, items: [entry] });
    }
    return out;
  }, [filtered]);

  const canLoadMore = feed.hasNextPage && !feed.isFetchingNextPage;
  const sentinel = useInView<HTMLDivElement>(() => {
    if (canLoadMore) void feed.fetchNextPage();
  }, canLoadMore);

  const presentCategories = useMemo(() => [...new Set(entries.map((e) => auditCategory(e.action)))], [entries]);

  return (
    <div className="space-y-6">
      <PageHeader title={t('nav.activity')} icon={<Activity className="size-5" />} description={t('activity.desc')} />

      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <Segmented<LevelFilter>
            value={level}
            onChange={setLevel}
            ariaLabel={t('activity.level')}
            options={[
              { value: 'all', label: t('common.all'), icon: <ListFilter className="size-3.5" /> },
              { value: 'info', label: t('activity.info'), icon: <Info className="size-3.5" /> },
              { value: 'warn', label: t('activity.warn'), icon: <TriangleAlert className="size-3.5" /> },
              { value: 'error', label: t('activity.error'), icon: <CircleAlert className="size-3.5" /> },
            ]}
          />
          <Input
            className="lg:ms-auto lg:w-72"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('activity.search')}
            leading={<Search className="size-4" />}
          />
        </div>
        {presentCategories.length > 1 && (
          <div className="scrollbar-none mt-3 flex gap-1.5 overflow-x-auto">
            <CategoryChip active={category === 'all'} onClick={() => setCategory('all')} label={t('activity.allKinds')} />
            {presentCategories.map((c) => (
              <CategoryChip key={c} active={category === c} onClick={() => setCategory(c)} label={AUDIT_CATEGORY_LABELS[c]} />
            ))}
          </div>
        )}
      </Card>

      <Card className="px-4 py-2 sm:px-6">
        {feed.isPending ? (
          <div className="py-4">
            <SkeletonRows rows={8} />
          </div>
        ) : feed.isError && entries.length === 0 ? (
          <ErrorState error={feed.error} onRetry={() => void feed.refetch()} retrying={feed.isFetching} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Activity className="size-6" />}
            title={entries.length === 0 ? t('activity.empty') : t('common.noResults')}
            description={entries.length === 0 ? t('activity.emptyDesc') : t('common.tryOtherFilter')}
          />
        ) : (
          <div>
            {groups.map((group) => (
              <section key={group.day}>
                <h3 className="sticky top-16 z-10 -mx-4 bg-zinc-900/90 px-4 py-2 text-xs font-medium text-zinc-500 backdrop-blur sm:-mx-6 sm:px-6">{formatWeekday(group.items[0]!.createdAt)}</h3>
                <div className="divide-y divide-white/[0.05]">
                  {group.items.map((entry) => (
                    <AuditRow key={entry.id} entry={entry} currentUserId={me.user.id} expandable />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
        <div ref={sentinel} />
        {feed.hasNextPage && (
          <div className="flex justify-center border-t border-white/[0.05] py-4">
            <Button variant="secondary" size="sm" onClick={() => void feed.fetchNextPage()} loading={feed.isFetchingNextPage}>
              {t('common.loadMore')}
            </Button>
          </div>
        )}
        {!feed.hasNextPage && entries.length > 0 && <p className="border-t border-white/[0.05] py-4 text-center text-xs text-zinc-600">{t('activity.end')}</p>}
      </Card>
    </div>
  );
}

function CategoryChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        active
          ? 'h-7 shrink-0 rounded-full bg-violet-500/15 px-3 text-xs font-medium text-violet-200 ring-1 ring-inset ring-violet-400/40'
          : 'h-7 shrink-0 rounded-full px-3 text-xs font-medium text-zinc-400 ring-1 ring-inset ring-white/10 hover:text-zinc-200'
      }
    >
      {label}
    </button>
  );
}
