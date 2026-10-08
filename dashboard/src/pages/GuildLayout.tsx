import { ShieldX } from 'lucide-react';
import { Suspense, useEffect, useMemo } from 'react';
import { Link, Outlet, useParams } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { buttonClasses } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import type { GuildSummary } from '../api/types';
import { GuildContext, type GuildContextValue } from '../hooks/useGuild';
import { useGuildEvents } from '../hooks/useGuildEvents';
import { writeStorage } from '../hooks/useLocalStorage';
import { LAST_GUILD_KEY, useRealtimeToasts } from '../hooks/usePreferences';
import { useSession } from '../hooks/useSession';
import { t } from '../i18n';

export function GuildLayout() {
  const { guildId = '' } = useParams();
  const me = useSession();
  const guild = me.guilds.find((g) => g.id === guildId);

  if (!guild) {
    return (
      <AppShell>
        <EmptyState
          icon={<ShieldX className="size-6" />}
          title={t('guildLayout.noAccess')}
          description={t('guildLayout.noAccessDesc')}
          action={
            <Link to="/guilds" className={buttonClasses('secondary', 'md')}>
              {t('guildLayout.pickAnother')}
            </Link>
          }
        />
      </AppShell>
    );
  }
  // Keyed so switching guilds resets every page's local state and the realtime stream.
  return <GuildScope key={guild.id} guild={guild} />;
}

function GuildScope({ guild }: { guild: GuildSummary }) {
  const me = useSession();
  const [notify] = useRealtimeToasts();
  const realtime = useGuildEvents(guild.id, { currentUserId: me.user.id, notify });

  useEffect(() => writeStorage(LAST_GUILD_KEY, guild.id), [guild.id]);

  const value = useMemo<GuildContextValue>(() => ({ guildId: guild.id, guild, realtime, basePath: `/g/${guild.id}` }), [guild, realtime]);

  return (
    <GuildContext.Provider value={value}>
      <AppShell guild={guild} realtime={realtime}>
        <Suspense fallback={<PageSkeleton />}>
          <Outlet />
        </Suspense>
      </AppShell>
    </GuildContext.Provider>
  );
}

export function PageSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label={t('common.loading')}>
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-2xl" />
    </div>
  );
}
