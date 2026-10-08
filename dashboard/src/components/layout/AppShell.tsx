import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Bell,
  BellOff,
  ClipboardList,
  History,
  LayoutDashboard,
  LogOut,
  Menu as MenuIcon,
  MessageSquareText,
  Plus,
  Radio,
  ServerCog,
  Settings,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { api } from '../../api/endpoints';
import { t, type MessageKey } from '../../i18n';
import { keys, useLogout, useSettings } from '../../api/queries';
import { pendingBadge } from '../../lib/applications';
import type { GuildSummary } from '../../api/types';
import type { RealtimeStatus } from '../../hooks/useGuildEvents';
import { useRealtimeToasts } from '../../hooks/usePreferences';
import { useSession } from '../../hooks/useSession';
import { cn } from '../../lib/cn';
import { Avatar } from '../ui/Avatar';
import { StatusDot } from '../ui/Badge';
import { buttonClasses } from '../ui/Button';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { GuildSwitcher } from './GuildSwitcher';
import { LanguageToggle } from './LanguageToggle';

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  end?: boolean;
  badge?: ReactNode;
}

function LiveCountBadge({ guildId }: { guildId: string }) {
  // Reads the overview cache passively (the overview page owns fetching).
  const { data: live } = useQuery({
    queryKey: keys.overview(guildId),
    queryFn: ({ signal }) => api.overview(guildId, signal),
    enabled: false,
    select: (o) => o.counts.liveNow,
  });
  if (!live) return null;
  return (
    <span className="ms-auto inline-flex h-5 min-w-5 items-center justify-center gap-1 rounded-full bg-rose-500/15 px-1.5 text-[11px] font-semibold text-rose-300 ring-1 ring-inset ring-rose-500/30">
      <Radio className="size-3" />
      {live}
    </span>
  );
}

function PendingApplicationsBadge({ guildId }: { guildId: string }) {
  const { data: pending } = useQuery({
    queryKey: keys.overview(guildId),
    queryFn: ({ signal }) => api.overview(guildId, signal),
    enabled: false,
    select: (o) => o.counts.pendingApplications,
  });
  const label = pendingBadge(pending);
  if (!label) return null;
  return (
    <span
      className="ms-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/15 px-1.5 text-[11px] font-semibold text-amber-300 ring-1 ring-inset ring-amber-500/30"
      aria-label={t('nav.pendingApplications', { count: pending ?? 0 })}
    >
      {label}
    </span>
  );
}

interface NavFlags {
  applications: boolean;
  manualPosts: boolean;
}

function navItems(guild: GuildSummary | undefined, flags: NavFlags): NavItem[] {
  if (!guild) return [{ to: '/system', label: t('nav.systemStatus'), icon: ServerCog }];
  const base = `/g/${guild.id}`;
  return [
    { to: base, label: t('nav.overview'), icon: LayoutDashboard, end: true, badge: <LiveCountBadge guildId={guild.id} /> },
    { to: `${base}/streamers`, label: t('nav.streamers'), icon: Users },
    ...(flags.applications ? [{ to: `${base}/applications`, label: t('nav.applications'), icon: ClipboardList, badge: <PendingApplicationsBadge guildId={guild.id} /> }] : []),
    ...(flags.manualPosts ? [{ to: `${base}/manual-post`, label: t('nav.manualPost'), icon: Upload }] : []),
    { to: `${base}/settings`, label: t('nav.settings'), icon: Settings },
    { to: `${base}/templates`, label: t('nav.templates'), icon: MessageSquareText },
    { to: `${base}/history`, label: t('nav.history'), icon: History },
    { to: `${base}/activity`, label: t('nav.activity'), icon: Activity },
    { to: `${base}/system`, label: t('nav.system'), icon: ServerCog },
  ];
}

function BrandMark() {
  return (
    <div className="flex items-center gap-2.5 px-1">
      <div className="relative grid size-9 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 shadow-[0_8px_24px_-8px_rgb(124_58_237/0.8)]">
        <Radio className="size-[18px] text-white" />
        <span className="absolute -end-0.5 -top-0.5 size-2.5 rounded-full bg-rose-500 ring-2 ring-zinc-950" />
      </div>
      <div className="leading-tight">
        <p className="text-[15px] font-semibold text-white">{t('app.name')}</p>
        <p className="text-[11px] text-zinc-500">{t('app.tagline')}</p>
      </div>
    </div>
  );
}

function BotStatusCard() {
  const me = useSession();
  const bot = me.bot;
  return (
    <div className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-inset ring-white/[0.06]">
      <div className="flex items-center gap-2.5">
        <div className="relative">
          <Avatar src={bot?.avatarUrl} name={bot?.username ?? 'Bot'} size={32} />
          <StatusDot tone={bot?.ready ? 'ok' : 'error'} className="absolute -bottom-0.5 -end-0.5 size-2.5 ring-2 ring-zinc-900" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-zinc-200">{bot?.username ?? t('shell.bot')}</p>
          <p className={cn('text-[11px]', bot?.ready ? 'text-emerald-400/90' : 'text-rose-400')}>{bot?.ready ? t('shell.connected') : t('shell.disconnected')}</p>
        </div>
      </div>
      <a href={me.inviteUrl} target="_blank" rel="noopener noreferrer" className={buttonClasses('ghost', 'xs', 'mt-2 w-full')}>
        <Plus className="size-3.5" />
        {t('shell.invite')}
      </a>
    </div>
  );
}

/** Optional pages appear when their feature is on (applications also while some are still pending). */
function useNavFlags(guildId: string | undefined): NavFlags {
  const settings = useSettings(guildId ?? '');
  const { data: pending } = useQuery({
    queryKey: keys.overview(guildId ?? ''),
    queryFn: ({ signal }) => api.overview(guildId ?? '', signal),
    enabled: false,
    select: (o) => o.counts.pendingApplications,
  });
  const features = guildId ? settings.data?.features : undefined;
  return {
    applications: !!features?.applications?.enabled || (pending ?? 0) > 0,
    manualPosts: !!features?.manualPosts?.enabled,
  };
}

function SidebarContent({ guild, onNavigate }: { guild?: GuildSummary; onNavigate?: () => void }) {
  const flags = useNavFlags(guild?.id);
  return (
    <div className="flex h-full flex-col gap-5 p-4">
      <BrandMark />
      {guild && <GuildSwitcher current={guild} />}
      <nav className="flex flex-1 flex-col gap-0.5" aria-label={t('shell.navAria')}>
        {navItems(guild, flags).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                isActive ? 'bg-white/[0.07] text-white' : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200',
              )
            }
          >
            {({ isActive }) => (
              <>
                <span className={cn('absolute inset-y-2 start-0 w-0.5 rounded-full transition-colors', isActive ? 'bg-violet-500' : 'bg-transparent')} />
                <item.icon className={cn('size-[18px] shrink-0', isActive ? 'text-violet-300' : 'text-zinc-500 group-hover:text-zinc-300')} />
                {item.label}
                {item.badge}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <BotStatusCard />
    </div>
  );
}

const REALTIME_LABELS: Record<RealtimeStatus, { label: MessageKey; tone: 'ok' | 'warn' | 'off' }> = {
  open: { label: 'shell.rt.open', tone: 'ok' },
  connecting: { label: 'shell.rt.connecting', tone: 'warn' },
  reconnecting: { label: 'shell.rt.reconnecting', tone: 'warn' },
  paused: { label: 'shell.rt.paused', tone: 'off' },
};

function RealtimeIndicator({ status }: { status: RealtimeStatus }) {
  const { label: labelKey, tone } = REALTIME_LABELS[status];
  const label = t(labelKey);
  return (
    <span
      title={status === 'open' ? t('shell.rt.openTitle') : t('shell.rt.offTitle')}
      className="inline-flex h-8 items-center gap-2 rounded-full bg-white/[0.04] px-3 text-xs text-zinc-400 ring-1 ring-inset ring-white/[0.06]"
    >
      <span className="relative inline-flex">
        {tone === 'ok' && <span className="absolute inset-0 animate-live-ping rounded-full bg-emerald-400/60" />}
        <StatusDot tone={tone} className="relative" />
      </span>
      {label}
    </span>
  );
}

function UserMenu() {
  const me = useSession();
  const logout = useLogout();
  return (
    <Menu
      trigger={({ open, toggle }) => (
        <button type="button" onClick={toggle} aria-expanded={open} aria-label={t('shell.account')} className="flex items-center gap-2 rounded-full p-0.5 pe-0.5 ring-1 ring-inset ring-white/[0.08] transition-colors hover:bg-white/[0.06] sm:pe-3">
          <Avatar src={me.user.avatarUrl} name={me.user.username} size={30} />
          <span className="hidden max-w-32 truncate text-[13px] font-medium text-zinc-200 sm:inline">{me.user.username}</span>
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="flex items-center gap-3 px-2.5 py-2">
            <Avatar src={me.user.avatarUrl} name={me.user.username} size={36} />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-zinc-100">{me.user.username}</p>
              <p dir="ltr" className="truncate text-right font-mono ltr:text-left text-[11px] text-zinc-500">
                {me.user.id}
              </p>
            </div>
          </div>
          <MenuSeparator />
          <MenuItem icon={<Plus className="size-4 text-zinc-400" />} href={me.inviteUrl} external onClick={close}>
            {t('shell.invite')}
          </MenuItem>
          <MenuItem
            danger
            icon={<LogOut className="size-4" />}
            onClick={() => {
              close();
              logout.mutate();
            }}
          >
            {t('shell.logout')}
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

export interface AppShellProps {
  guild?: GuildSummary;
  realtime?: RealtimeStatus;
  children: ReactNode;
}

export function AppShell({ guild, realtime, children }: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toasts, setToasts] = useRealtimeToasts();
  const location = useLocation();

  useEffect(() => setDrawerOpen(false), [location.pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  return (
    <div className="min-h-dvh">
      <aside className="fixed inset-y-0 start-0 z-30 hidden w-[264px] border-e border-white/[0.06] bg-zinc-950/70 backdrop-blur-xl lg:block">
        <SidebarContent guild={guild} />
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 animate-fade-in bg-black/60 backdrop-blur-sm" onClick={() => setDrawerOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 start-0 w-[280px] max-w-[85vw] animate-slide-in-start border-e ltr:animate-slide-in-end border-white/[0.08] bg-zinc-950/95 backdrop-blur-xl">
            <button type="button" onClick={() => setDrawerOpen(false)} aria-label={t('shell.closeMenu')} className="absolute end-3 top-4 grid size-8 place-items-center rounded-lg text-zinc-400 hover:bg-white/[0.06]">
              <X className="size-4" />
            </button>
            <SidebarContent guild={guild} onNavigate={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}

      <div className="lg:ps-[264px]">
        <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-zinc-950/60 backdrop-blur-xl">
          <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
            <button type="button" onClick={() => setDrawerOpen(true)} aria-label={t('shell.openMenu')} className="grid size-9 place-items-center rounded-lg text-zinc-300 hover:bg-white/[0.06] lg:hidden">
              <MenuIcon className="size-5" />
            </button>
            {guild && (
              <div className="flex min-w-0 items-center gap-2 lg:hidden">
                <Avatar src={guild.iconUrl} name={guild.name} size={26} rounded="xl" />
                <span className="truncate text-sm font-semibold">{guild.name}</span>
              </div>
            )}
            <div className="ms-auto flex items-center gap-2">
              {realtime && (
                <div className="hidden sm:block">
                  <RealtimeIndicator status={realtime} />
                </div>
              )}
              {guild && (
                <button
                  type="button"
                  onClick={() => setToasts(!toasts)}
                  aria-pressed={toasts}
                  title={toasts ? t('shell.toastsOff') : t('shell.toastsOn')}
                  aria-label={toasts ? t('shell.toastsOff') : t('shell.toastsOn')}
                  className="grid size-9 place-items-center rounded-full text-zinc-400 ring-1 ring-inset ring-white/[0.08] transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
                >
                  {toasts ? <Bell className="size-4" /> : <BellOff className="size-4" />}
                </button>
              )}
              <LanguageToggle />
              <UserMenu />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 pb-28 pt-6 sm:px-6 lg:px-8 lg:pt-8">{children}</main>
      </div>
    </div>
  );
}
