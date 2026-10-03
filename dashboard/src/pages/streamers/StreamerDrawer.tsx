import {
  CalendarPlus,
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
import { isApiError } from '../../api/client';
import { useAddAccount, useCheckStreamer, useDeleteStreamer, useRemoveAccount, useSettings, useUpdateAccount, useUpdateStreamer } from '../../api/queries';
import type { AccountDto, ContentKind, Platform, StreamerDto } from '../../api/types';
import { PlatformIcon, PlatformTile } from '../../components/PlatformIcon';
import { StreamerAvatar } from '../../components/StreamerAvatar';
import { Badge, LiveDot } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { CopyButton } from '../../components/ui/CopyButton';
import { Drawer } from '../../components/ui/Drawer';
import { EmptyState } from '../../components/ui/EmptyState';
import { Input, Textarea } from '../../components/ui/Input';
import { Switch } from '../../components/ui/Switch';
import { useGuild } from '../../hooks/useGuild';
import { useNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { confirmDialog } from '../../lib/confirm';
import { formatCompact, formatDate, formatDateTime, formatHours, formatNumber, formatRelative } from '../../lib/format';
import { PLATFORM_META, sortPlatforms } from '../../lib/platforms';
import { toast } from '../../lib/toast';
import { ContentKindsOverride, isBlockingResolve, PlatformPicker, ResolveStatusView, useResolveState } from './accountParts';

export interface StreamerDrawerProps {
  streamer: StreamerDto | null;
  /** The list loaded but this id is not in it (deleted / wrong link). */
  missing: boolean;
  onClose: () => void;
}

export function StreamerDrawer({ streamer, missing, onClose }: StreamerDrawerProps) {
  const open = !!streamer || missing;
  return (
    <Drawer open={open} onClose={onClose} header={streamer ? <DrawerHeader streamer={streamer} /> : undefined} title={missing ? 'الستريمر غير موجود' : undefined}>
      {streamer ? (
        <StreamerDetails key={streamer.id} streamer={streamer} onDeleted={onClose} />
      ) : (
        <EmptyState icon={<UserRoundX className="size-6" />} title="الستريمر غير موجود" description="يمكن انحذف، أو الرابط قديم." />
      )}
    </Drawer>
  );
}

function DrawerHeader({ streamer }: { streamer: StreamerDto }) {
  const { guildId } = useGuild();
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
            <Button size="icon-sm" variant="primary" onClick={saveName} loading={update.isPending} aria-label="حفظ الاسم" icon={<Check className="size-4" />} />
            <Button size="icon-sm" variant="ghost" onClick={() => setEditing(false)} aria-label="إلغاء" icon={<X className="size-4" />} />
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
              aria-label="تعديل الاسم"
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
          <CopyButton value={streamer.discordUserId} label="نسخ الآيدي" />
          {streamer.inGuild === false && (
            <Badge tone="warning" className="ms-1">
              طلع من السيرفر
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

function StreamerDetails({ streamer, onDeleted }: { streamer: StreamerDto; onDeleted: () => void }) {
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
      title: `حذف ${streamer.displayName}؟`,
      description: `بتنحذف كل حساباته من المراقبة${removesRole ? ' وتنشال منه رتبة الستريمر' : ''}. السجل القديم يبقى.`,
      confirmLabel: 'حذف الستريمر',
      tone: 'danger',
    });
    if (!ok) return;
    remove.mutate(streamer.id, {
      onSuccess: () => {
        toast.success(`انحذف ${streamer.displayName}`);
        onDeleted();
      },
    });
  };

  return (
    <div className="space-y-6 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex flex-1 items-center gap-2.5 text-sm text-zinc-300">
          <Switch checked={streamer.enabled} onChange={(enabled) => update.mutate({ id: streamer.id, body: { enabled } })} label="تفعيل المراقبة" />
          {streamer.enabled ? 'المراقبة شغّالة' : 'المراقبة موقفة'}
        </label>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => check.mutate(streamer.id, { onSuccess: () => toast.info('طلبنا فحص فوري', { description: 'النتيجة بتظهر خلال ثواني' }) })}
          loading={check.isPending}
          disabled={!streamer.enabled}
          icon={<RefreshCw className="size-3.5" />}
        >
          فحص الحين
        </Button>
        <Button size="sm" variant="danger-ghost" onClick={() => void deleteStreamer()} loading={remove.isPending} icon={<Trash2 className="size-3.5" />}>
          حذف
        </Button>
      </div>

      {!streamer.enabled && (
        <p className="rounded-xl bg-amber-500/[0.07] p-3 text-[13px] text-amber-100/90 ring-1 ring-inset ring-amber-500/20">
          المراقبة موقفة: ما راح تنرسل إشعارات ولا تنعطى رتبة البث لهذا الستريمر لين تفعّلها.
        </p>
      )}

      <div className="grid grid-cols-3 gap-2">
        <MiniStat icon={<Radio className="size-3.5" />} label="بثوث (30 يوم)" value={formatNumber(streamer.stats.sessions30d)} />
        <MiniStat icon={<Clock className="size-3.5" />} label="ساعات" value={formatHours(streamer.stats.hours30d)} />
        <MiniStat icon={<TrendingUp className="size-3.5" />} label="الذروة" value={formatCompact(streamer.stats.peakViewers30d)} />
      </div>

      {liveAccounts.length > 0 && (
        <section className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <LiveDot />
            يبث الحين
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
                  {a.snapshot?.title || 'بدون عنوان'}
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
        <h3 className="text-sm font-semibold text-zinc-200">الحسابات ({accounts.length})</h3>
        {accounts.length === 0 && <p className="text-[13px] text-zinc-500">ما فيه حسابات مربوطة. أضف حساب عشان البوت يبدأ يراقب.</p>}
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

      <NotesEditor streamer={streamer} />

      <p className="flex items-center gap-1.5 text-xs text-zinc-600">
        <CalendarPlus className="size-3.5" />
        انضاف {formatDate(streamer.createdAt)}
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
      title: `حذف حساب ${meta.label}؟`,
      description: `${account.displayName} (${account.handle}) بيوقف تتبعه لهذا الستريمر.${last ? ' هذا آخر حساب له، يعني البوت ما راح يراقب شي له.' : ''}`,
      confirmLabel: 'حذف الحساب',
      tone: 'danger',
    });
    if (ok) removeAccount.mutate({ id: streamer.id, accountId: account.id }, { onSuccess: () => toast.success('انحذف الحساب') });
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
            {account.isLive ? (
              <Badge tone="live" size="sm">
                <LiveDot />
                {account.snapshot?.viewers != null ? formatCompact(account.snapshot.viewers) : 'لايف'}
              </Badge>
            ) : null}
          </div>
          <a href={account.url} target="_blank" rel="noopener noreferrer" dir="ltr" className="flex items-center justify-end gap-1 truncate text-xs text-zinc-500 hover:text-zinc-300">
            <ExternalLink className="size-3 shrink-0" />
            {account.handle}
          </a>
        </div>
        <button
          type="button"
          onClick={() => void remove()}
          disabled={removeAccount.isPending}
          aria-label="حذف الحساب"
          className="grid size-8 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-40"
        >
          <Trash2 className="size-4" />
        </button>
      </div>

      {!platformEnabled && <p className="mt-2.5 text-xs text-amber-300/90">منصة {meta.label} مقفلة في الإعدادات، فالحساب ما ينراقب حالياً.</p>}

      {account.lastError && (
        <div className="mt-2.5 flex items-start gap-2 rounded-lg bg-rose-500/[0.07] p-2.5 text-xs leading-relaxed text-rose-200/90 ring-1 ring-inset ring-rose-500/15">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-rose-300" />
          <span dir="auto">{account.lastError}</span>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-zinc-300">
        <label className="flex items-center gap-2">
          <Switch size="sm" checked={account.notifyLive} onChange={(v) => patch({ notifyLive: v })} label="إشعار البث" />
          إشعار البث
        </label>
        <label className="flex items-center gap-2">
          <Switch size="sm" checked={account.notifyContent} onChange={(v) => patch({ notifyContent: v })} label="إشعار المقاطع" />
          إشعار المقاطع
        </label>
        {account.notifyContent && (
          <button type="button" onClick={() => setShowKinds((v) => !v)} className="text-xs text-zinc-500 hover:text-zinc-300" aria-expanded={showKinds}>
            أنواع المقاطع: {account.contentKinds === null ? 'حسب السيرفر' : 'مخصص'}
          </button>
        )}
        <span className="ms-auto text-[11px] text-zinc-600" title={account.lastCheckedAt ? formatDateTime(account.lastCheckedAt) : undefined}>
          آخر فحص: {account.lastCheckedAt ? formatRelative(account.lastCheckedAt, now) : 'ما انفحص للحين'}
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
        إضافة حساب
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
          toast.success(`انضاف حساب ${PLATFORM_META[platform].label}`);
          setInput('');
          setContentKinds(null);
          setOpen(false);
        },
        onError: (e) => setError(isApiError(e) ? e.message : 'ما قدرنا نضيف الحساب'),
      },
    );
  };

  return (
    <div className="space-y-3 rounded-2xl bg-violet-500/[0.04] p-3.5 ring-1 ring-inset ring-violet-400/20">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-zinc-200">حساب جديد</p>
        <button type="button" onClick={() => setOpen(false)} aria-label="إلغاء" className="grid size-7 place-items-center rounded-md text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200">
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
        dir={input ? 'ltr' : 'rtl'}
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
          <Switch size="sm" checked={notifyLive} onChange={setNotifyLive} label="إشعار البث" />
          إشعار البث
        </label>
        <label className="flex items-center gap-2">
          <Switch size="sm" checked={notifyContent} onChange={setNotifyContent} label="إشعار المقاطع" />
          إشعار المقاطع
        </label>
      </div>
      {notifyContent && <ContentKindsOverride platform={platform} value={contentKinds} onChange={setContentKinds} guildKinds={guildKinds} />}
      <div className="flex justify-end">
        <Button size="sm" variant="primary" onClick={submit} loading={add.isPending} disabled={!input.trim() || isBlockingResolve(state.status)} icon={<Plus className="size-4" />}>
          إضافة
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
      <h3 className="text-sm font-semibold text-zinc-200">ملاحظات المشرفين</h3>
      <Textarea rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ملاحظات خاصة، ما تظهر في الإشعارات" />
      {changed && (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setNotes(streamer.notes ?? '')}>
            تراجع
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={update.isPending}
            onClick={() => update.mutate({ id: streamer.id, body: { notes: notes.trim() ? notes.trim() : null } }, { onSuccess: () => toast.success('انحفظت الملاحظات') })}
          >
            حفظ
          </Button>
        </div>
      )}
    </section>
  );
}
