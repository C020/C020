import { Check, ClipboardList, ExternalLink, Inbox, Plus, StickyNote, Trash2, UserRoundX, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { isApiError } from '../api/client';
import { useApplications, useApproveApplication, useRejectApplication } from '../api/queries';
import type { AccountInput, ApplicationDto, ApplicationStatus, Platform } from '../api/types';
import { PageHeader } from '../components/PageHeader';
import { PlatformIcon, PlatformTile } from '../components/PlatformIcon';
import { Avatar } from '../components/ui/Avatar';
import { Badge } from '../components/ui/Badge';
import { Button, buttonClasses } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Field } from '../components/ui/Field';
import { Input, Textarea } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { Skeleton } from '../components/ui/Skeleton';
import { Tabs } from '../components/ui/Tabs';
import { useGuild } from '../hooks/useGuild';
import { useNow } from '../hooks/useNow';
import { applicationAccountUrl, decidableStatus, type DecidedTab } from '../lib/applications';
import { formatDateTime, formatRelative } from '../lib/format';
import { PLATFORM_META, PLATFORMS } from '../lib/platforms';
import { toast } from '../lib/toast';
import { PlatformPicker, ResolveStatusView, isBlockingResolve, useResolveState, type ResolveStatus } from './streamers/accountParts';
import { formatList, t } from '../i18n';

const TABS: DecidedTab[] = ['pending', 'approved', 'rejected'];

export default function ApplicationsPage() {
  const { guildId } = useGuild();
  const [params, setParams] = useSearchParams();
  const tab = decidableStatus(params.get('status'));
  const setTab = (next: DecidedTab): void => {
    const p = new URLSearchParams(params);
    if (next === 'pending') p.delete('status');
    else p.set('status', next);
    setParams(p, { replace: true });
  };
  const query = useApplications(guildId, tab);
  const items = query.data?.pages.flat() ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title={t('nav.applications')} icon={<ClipboardList className="size-5" />} description={t('apps.desc')} />
      <Tabs<DecidedTab> value={tab} onChange={setTab} items={TABS.map((s) => ({ value: s, label: t(`apps.tab.${s}`) }))} />
      {query.isPending ? (
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-48 rounded-2xl" />
          ))}
        </div>
      ) : query.isError && items.length === 0 ? (
        <Card>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState icon={<Inbox className="size-6" />} title={t(`apps.empty.${tab}`)} description={tab === 'pending' ? t('apps.emptyPendingDesc') : undefined} />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {items.map((app) => (
              <ApplicationCard key={app.id} app={app} />
            ))}
          </div>
          {query.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="secondary" size="sm" onClick={() => void query.fetchNextPage()} loading={query.isFetchingNextPage}>
                {t('apps.more')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: ApplicationStatus }) {
  const tone = status === 'approved' ? 'success' : status === 'rejected' ? 'danger' : status === 'pending' ? 'warning' : 'neutral';
  return <Badge tone={tone}>{t(`apps.status.${status}`)}</Badge>;
}

function ApplicationCard({ app }: { app: ApplicationDto }) {
  const { basePath } = useGuild();
  const now = useNow(60_000);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  return (
    <article className="glass flex flex-col gap-4 rounded-2xl p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <Avatar src={app.avatarUrl} name={app.username} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-semibold text-zinc-100" dir="auto">
              {app.username}
            </h3>
            <StatusBadge status={app.status} />
            {app.inGuild === false && (
              <Badge tone="warning">
                <UserRoundX className="size-3" />
                {t('streamers.leftGuild')}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-zinc-500" title={formatDateTime(app.createdAt)}>
            {t('apps.submitted', { when: formatRelative(app.createdAt, now) })}
            <span dir="ltr" className="ms-2 font-mono text-zinc-600">
              {app.userId}
            </span>
          </p>
        </div>
      </div>

      <ul className="space-y-1.5">
        {app.accounts.map((a, i) => {
          const href = applicationAccountUrl(a.platform, a.input);
          return (
            <li key={`${a.platform}-${i}`} className="flex items-center gap-2 rounded-xl bg-white/[0.03] px-3 py-2 ring-1 ring-inset ring-white/[0.05]">
              <PlatformIcon platform={a.platform} className="size-4" title={PLATFORM_META[a.platform].label} />
              <span className="text-xs text-zinc-500">{PLATFORM_META[a.platform].label}</span>
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer" dir="ltr" className="ms-auto flex min-w-0 items-center gap-1 truncate text-[13px] text-zinc-200 hover:underline">
                  <span className="truncate">{a.input}</span>
                  <ExternalLink className="size-3 shrink-0 text-zinc-500" />
                </a>
              ) : (
                <span dir="ltr" className="ms-auto truncate text-[13px] text-zinc-200">
                  {a.input}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {app.note && (
        <p className="flex items-start gap-2 rounded-xl bg-white/[0.02] p-3 text-[13px] leading-relaxed text-zinc-300 ring-1 ring-inset ring-white/[0.04]" dir="auto">
          <StickyNote className="mt-0.5 size-3.5 shrink-0 text-zinc-500" />
          <span className="whitespace-pre-wrap break-words">{app.note}</span>
        </p>
      )}

      {app.status !== 'pending' && (
        <div className="space-y-1 text-xs text-zinc-500">
          <p>
            {t('apps.decided', { when: app.decidedAt ? formatDateTime(app.decidedAt) : '—', by: app.reviewer?.username ?? app.reviewer?.id ?? t('apps.unknownReviewer') })}
          </p>
          {app.reviewNote && (
            <p className="text-zinc-400" dir="auto">
              {t('apps.reviewNote', { note: app.reviewNote })}
            </p>
          )}
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center justify-end gap-2 border-t border-white/[0.06] pt-3">
        {app.status === 'pending' ? (
          <>
            <Button size="sm" variant="danger-ghost" onClick={() => setRejecting(true)} icon={<X className="size-3.5" />}>
              {t('apps.reject')}
            </Button>
            <Button size="sm" variant="success" onClick={() => setApproving(true)} icon={<Check className="size-3.5" />}>
              {t('apps.approve')}
            </Button>
          </>
        ) : app.streamerId ? (
          <Link to={`${basePath}/streamers/${app.streamerId}`} className={buttonClasses('secondary', 'sm')}>
            {t('apps.openStreamer')}
          </Link>
        ) : null}
      </div>

      {approving && <ApproveDialog app={app} onClose={() => setApproving(false)} />}
      {rejecting && <RejectDialog app={app} onClose={() => setRejecting(false)} />}
    </article>
  );
}

interface EditableAccount {
  key: number;
  platform: Platform;
  input: string;
}

let accountKey = 1;

function ApproveDialog({ app, onClose }: { app: ApplicationDto; onClose: () => void }) {
  const { guildId, basePath } = useGuild();
  const approve = useApproveApplication(guildId);
  const navigate = useNavigate();
  const [rows, setRows] = useState<EditableAccount[]>(() => app.accounts.map((a) => ({ key: accountKey++, platform: a.platform, input: a.input })));
  const [statuses, setStatuses] = useState<Record<number, ResolveStatus>>({});
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const filled = rows.filter((r) => r.input.trim());
  const blocked = filled.some((r) => {
    const s = statuses[r.key];
    return s === 'typing' || s === 'checking';
  });
  const allInvalid = filled.length > 0 && filled.every((r) => isBlockingResolve(statuses[r.key] ?? 'idle') && statuses[r.key] !== 'typing' && statuses[r.key] !== 'checking');

  const submit = (): void => {
    if (filled.length === 0) {
      setError(t('apps.needAccount'));
      return;
    }
    setError(null);
    const accounts: AccountInput[] = filled.map((r) => ({ platform: r.platform, input: r.input.trim() }));
    approve.mutate(
      { id: app.id, body: { accounts, note: note.trim() || null } },
      {
        onSuccess: (result) => {
          const skipped = result.skipped.map((s) => `${PLATFORM_META[s.platform].label}: ${s.reason}`);
          toast.success(t('apps.approved', { name: result.streamer.displayName }), {
            description: skipped.length > 0 ? t('apps.skipped', { list: formatList(skipped) }) : undefined,
            action: { label: t('apps.openStreamer'), onClick: () => navigate(`${basePath}/streamers/${result.streamer.id}`) },
          });
          onClose();
        },
        onError: (e) => setError(isApiError(e) ? e.message : t('apps.approveFailed')),
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!approve.isPending}
      size="lg"
      icon={<Check className="size-5" />}
      title={t('apps.approveTitle', { name: app.username })}
      description={t('apps.approveDesc')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={approve.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="success" onClick={submit} loading={approve.isPending} disabled={blocked || filled.length === 0} icon={<Check className="size-4" />}>
            {t('apps.approveConfirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {rows.map((row) => (
          <ApproveAccountRow
            key={row.key}
            row={row}
            onChange={(patch) => setRows((list) => list.map((r) => (r.key === row.key ? { ...r, ...patch } : r)))}
            onRemove={() => setRows((list) => list.filter((r) => r.key !== row.key))}
            onStatus={(status) => setStatuses((s) => (s[row.key] === status ? s : { ...s, [row.key]: status }))}
          />
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="w-full border border-dashed border-white/15"
          icon={<Plus className="size-4" />}
          disabled={rows.length >= 12}
          onClick={() => setRows((list) => [...list, { key: accountKey++, platform: PLATFORMS.find((p) => !list.some((r) => r.platform === p)) ?? 'twitch', input: '' }])}
        >
          {t('apps.addAccount')}
        </Button>
        {allInvalid && <p className="text-xs text-amber-300/90">{t('apps.allInvalid')}</p>}
        <Field label={t('apps.noteLabel')} htmlFor={`approve-note-${app.id}`} hint={t('apps.noteHint')}>
          <Textarea id={`approve-note-${app.id}`} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} dir="auto" />
        </Field>
        {error && (
          <p className="text-[13px] text-rose-300" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function ApproveAccountRow({
  row,
  onChange,
  onRemove,
  onStatus,
}: {
  row: EditableAccount;
  onChange: (patch: Partial<EditableAccount>) => void;
  onRemove: () => void;
  onStatus: (status: ResolveStatus) => void;
}) {
  const state = useResolveState(row.platform, row.input);
  const reported = useRef<ResolveStatus | null>(null);
  useEffect(() => {
    if (reported.current === state.status) return;
    reported.current = state.status;
    onStatus(state.status);
  }, [state.status, onStatus]);
  return (
    <div className="space-y-2.5 rounded-2xl bg-white/[0.03] p-3 ring-1 ring-inset ring-white/[0.07]">
      <div className="flex items-center justify-between gap-2">
        <PlatformPicker value={row.platform} onChange={(platform) => onChange({ platform })} />
        <button type="button" onClick={onRemove} aria-label={t('add.removeAccount')} className="grid size-8 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-rose-500/10 hover:text-rose-300">
          <Trash2 className="size-4" />
        </button>
      </div>
      <div className="flex items-center gap-3">
        <PlatformTile platform={row.platform} size="sm" />
        <Input
          aria-label={t('add.accountAria', { platform: PLATFORM_META[row.platform].label })}
          dir={row.input ? 'ltr' : undefined}
          autoComplete="off"
          spellCheck={false}
          maxLength={300}
          className="flex-1"
          placeholder={PLATFORM_META[row.platform].placeholder}
          value={row.input}
          onChange={(e) => onChange({ input: e.target.value })}
          invalid={state.status === 'not_found' || state.status === 'invalid'}
        />
      </div>
      <ResolveStatusView state={state} compact />
    </div>
  );
}

function RejectDialog({ app, onClose }: { app: ApplicationDto; onClose: () => void }) {
  const { guildId } = useGuild();
  const reject = useRejectApplication(guildId);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (): void => {
    setError(null);
    reject.mutate(
      { id: app.id, note: reason.trim() || null },
      {
        onSuccess: () => {
          toast.success(t('apps.rejected', { name: app.username }));
          onClose();
        },
        onError: (e) => setError(isApiError(e) ? e.message : t('apps.rejectFailed')),
      },
    );
  };
  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!reject.isPending}
      size="sm"
      icon={<X className="size-5" />}
      title={t('apps.rejectTitle', { name: app.username })}
      description={t('apps.rejectDesc')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={reject.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" onClick={submit} loading={reject.isPending} icon={<X className="size-4" />}>
            {t('apps.rejectConfirm')}
          </Button>
        </>
      }
    >
      <Field label={t('apps.reasonLabel')} htmlFor={`reject-reason-${app.id}`} hint={t('apps.reasonHint')}>
        <Textarea id={`reject-reason-${app.id}`} data-autofocus rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} dir="auto" />
      </Field>
      {error && (
        <p className="mt-3 text-[13px] text-rose-300" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
