import { ChevronLeft, Plus, ServerOff } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { PageHeader } from '../components/PageHeader';
import { Avatar } from '../components/ui/Avatar';
import { LinkButton } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { readStorage } from '../hooks/useLocalStorage';
import { LAST_GUILD_KEY } from '../hooks/usePreferences';
import { useSession } from '../hooks/useSession';
import { formatCompact } from '../lib/format';
import { t } from '../i18n';

/** "/" → the last used guild, the only guild, or the picker. */
export function HomeRedirect() {
  const me = useSession();
  const last = readStorage<string | null>(LAST_GUILD_KEY, null);
  const target = me.guilds.find((g) => g.id === last) ?? (me.guilds.length === 1 ? me.guilds[0] : undefined);
  return <Navigate to={target ? `/g/${target.id}` : '/guilds'} replace />;
}

export function GuildPickerPage() {
  const me = useSession();
  return (
    <AppShell>
      <PageHeader
        title={t('guilds.hello', { name: me.user.username })}
        description={t('guilds.pick')}
        actions={
          <LinkButton href={me.inviteUrl} external variant="secondary" icon={<Plus className="size-4" />}>
            {t('shell.invite')}
          </LinkButton>
        }
      />
      {me.guilds.length === 0 ? (
        <div className="glass rounded-2xl">
          <EmptyState
            icon={<ServerOff className="size-6" />}
            title={t('guilds.noneTitle')}
            description={t('guilds.noneDesc')}
            action={
              <LinkButton href={me.inviteUrl} external variant="primary" icon={<Plus className="size-4" />}>
                {t('problems.fix.invite')}
              </LinkButton>
            }
          />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {me.guilds.map((guild) => (
            <Link
              key={guild.id}
              to={`/g/${guild.id}`}
              className="glass group flex items-center gap-4 rounded-2xl p-4 transition-[transform,background-color] hover:-translate-y-0.5 hover:bg-zinc-900/80"
            >
              <Avatar src={guild.iconUrl} name={guild.name} size={52} rounded="xl" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-zinc-100">{guild.name}</p>
                <p className="mt-0.5 text-[13px] text-zinc-500">{t('guilds.members', { n: formatCompact(guild.memberCount) })}</p>
              </div>
              <ChevronLeft className="size-5 text-zinc-600 transition-transform group-hover:text-zinc-300 ltr:rotate-180 rtl:group-hover:-translate-x-1 ltr:group-hover:translate-x-1" />
            </Link>
          ))}
        </div>
      )}
    </AppShell>
  );
}
