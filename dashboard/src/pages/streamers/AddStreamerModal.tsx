import { Bot, ChevronDown, CircleX, Info, Plus, Trash2, UserPlus, UserRoundCheck, UserRoundX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isApiError } from '../../api/client';
import { useCreateStreamer, useMember, useSettings } from '../../api/queries';
import type { ContentKind, Platform, StreamerDto } from '../../api/types';
import { PlatformTile } from '../../components/PlatformIcon';
import { Avatar } from '../../components/ui/Avatar';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Input, Textarea } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Spinner } from '../../components/ui/Spinner';
import { Switch } from '../../components/ui/Switch';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useGuild } from '../../hooks/useGuild';
import { cn } from '../../lib/cn';
import { extractSnowflake, isSnowflake } from '../../lib/discord';
import { PLATFORM_META, PLATFORMS } from '../../lib/platforms';
import { toast } from '../../lib/toast';
import { ContentKindsOverride, isBlockingResolve, PlatformPicker, ResolveStatusView, useResolveState, type ResolveStatus } from './accountParts';

const MAX_ACCOUNTS = 12;

interface AccountRow {
  key: number;
  platform: Platform;
  input: string;
  notifyLive: boolean;
  notifyContent: boolean;
  contentKinds: ContentKind[] | null;
  /** Rows added with "another account" can change platform and be removed. */
  extra: boolean;
}

let rowKey = 1;
const newRow = (platform: Platform, extra = false): AccountRow => ({
  key: rowKey++,
  platform,
  input: '',
  notifyLive: true,
  notifyContent: true,
  contentKinds: null,
  extra,
});

export interface AddStreamerModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (streamer: StreamerDto) => void;
}

export function AddStreamerModal({ open, onClose, onCreated }: AddStreamerModalProps) {
  if (!open) return null;
  return <AddStreamerForm onClose={onClose} onCreated={onCreated} />;
}

function AddStreamerForm({ onClose, onCreated }: Omit<AddStreamerModalProps, 'open'>) {
  const { guildId } = useGuild();
  const settings = useSettings(guildId);
  const create = useCreateStreamer(guildId);

  const [userInput, setUserInput] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [notes, setNotes] = useState('');
  const [showMore, setShowMore] = useState(false);
  const [rows, setRows] = useState<AccountRow[]>(() => PLATFORMS.map((p) => newRow(p)));
  const [statuses, setStatuses] = useState<Record<number, ResolveStatus>>({});
  const [serverError, setServerError] = useState<{ field?: string; message: string; rowKey?: number } | null>(null);

  const userId = extractSnowflake(userInput);
  const userIdValid = isSnowflake(userId);
  const debouncedUserId = useDebouncedValue(userIdValid ? userId : '', 350);
  const member = useMember(guildId, debouncedUserId || null);
  const memberSettled = debouncedUserId === (userIdValid ? userId : '');

  const memberState = useMemo<MemberState>(() => {
    if (!userInput.trim()) return { kind: 'empty' };
    if (!userIdValid) return { kind: 'invalid' };
    if (!memberSettled || member.isFetching) return { kind: 'checking' };
    if (member.data) {
      if (member.data.bot) return { kind: 'bot', member: member.data };
      if (member.data.alreadyStreamer) return { kind: 'exists', member: member.data };
      return { kind: 'ok', member: member.data };
    }
    if (isApiError(member.error) && member.error.status === 404) return { kind: 'absent' };
    if (member.error) return { kind: 'unverified', message: isApiError(member.error) ? member.error.message : null };
    return { kind: 'checking' };
  }, [userInput, userIdValid, memberSettled, member.isFetching, member.data, member.error]);

  const filledRows = rows.filter((r) => r.input.trim());
  const blockingRow = filledRows.find((r) => isBlockingResolve(statuses[r.key] ?? 'typing'));
  const memberBlocks = ['empty', 'invalid', 'checking', 'bot', 'exists', 'absent'].includes(memberState.kind);
  const canSubmit = !memberBlocks && filledRows.length > 0 && !blockingRow && !create.isPending;

  const submitHint = memberBlocks
    ? memberState.kind === 'checking'
      ? 'نتحقق من العضو…'
      : 'حط آيدي عضو صحيح'
    : filledRows.length === 0
      ? 'أضف حساب واحد على الأقل'
      : blockingRow
        ? statuses[blockingRow.key] === 'typing' || statuses[blockingRow.key] === 'checking'
          ? 'نتحقق من الحسابات…'
          : `صحّح حساب ${PLATFORM_META[blockingRow.platform].label}`
        : null;

  const updateRow = (key: number, patch: Partial<AccountRow>): void => {
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    if (serverError?.rowKey === key) setServerError(null);
  };

  const submit = (): void => {
    if (!canSubmit) return;
    setServerError(null);
    const submitted = filledRows;
    create.mutate(
      {
        discordUserId: userId,
        displayName: displayName.trim() || undefined,
        notes: notes.trim() ? notes.trim() : null,
        accounts: submitted.map((r) => ({
          platform: r.platform,
          input: r.input.trim(),
          notifyLive: r.notifyLive,
          notifyContent: r.notifyContent,
          contentKinds: r.contentKinds,
        })),
      },
      {
        onSuccess: (streamer) => {
          const roleNote = settings.data?.options.autoStreamerRole && settings.data.streamerRoleId ? 'وانعطى رتبة الستريمر' : undefined;
          toast.success(`تمت إضافة ${streamer.displayName}`, { description: roleNote });
          onCreated(streamer);
        },
        onError: (error) => {
          const message = isApiError(error) ? error.message : 'ما قدرنا نضيف الستريمر';
          const field = isApiError(error) ? error.field : undefined;
          const index = field ? /^accounts\.(\d+)/.exec(field)?.[1] : undefined;
          setServerError({ field, message, rowKey: index !== undefined ? submitted[Number(index)]?.key : undefined });
        },
      },
    );
  };

  const disabledPlatforms = settings.data ? PLATFORMS.filter((p) => !settings.data.platformsEnabled.includes(p)) : [];

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      dismissible={!create.isPending}
      icon={<UserPlus className="size-5" />}
      title="إضافة ستريمر"
      description="حط آيدي الديسكورد حقه وحساباته في المنصات. البوت يتأكد من كل حساب قبل الحفظ."
      footer={
        <>
          {submitHint && <span className="me-auto text-xs text-zinc-500">{submitHint}</span>}
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            إلغاء
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit} loading={create.isPending} icon={<UserPlus className="size-4" />}>
            إضافة الستريمر
          </Button>
        </>
      }
    >
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="آيدي الديسكورد"
            htmlFor="add-user-id"
            hint="كليك يمين على العضو ← Copy User ID (لازم Developer Mode). تقدر تلصق منشن بعد."
            error={serverError?.field === 'discordUserId' ? serverError.message : memberState.kind === 'invalid' ? 'الآيدي لازم يكون رقم من 17 إلى 20 خانة' : null}
          >
            <Input
              id="add-user-id"
              data-autofocus
              dir="ltr"
              inputMode="numeric"
              autoComplete="off"
              placeholder="123456789012345678"
              value={userInput}
              onChange={(e) => {
                setUserInput(e.target.value);
                if (serverError?.field === 'discordUserId') setServerError(null);
              }}
              invalid={memberState.kind === 'invalid' || memberState.kind === 'absent' || memberState.kind === 'exists' || memberState.kind === 'bot'}
              className="font-mono"
            />
          </Field>
          <Field label="الاسم المعروض" htmlFor="add-display-name" hint="اختياري، الافتراضي اسمه في السيرفر.">
            <Input
              id="add-display-name"
              value={displayName}
              maxLength={64}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={memberState.kind === 'ok' ? memberState.member.displayName : 'اسم الستريمر'}
            />
          </Field>
        </div>

        <MemberPreview state={memberState} />

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-200">الحسابات</h3>
            <span className="text-xs text-zinc-500">اترك اللي ما عنده فاضي</span>
          </div>
          {rows.map((row) => (
            <AccountRowEditor
              key={row.key}
              row={row}
              guildKinds={settings.data?.contentKinds}
              platformDisabled={disabledPlatforms.includes(row.platform)}
              error={serverError?.rowKey === row.key ? serverError.message : null}
              onChange={(patch) => updateRow(row.key, patch)}
              onRemove={row.extra ? () => setRows((list) => list.filter((r) => r.key !== row.key)) : undefined}
              onStatus={(status) => setStatuses((s) => (s[row.key] === status ? s : { ...s, [row.key]: status }))}
            />
          ))}
          <Button
            variant="outline"
            size="sm"
            icon={<Plus className="size-4" />}
            disabled={rows.length >= MAX_ACCOUNTS}
            onClick={() => setRows((list) => [...list, newRow('twitch', true)])}
          >
            حساب إضافي
          </Button>
        </div>

        <div>
          <button type="button" onClick={() => setShowMore((v) => !v)} className="flex items-center gap-1.5 text-[13px] text-zinc-400 hover:text-zinc-200" aria-expanded={showMore}>
            <ChevronDown className={cn('size-4 transition-transform', showMore && 'rotate-180')} />
            ملاحظات (اختياري)
          </button>
          {showMore && (
            <Textarea className="mt-2" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ملاحظات خاصة للمشرفين، ما تظهر في الإشعارات" />
          )}
        </div>

        {serverError && !serverError.rowKey && serverError.field !== 'discordUserId' && (
          <div className="flex items-start gap-2 rounded-xl bg-rose-500/[0.08] p-3 text-[13px] text-rose-200 ring-1 ring-inset ring-rose-500/20" role="alert">
            <CircleX className="mt-0.5 size-4 shrink-0" />
            {serverError.message}
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

interface MemberInfo {
  displayName: string;
  username: string;
  avatarUrl: string | null;
  id: string;
}

type MemberState =
  | { kind: 'empty' }
  | { kind: 'invalid' }
  | { kind: 'checking' }
  | { kind: 'absent' }
  | { kind: 'unverified'; message: string | null }
  | { kind: 'ok'; member: MemberInfo }
  | { kind: 'bot'; member: MemberInfo }
  | { kind: 'exists'; member: MemberInfo };

function MemberPreview({ state }: { state: MemberState }) {
  if (state.kind === 'empty' || state.kind === 'invalid') return null;
  if (state.kind === 'checking') {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-white/[0.03] p-3 text-[13px] text-zinc-400 ring-1 ring-inset ring-white/[0.06]">
        <Spinner className="size-4" />
        نبحث عن العضو في السيرفر…
      </div>
    );
  }
  if (state.kind === 'absent') {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-rose-500/[0.07] p-3 text-[13px] text-rose-200 ring-1 ring-inset ring-rose-500/20">
        <UserRoundX className="size-4 shrink-0" />
        هذا العضو مو موجود في السيرفر، تأكد من الآيدي.
      </div>
    );
  }
  if (state.kind === 'unverified') {
    return (
      <div className="flex items-start gap-2 rounded-xl bg-amber-500/[0.07] p-3 text-[13px] text-amber-100/90 ring-1 ring-inset ring-amber-500/20">
        <Info className="mt-0.5 size-4 shrink-0 text-amber-300" />
        {state.message ?? 'ما قدرنا نتحقق من العضو الحين'}. تقدر تكمل، والبوت بيحاول يتحقق وقت الحفظ.
      </div>
    );
  }
  const { member } = state;
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl p-3 ring-1 ring-inset',
        state.kind === 'ok' ? 'bg-emerald-500/[0.06] ring-emerald-500/15' : 'bg-rose-500/[0.07] ring-rose-500/20',
      )}
    >
      <Avatar src={member.avatarUrl} name={member.displayName} size={40} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-zinc-100">{member.displayName}</p>
        <p dir="ltr" className="truncate text-end text-xs text-zinc-500">
          @{member.username}
        </p>
      </div>
      {state.kind === 'ok' && (
        <Badge tone="success">
          <UserRoundCheck className="size-3" />
          عضو في السيرفر
        </Badge>
      )}
      {state.kind === 'exists' && <Badge tone="danger">مسجّل كستريمر من قبل</Badge>}
      {state.kind === 'bot' && (
        <Badge tone="danger">
          <Bot className="size-3" />
          حساب بوت
        </Badge>
      )}
    </div>
  );
}

function AccountRowEditor({
  row,
  guildKinds,
  platformDisabled,
  error,
  onChange,
  onRemove,
  onStatus,
}: {
  row: AccountRow;
  guildKinds?: ContentKind[];
  platformDisabled: boolean;
  error: string | null;
  onChange: (patch: Partial<AccountRow>) => void;
  onRemove?: () => void;
  onStatus: (status: ResolveStatus) => void;
}) {
  const state = useResolveState(row.platform, row.input);
  const [showKinds, setShowKinds] = useState(false);
  const reported = useRef<ResolveStatus | null>(null);
  useEffect(() => {
    if (reported.current === state.status) return;
    reported.current = state.status;
    onStatus(state.status);
  }, [state.status, onStatus]);

  const meta = PLATFORM_META[row.platform];
  const filled = row.input.trim().length > 0;

  return (
    <div className={cn('rounded-2xl p-3 ring-1 ring-inset transition-colors', filled && 'bg-white/[0.03]', error ? 'ring-rose-500/40' : filled ? 'ring-white/[0.08]' : 'ring-white/[0.05]')}>
      {row.extra && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <PlatformPicker value={row.platform} onChange={(platform) => onChange({ platform, contentKinds: null })} />
          {onRemove && (
            <button type="button" onClick={onRemove} aria-label="حذف الحساب" className="grid size-8 place-items-center rounded-lg text-zinc-500 hover:bg-rose-500/10 hover:text-rose-300">
              <Trash2 className="size-4" />
            </button>
          )}
        </div>
      )}
      <div className="flex items-center gap-3">
        <PlatformTile platform={row.platform} />
        <Input
          aria-label={`حساب ${meta.label}`}
          // Handles/URLs are LTR, but the Arabic placeholder must read right-to-left.
          dir={row.input ? 'ltr' : 'rtl'}
          autoComplete="off"
          spellCheck={false}
          maxLength={300}
          className="flex-1 text-start"
          placeholder={meta.placeholder}
          value={row.input}
          onChange={(e) => onChange({ input: e.target.value })}
          invalid={!!error || state.status === 'not_found' || state.status === 'invalid'}
        />
      </div>
      {(filled || error) && (
        <div className="mt-2.5 space-y-2.5 ps-12">
          {error ? (
            <p className="flex items-start gap-1.5 text-xs text-rose-300">
              <CircleX className="mt-px size-3.5 shrink-0" />
              {error}
            </p>
          ) : (
            <ResolveStatusView state={state} compact />
          )}
          {platformDisabled && <p className="text-xs text-amber-300/90">منصة {meta.label} مقفلة في الإعدادات، الحساب بينحفظ بس ما راح ينراقب لين تفعّلها.</p>}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-zinc-300">
            <label className="flex items-center gap-2">
              <Switch size="sm" checked={row.notifyLive} onChange={(v) => onChange({ notifyLive: v })} label="إشعار البث" />
              إشعار البث
            </label>
            <label className="flex items-center gap-2">
              <Switch size="sm" checked={row.notifyContent} onChange={(v) => onChange({ notifyContent: v })} label="إشعار المقاطع" />
              إشعار المقاطع
            </label>
            {row.notifyContent && (
              <button type="button" onClick={() => setShowKinds((v) => !v)} className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300" aria-expanded={showKinds}>
                أنواع المقاطع: {row.contentKinds === null ? 'حسب السيرفر' : 'مخصص'}
                <ChevronDown className={cn('size-3.5 transition-transform', showKinds && 'rotate-180')} />
              </button>
            )}
          </div>
          {row.notifyContent && showKinds && <ContentKindsOverride platform={row.platform} value={row.contentKinds} onChange={(contentKinds) => onChange({ contentKinds })} guildKinds={guildKinds} />}
        </div>
      )}
    </div>
  );
}
