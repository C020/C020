import {
  BadgeCheck,
  ChartColumn,
  CalendarPlus,
  Link2,
  Check,
  Clock,
  ExternalLink,
  Eye,
  Gamepad2,
  Pencil,
  Plus,
  Radio,
  RefreshCw,
  Trash2,
  TrendingUp,
  TriangleAlert,
  UserRoundX,
  X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { isApiError } from '../../api/client';
import { useAddAccount, useCheckStreamer, useDeleteStreamer, useRemoveAccount, useRemoveLink, useSettings, useUpdateAccount, useUpdateStreamer } from '../../api/queries';
import type { AccountDto, ContentKind, LinkPlatform, Platform, StreamerDto } from '../../api/types';
import { PlatformIcon, PlatformTile } from '../../components/PlatformIcon';
import { StreamerAvatar } from '../../components/StreamerAvatar';
import { Badge, LiveDot } from '../../components/ui/Badge';
import { Button, buttonClasses } from '../../components/ui/Button';
import { CopyButton } from '../../components/ui/CopyButton';
import { Drawer } from '../../components/ui/Drawer';
import { EmptyState } from '../../components/ui/EmptyState';
import { Input, Textarea } from '../../components/ui/Input';
import { Switch } from '../../components/ui/Switch';
import { Tabs } from '../../components/ui/Tabs';
import { useGuild } from '../../hooks/useGuild';
import { useNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { confirmDialog } from '../../lib/confirm';
import { formatCompact, formatDate, formatDateTime, formatHours, formatNumber, formatRelative } from '../../lib/format';
import { PLATFORM_META, sortPlatforms } from '../../lib/platforms';
import { toast } from '../../lib/toast';
import { overriddenTypes } from '../../lib/streamerTemplates';
import { StreamerMessages } from './StreamerMessages';
import { ContentKindsOverride, isBlockingResolve, PlatformPicker, ResolveStatusView, useResolveState } from './accountParts';
import { t } from '../../i18n';

export interface StreamerDrawerProps {
  streamer: StreamerDto | null;
  /** The list loaded but this id is not in it (deleted / wrong link). */
  missing: boolean;
  onClose: () => void;
}

export function StreamerDrawer({ streamer, missing, onClose }: StreamerDrawerProps) {
  const open = !!streamer || missing;
  return (
    <Drawer open={open} onClose={onClose} header={streamer ? <DrawerHeader streamer={streamer} /> : undefined} title={missing ? t('drawer.missing') : undefined}>
      {streamer ? (
        <StreamerDetails key={streamer.id} streamer={streamer} onDeleted={onClose} />
      ) : (
        <EmptyState icon={<UserRoundX className="size-6" />} title={t('drawer.missing')} description={t('drawer.missingDesc')} />
      )}
    </Drawer>
  );
}

function DrawerHeader({ streamer }: { streamer: StreamerDto }) {
  const { guildId, basePath } = useGuild();
  const update = useUpdateStreamer(guildId);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(streamer.displayName);

  const saveName = (): void => {
    const next = name.trim();
    if (!next || next === streamer.displayName) {
      setEditing(false);
      setName(streamer.displayName);
      return;
    }
    update.mutate({ id: streamer.id, body: { displayName: next } }, { onSuccess: () => setEditing(false) });
  };

  return (
    <div className="flex items-center gap-3">
      <StreamerAvatar name={streamer.displayName} avatarUrl={streamer.avatarUrl} discordUserId={streamer.discordUserId} live={streamer.isLive} size={48} />
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <Input
              data-autofocus
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveName();
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setEditing(false);
                  setName(streamer.displayName);
                }
              }}
              inputSize="sm"
            />
            <Button size="icon-sm" variant="primary" onClick={saveName} loading={update.isPending} aria-label={t('drawer.saveName')} icon={<Check className="size-4" />} />
            <Button size="icon-sm" variant="ghost" onClick={() => setEditing(false)} aria-label={t('common.cancel')} icon={<X className="size-4" />} />
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <h2 className="truncate text-base font-semibold text-white">{streamer.displayName}</h2>
            <button
              type="button"
              onClick={() => {
                setName(streamer.displayName);
                setEditing(true);
              }}
              aria-label={t('drawer.editName')}
              className="grid size-6 place-items-center rounded-md text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
            >
              <Pencil className="size-3.5" />
            </button>
          </div>
        )}
        <div className="mt-0.5 flex items-center gap-1 text-xs text-zinc-500">
          <span dir="ltr" className="font-mono">
            {streamer.discordUserId}
          </span>
          <CopyButton value={streamer.discordUserId} label={t('drawer.copyId')} />
          {streamer.inGuild === false && (
            <Badge tone="warning" className="ms-1">
              {t('streamers.leftGuild')}
            </Badge>
          )}
        </div>
      </div>
      <Link to={`${basePath}/streamers/${streamer.id}/stats`} className={buttonClasses('secondary', 'sm', 'shrink-0')} title={t('drawer.profileHint')}>
        <ChartColumn className="size-3.5" />
        <span className="hidden sm:inline">{t('drawer.profile')}</span>
      </Link>
    </div>
  );
}

type DrawerTab = 'details' | 'messages';

function StreamerDetails({ streamer, onDeleted }: { streamer: StreamerDto; onDeleted: () => void }) {
  const [tab, setTab] = useState<DrawerTab>('details');
  const custom = overriddenTypes(streamer.templates).length > 0 || streamer.color !== null;
  return (
    <div>
      <Tabs<DrawerTab>
        className="px-5 pt-2"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'details', label: t('drawer.tabDetails') },
          {
            value: 'messages',
            label: t('drawer.tabMessages'),
            badge: custom ? (
              <Badge tone="violet" size="sm">
                {t('tpl.custom')}
              </Badge>
            ) : undefined,
          },
        ]}
      />
      {tab === 'details' ? (
        <StreamerOverview streamer={streamer} onDeleted={onDeleted} />
      ) : (
        <div className="p-5">
          <StreamerMessages streamer={streamer} />
        </div>
      )}
    </div>
  );
}

function StreamerOverview({ streamer, onDeleted }: { streamer: StreamerDto; onDeleted: () => void }) {
  const { guildId } = useGuild();
  const settings = useSettings(guildId);
  const update = useUpdateStreamer(guildId);
  const check = useCheckStreamer(guildId);
  const remove = useDeleteStreamer(guildId);
  const accounts = sortPlatforms(streamer.accounts);
  const liveAccounts = accounts.filter((a) => a.isLive && a.snapshot);

  const deleteStreamer = async (): Promise<void> => {
    const removesRole = settings.data?.options.removeStreamerRoleOnDelete && settings.data.streamerRoleId;
    const ok = await confirmDialog({
      title: t('drawer.deleteTitle', { name: streamer.displayName }),
      description: removesRole ? t('drawer.deleteDescRole') : t('drawer.deleteDesc'),
      confirmLabel: t('drawer.deleteConfirm'),
      tone: 'danger',
    });
    if (!ok) return;
    remove.mutate(streamer.id, {
      onSuccess: () => {
        toast.success(t('drawer.deleted', { name: streamer.displayName }));
        onDeleted();
      },
    });
  };

  return (
    <div className="space-y-6 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex flex-1 items-center gap-2.5 text-sm text-zinc-300">
          <Switch checked={streamer.enabled} onChange={(enabled) => update.mutate({ id: streamer.id, body: { enabled } })} label={t('streamers.enable')} />
          {streamer.enabled ? t('drawer.monitoringOn') : t('drawer.monitoringOff')}
        </label>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => check.mutate(streamer.id, { onSuccess: () => toast.info(t('drawer.checkRequested'), { description: t('drawer.checkRequestedDesc') }) })}
          loading={check.isPending}
          disabled={!streamer.enabled}
          icon={<RefreshCw className="size-3.5" />}
        >
          {t('drawer.checkNow')}
        </Button>
        <Button size="sm" variant="danger-ghost" onClick={() => void deleteStreamer()} loading={remove.isPending} icon={<Trash2 className="size-3.5" />}>
          {t('common.delete')}
        </Button>
      </div>

      {!streamer.enabled && (
        <p className="rounded-xl bg-amber-500/[0.07] p-3 text-[13px] text-amber-100/90 ring-1 ring-inset ring-amber-500/20">
          {t('drawer.disabledNote')}
        </p>
      )}

      <div className="grid grid-cols-3 gap-2">
        <MiniStat icon={<Radio className="size-3.5" />} label={t('drawer.sessions30')} value={formatNumber(streamer.stats.sessions30d)} />
        <MiniStat icon={<Clock className="size-3.5" />} label={t('drawer.hours')} value={formatHours(streamer.stats.hours30d)} />
        <MiniStat icon={<TrendingUp className="size-3.5" />} label={t('drawer.peak')} value={formatCompact(streamer.stats.peakViewers30d)} />
      </div>

      {liveAccounts.length > 0 && (
        <section className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <LiveDot />
            {t('drawer.liveNow')}
          </h3>
          {liveAccounts.map((a) => (
            <a
              key={a.id}
              href={a.snapshot?.url ?? a.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 rounded-xl bg-rose-500/[0.06] p-3 ring-1 ring-inset ring-rose-500/20 transition-colors hover:bg-rose-500/[0.1]"
            >
              <PlatformIcon platform={a.platform} className="size-5" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-zinc-100" dir="auto">
                  {a.snapshot?.title || t('common.untitled')}
                </p>
                {a.snapshot?.category && (
                  <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-zinc-400" dir="auto">
                    <Gamepad2 className="size-3.5 shrink-0" />
                    {a.snapshot.category}
                  </p>
                )}
              </div>
              {a.snapshot?.viewers != null && (
                <span className="flex items-center gap-1 text-xs tabular-nums text-zinc-300">
                  <Eye className="size-3.5" />
                  {formatCompact(a.snapshot.viewers)}
                </span>
              )}
            </a>
          ))}
        </section>
      )}

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-zinc-200">{t('drawer.accounts', { n: accounts.length })}</h3>
        {accounts.length === 0 && <p className="text-[13px] text-zinc-500">{t('drawer.noAccounts')}</p>}
        {accounts.map((account) => (
          <AccountCard
            key={account.id}
            streamer={streamer}
            account={account}
            guildKinds={settings.data?.contentKinds}
            platformEnabled={settings.data ? settings.data.platformsEnabled.includes(account.platform) : true}
          />
        ))}
        <AddAccountForm streamer={streamer} guildKinds={settings.data?.contentKinds} />
      </section>

      <LinksSection streamer={streamer} />

      <NotesEditor streamer={streamer} />

      <p className="flex items-center gap-1.5 text-xs text-zinc-600">
        <CalendarPlus className="size-3.5" />
        {t('drawer.addedOn', { date: formatDate(streamer.createdAt) })}
      </p>
    </div>
  );
}

function MiniStat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/[0.03] px-3 py-2.5 ring-1 ring-inset ring-white/[0.05]">
      <p className="flex items-center gap-1 text-[11px] text-zinc-500">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-sm font-semibold tabular-nums text-zinc-100">{value}</p>
    </div>
  );
}

function AccountCard({ streamer, account, guildKinds, platformEnabled }: { streamer: StreamerDto; account: AccountDto; guildKinds?: ContentKind[]; platformEnabled: boolean }) {
  const { guildId } = useGuild();
  const now = useNow(30_000);
  const updateAccount = useUpdateAccount(guildId);
  const removeAccount = useRemoveAccount(guildId);
  const [showKinds, setShowKinds] = useState(false);
  const meta = PLATFORM_META[account.platform];

  const patch = (body: { notifyLive?: boolean; notifyContent?: boolean; contentKinds?: ContentKind[] | null }): void =>
    updateAccount.mutate({ id: streamer.id, accountId: account.id, body });

  const remove = async (): Promise<void> => {
    const last = streamer.accounts.length === 1;
    const ok = await confirmDialog({
      title: t('drawer.deleteAccountTitle', { platform: meta.label }),
      description: [t('drawer.deleteAccountDesc', { name: account.displayName, handle: account.handle }), last ? t('drawer.deleteAccountLast') : ''].filter(Boolean).join(' '),
      confirmLabel: t('add.removeAccount'),
      tone: 'danger',
    });
    if (ok) removeAccount.mutate({ id: streamer.id, accountId: account.id }, { onSuccess: () => toast.success(t('drawer.accountDeleted')) });
  };

  return (
    <div className={cn('rounded-2xl bg-white/[0.03] p-3.5 ring-1 ring-inset', account.isLive ? 'ring-rose-500/30' : 'ring-white/[0.07]')}>
      <div className="flex items-center gap-3">
        <PlatformTile platform={account.platform} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-medium text-zinc-100" dir="auto">
              {account.displayName}
            </p>
            {account.verified && (
              <Badge tone="success" size="sm" title={t('drawer.verifiedHint')}>
                <BadgeCheck className="size-3" />
                {t('drawer.verified')}
              </Badge>
            )}
            {account.isLive ? (
              <Badge tone="live" size="sm">
                <LiveDot />
                {account.snapshot?.viewers != null ? formatCompact(account.snapshot.viewers) : t('drawer.live')}
              </Badge>
            ) : null}
          </div>
          <a href={account.url} target="_blank" rel="noopener noreferrer" dir="ltr" className="flex items-center justify-end gap-1 ltr:justify-start truncate text-xs text-zinc-500 hover:text-zinc-300">
            <ExternalLink className="size-3 shrink-0" />
            {account.handle}
          </a>
        </div>
        <button
          type="button"
          onClick={() => void remove()}
          disabled={removeAccount.isPending}
          aria-label={t('add.removeAccount')}
          className="grid size-8 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-40"
        >
          <Trash2 className="size-4" />
        </button>
      </div>

      {!platformEnabled && <p className="mt-2.5 text-xs text-amber-300/90">{t('drawer.platformDisabled', { platform: meta.label })}</p>}

      {account.lastError && (
        <div className="mt-2.5 flex items-start gap-2 rounded-lg bg-rose-500/[0.07] p-2.5 text-xs leading-relaxed text-rose-200/90 ring-1 ring-inset ring-rose-500/15">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-rose-300" />
          <span dir="auto">{account.lastError}</span>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-zinc-300">
        <label className="flex items-center gap-2">
          <Switch size="sm" checked={account.notifyLive} onChange={(v) => patch({ notifyLive: v })} label={t('accounts.notifyLive')} />
          {t('accounts.notifyLive')}
        </label>
        <label className="flex items-center gap-2">
          <Switch size="sm" checked={account.notifyContent} onChange={(v) => patch({ notifyContent: v })} label={t('accounts.notifyContent')} />
          {t('accounts.notifyContent')}
        </label>
        {account.notifyContent && (
          <button type="button" onClick={() => setShowKinds((v) => !v)} className="text-xs text-zinc-500 hover:text-zinc-300" aria-expanded={showKinds}>
            {t('accounts.kindsLabel', { mode: account.contentKinds === null ? t('accounts.byServer') : t('tpl.custom') })}
          </button>
        )}
        <span className="ms-auto text-[11px] text-zinc-600" title={account.lastCheckedAt ? formatDateTime(account.lastCheckedAt) : undefined}>
          {t('drawer.lastCheck', { when: account.lastCheckedAt ? formatRelative(account.lastCheckedAt, now) : t('drawer.neverChecked') })}
        </span>
      </div>
      {account.notifyContent && showKinds && (
        <div className="mt-3 border-t border-white/[0.05] pt-3">
          <ContentKindsOverride platform={account.platform} value={account.contentKinds} guildKinds={guildKinds} onChange={(contentKinds) => patch({ contentKinds })} />
        </div>
      )}
    </div>
  );
}

function AddAccountForm({ streamer, guildKinds }: { streamer: StreamerDto; guildKinds?: ContentKind[] }) {
  const { guildId } = useGuild();
  const add = useAddAccount(guildId);
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState<Platform>('twitch');
  const [input, setInput] = useState('');
  const [notifyLive, setNotifyLive] = useState(true);
  const [notifyContent, setNotifyContent] = useState(true);
  const [contentKinds, setContentKinds] = useState<ContentKind[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = useResolveState(platform, input);

  if (!open) {
    return (
      <Button variant="ghost" size="sm" className="w-full border border-dashed border-white/15" icon={<Plus className="size-4" />} onClick={() => setOpen(true)} disabled={streamer.accounts.length >= 12}>
        {t('drawer.addAccount')}
      </Button>
    );
  }

  const submit = (): void => {
    if (!input.trim() || isBlockingResolve(state.status)) return;
    setError(null);
    add.mutate(
      { id: streamer.id, body: { platform, input: input.trim(), notifyLive, notifyContent, contentKinds } },
      {
        onSuccess: () => {
          toast.success(t('drawer.accountAdded', { platform: PLATFORM_META[platform].label }));
          setInput('');
          setContentKinds(null);
          setOpen(false);
        },
        onError: (e) => setError(isApiError(e) ? e.message : t('drawer.addAccountFailed')),
      },
    );
  };

  return (
    <div className="space-y-3 rounded-2xl bg-violet-500/[0.04] p-3.5 ring-1 ring-inset ring-violet-400/20">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-zinc-200">{t('drawer.newAccount')}</p>
        <button type="button" onClick={() => setOpen(false)} aria-label={t('common.cancel')} className="grid size-7 place-items-center rounded-md text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200">
          <X className="size-4" />
        </button>
      </div>
      <PlatformPicker
        value={platform}
        onChange={(p) => {
          setPlatform(p);
          setContentKinds(null);
          setError(null);
        }}
      />
      <Input
        data-autofocus
        dir={input ? 'ltr' : undefined}
        autoComplete="off"
        spellCheck={false}
        maxLength={300}
        placeholder={PLATFORM_META[platform].placeholder}
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        invalid={!!error || state.status === 'not_found'}
      />
      {error ? <p className="text-xs text-rose-300">{error}</p> : <ResolveStatusView state={state} compact />}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-zinc-300">
        <label className="flex items-center gap-2">
          <Switch size="sm" checked={notifyLive} onChange={setNotifyLive} label={t('accounts.notifyLive')} />
          {t('accounts.notifyLive')}
        </label>
        <label className="flex items-center gap-2">
          <Switch size="sm" checked={notifyContent} onChange={setNotifyContent} label={t('accounts.notifyContent')} />
          {t('accounts.notifyContent')}
        </label>
      </div>
      {notifyContent && <ContentKindsOverride platform={platform} value={contentKinds} onChange={setContentKinds} guildKinds={guildKinds} />}
      <div className="flex justify-end">
        <Button size="sm" variant="primary" onClick={submit} loading={add.isPending} disabled={!input.trim() || isBlockingResolve(state.status)} icon={<Plus className="size-4" />}>
          {t('common.add')}
        </Button>
      </div>
    </div>
  );
}

function NotesEditor({ streamer }: { streamer: StreamerDto }) {
  const { guildId } = useGuild();
  const update = useUpdateStreamer(guildId);
  const [notes, setNotes] = useState(streamer.notes ?? '');
  const changed = notes.trim() !== (streamer.notes ?? '').trim();
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-zinc-200">{t('drawer.notes')}</h3>
      <Textarea rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('drawer.notesPlaceholder')} />
      {changed && (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setNotes(streamer.notes ?? '')}>
            {t('save.undo')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={update.isPending}
            onClick={() => update.mutate({ id: streamer.id, body: { notes: notes.trim() ? notes.trim() : null } }, { onSuccess: () => toast.success(t('drawer.notesSaved')) })}
          >
            {t('common.save')}
          </Button>
        </div>
      )}
    </section>
  );
}

const LINK_PROFILE: Record<LinkPlatform, (login: string) => string> = {
  twitch: (login) => `https://www.twitch.tv/${encodeURIComponent(login)}`,
  tiktok: (login) => `https://www.tiktok.com/@${encodeURIComponent(login)}`,
};

/** #11 — the member's official account links (OAuth-verified ownership) with an admin "remove link" action. */
function LinksSection({ streamer }: { streamer: StreamerDto }) {
  const { guildId } = useGuild();
  const removeLink = useRemoveLink(guildId);
  const links = streamer.links ?? [];
  if (links.length === 0) return null;

  const remove = async (platform: LinkPlatform): Promise<void> => {
    const label = PLATFORM_META[platform].label;
    const ok = await confirmDialog({
      title: t('drawer.removeLinkTitle', { platform: label }),
      description: t('drawer.removeLinkDesc', { name: streamer.displayName }),
      confirmLabel: t('drawer.removeLink'),
      tone: 'danger',
    });
    if (ok) removeLink.mutate({ id: streamer.id, platform }, { onSuccess: () => toast.success(t('drawer.linkRemoved', { platform: label })) });
  };

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
        <Link2 className="size-4 text-zinc-400" />
        {t('drawer.links')}
      </h3>
      <p className="text-xs text-zinc-500">{t('drawer.linksDesc')}</p>
      {links.map((link) => (
        <div key={link.platform} className="flex items-center gap-3 rounded-xl bg-emerald-500/[0.04] p-3 ring-1 ring-inset ring-emerald-500/15">
          <PlatformIcon platform={link.platform} className="size-5" />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-zinc-100">
              {PLATFORM_META[link.platform].label}
              <BadgeCheck className="size-3.5 text-emerald-400" aria-label={t('drawer.verified')} />
            </p>
            <p className="truncate text-xs text-zinc-500">
              {link.login ? (
                <a href={LINK_PROFILE[link.platform](link.login)} target="_blank" rel="noopener noreferrer" dir="ltr" className="hover:text-zinc-300">
                  {link.login}
                </a>
              ) : (
                <span dir="ltr" className="font-mono">
                  {link.platformUserId}
                </span>
              )}
              <span className="mx-1.5 text-zinc-700">•</span>
              {t('drawer.linkedOn', { date: formatDate(link.linkedAt) })}
            </p>
          </div>
          <Button size="xs" variant="danger-ghost" onClick={() => void remove(link.platform)} loading={removeLink.isPending && removeLink.variables?.platform === link.platform}>
            {t('drawer.removeLink')}
          </Button>
        </div>
      ))}
    </section>
  );
}
