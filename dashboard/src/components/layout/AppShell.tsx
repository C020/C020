import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Bell,
  BellOff,
  History,
  LayoutDashboard,
  LogOut,
  Menu as MenuIcon,
  MessageSquareText,
  Plus,
  Radio,
  ServerCog,
  Settings,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { api } from '../../api/endpoints';
import { keys, useLogout } from '../../api/queries';
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

function navItems(guild: GuildSummary | undefined): NavItem[] {
  if (!guild) return [{ to: '/system', label: 'حالة النظام', icon: ServerCog }];
  const base = `/g/${guild.id}`;
  return [
    { to: base, label: 'نظرة عامة', icon: LayoutDashboard, end: true, badge: <LiveCountBadge guildId={guild.id} /> },
    { to: `${base}/streamers`, label: 'الستريمرز', icon: Users },
    { to: `${base}/settings`, label: 'الإعدادات', icon: Settings },
    { to: `${base}/templates`, label: 'الرسائل', icon: MessageSquareText },
    { to: `${base}/history`, label: 'السجل', icon: History },
    { to: `${base}/activity`, label: 'النشاط', icon: Activity },
    { to: `${base}/system`, label: 'الحالة', icon: ServerCog },
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
        <p className="text-[15px] font-semibold text-white">بوت البثوث</p>
        <p className="text-[11px] text-zinc-500">لوحة التحكم</p>
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
          <p className="truncate text-[13px] font-medium text-zinc-200">{bot?.username ?? 'البوت'}</p>
          <p className={cn('text-[11px]', bot?.ready ? 'text-emerald-400/90' : 'text-rose-400')}>{bot?.ready ? 'متصل بديسكورد' : 'غير متصل'}</p>
        </div>
      </div>
      <a href={me.inviteUrl} target="_blank" rel="noopener noreferrer" className={buttonClasses('ghost', 'xs', 'mt-2 w-full')}>
        <Plus className="size-3.5" />
        دعوة البوت لسيرفر
      </a>
    </div>
  );
}

function SidebarContent({ guild, onNavigate }: { guild?: GuildSummary; onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col gap-5 p-4">
      <BrandMark />
      {guild && <GuildSwitcher current={guild} />}
      <nav className="flex flex-1 flex-col gap-0.5" aria-label="التنقل">
        {navItems(guild).map((item) => (
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

const REALTIME_LABELS: Record<RealtimeStatus, { label: string; tone: 'ok' | 'warn' | 'off' }> = {
  open: { label: 'مباشر', tone: 'ok' },
  connecting: { label: 'يتصل…', tone: 'warn' },
  reconnecting: { label: 'يعيد الاتصال…', tone: 'warn' },
  paused: { label: 'متوقف مؤقتاً', tone: 'off' },
};

function RealtimeIndicator({ status }: { status: RealtimeStatus }) {
  const { label, tone } = REALTIME_LABELS[status];
  return (
    <span
      title={status === 'open' ? 'التحديثات توصل لحظياً' : 'التحديثات اللحظية مو متصلة، البيانات تتحدث دورياً'}
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
        <button type="button" onClick={toggle} aria-expanded={open} aria-label="حسابي" className="flex items-center gap-2 rounded-full p-0.5 pe-0.5 ring-1 ring-inset ring-white/[0.08] transition-colors hover:bg-white/[0.06] sm:pe-3">
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
              <p dir="ltr" className="truncate text-end font-mono text-[11px] text-zinc-500">
                {me.user.id}
              </p>
            </div>
          </div>
          <MenuSeparator />
          <MenuItem icon={<Plus className="size-4 text-zinc-400" />} href={me.inviteUrl} external onClick={close}>
            دعوة البوت لسيرفر
          </MenuItem>
          <MenuItem
            danger
            icon={<LogOut className="size-4" />}
            onClick={() => {
              close();
              logout.mutate();
            }}
          >
            تسجيل الخروج
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
          <aside className="absolute inset-y-0 start-0 w-[280px] max-w-[85vw] animate-slide-in-start border-e border-white/[0.08] bg-zinc-950/95 backdrop-blur-xl">
            <button type="button" onClick={() => setDrawerOpen(false)} aria-label="إغلاق القائمة" className="absolute end-3 top-4 grid size-8 place-items-center rounded-lg text-zinc-400 hover:bg-white/[0.06]">
              <X className="size-4" />
            </button>
            <SidebarContent guild={guild} onNavigate={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}

      <div className="lg:ps-[264px]">
        <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-zinc-950/60 backdrop-blur-xl">
          <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
            <button type="button" onClick={() => setDrawerOpen(true)} aria-label="فتح القائمة" className="grid size-9 place-items-center rounded-lg text-zinc-300 hover:bg-white/[0.06] lg:hidden">
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
                  title={toasts ? 'إيقاف تنبيهات البث والمقاطع في اللوحة' : 'تشغيل تنبيهات البث والمقاطع في اللوحة'}
                  className="grid size-9 place-items-center rounded-full text-zinc-400 ring-1 ring-inset ring-white/[0.08] transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
                >
                  {toasts ? <Bell className="size-4" /> : <BellOff className="size-4" />}
                </button>
              )}
              <UserMenu />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 pb-28 pt-6 sm:px-6 lg:px-8 lg:pt-8">{children}</main>
      </div>
    </div>
  );
}
