import { ChevronDown, Cog, Film, Hash, KeyRound, Plug, Radio, Shield, UserRound, Wrench } from 'lucide-react';
import { useState } from 'react';
import type { AuditEntry } from '../api/types';
import { useNow } from '../hooks/useNow';
import { actorLabel, auditCategory, AUDIT_CATEGORY_LABELS, type AuditCategory } from '../lib/audit';
import { cn } from '../lib/cn';
import { formatDateTime, formatRelative } from '../lib/format';
import { t } from '../i18n';

const CATEGORY_ICONS: Record<AuditCategory, typeof Radio> = {
  live: Radio,
  content: Film,
  streamer: UserRound,
  settings: Cog,
  roles: Shield,
  discord: Hash,
  provider: Plug,
  tools: Wrench,
  system: KeyRound,
};

const LEVEL_STYLES = {
  info: 'bg-white/[0.05] text-zinc-400 ring-white/[0.08]',
  warn: 'bg-amber-500/10 text-amber-300 ring-amber-500/25',
  error: 'bg-rose-500/10 text-rose-300 ring-rose-500/25',
} as const;

export function AuditRow({ entry, currentUserId, expandable = false }: { entry: AuditEntry; currentUserId?: string; expandable?: boolean }) {
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const category = auditCategory(entry.action);
  const Icon = CATEGORY_ICONS[category];
  const hasDetails = expandable && Object.keys(entry.details ?? {}).length > 0;
  const iconStyle = entry.level === 'info' && category === 'live' ? 'bg-rose-500/10 text-rose-300 ring-rose-500/25' : LEVEL_STYLES[entry.level];

  return (
    <div className="flex gap-3 py-3">
      <div className={cn('mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset', iconStyle)}>
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] leading-relaxed text-zinc-200">
          {entry.message}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-zinc-500">
          <span>{AUDIT_CATEGORY_LABELS[category]}</span>
          <span aria-hidden>•</span>
          <span>{actorLabel(entry.actor, currentUserId)}</span>
          <span aria-hidden>•</span>
          <time dateTime={entry.createdAt} title={formatDateTime(entry.createdAt)}>
            {formatRelative(entry.createdAt, now)}
          </time>
          {hasDetails && (
            <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-0.5 text-zinc-500 hover:text-zinc-300" aria-expanded={open}>
              {t('common.details')}
              <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} />
            </button>
          )}
        </div>
        {open && hasDetails && (
          <pre dir="ltr" className="mt-2 max-h-64 overflow-auto rounded-lg bg-black/40 p-3 text-start font-mono text-[11.5px] leading-relaxed text-zinc-400 ring-1 ring-inset ring-white/[0.06]">
            {JSON.stringify({ action: entry.action, ...entry.details }, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
