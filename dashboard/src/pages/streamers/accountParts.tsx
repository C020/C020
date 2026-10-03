import { CircleCheck, CircleX, ExternalLink, KeyRound, Loader2, Timer } from 'lucide-react';
import { useState } from 'react';
import { isApiError } from '../../api/client';
import { useResolve } from '../../api/queries';
import type { ContentKind, Platform, ResolvePreview } from '../../api/types';
import { PlatformIcon } from '../../components/PlatformIcon';
import { Avatar } from '../../components/ui/Avatar';
import { ToggleChip } from '../../components/ui/Chip';
import { Segmented } from '../../components/ui/Segmented';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { cn } from '../../lib/cn';
import { CONTENT_KIND_HINTS, CONTENT_KIND_LABELS_AR, PLATFORM_META, PLATFORMS } from '../../lib/platforms';

export type ResolveStatus = 'idle' | 'typing' | 'checking' | 'ok' | 'not_found' | 'invalid' | 'unconfigured' | 'rate_limited' | 'error';

export interface ResolveState {
  status: ResolveStatus;
  preview: ResolvePreview | null;
  message: string | null;
}

/** Statuses that must block saving (the server would reject the account anyway). */
export function isBlockingResolve(status: ResolveStatus): boolean {
  return status === 'not_found' || status === 'invalid' || status === 'unconfigured' || status === 'typing' || status === 'checking';
}

/** Debounced live lookup of a platform handle/URL via POST /api/platforms/resolve. */
export function useResolveState(platform: Platform, input: string): ResolveState {
  const trimmed = input.trim();
  const debounced = useDebouncedValue(trimmed, 650);
  const query = useResolve(platform, debounced);

  if (!trimmed) return { status: 'idle', preview: null, message: null };
  if (trimmed.length < 2) return { status: 'invalid', preview: null, message: 'قصير مرة' };
  if (debounced !== trimmed) return { status: 'typing', preview: null, message: null };
  if (query.isPending || (query.isFetching && !query.data)) return { status: 'checking', preview: null, message: null };
  if (query.data) return { status: 'ok', preview: query.data, message: null };
  const error = query.error;
  if (isApiError(error)) {
    if (error.status === 404) return { status: 'not_found', preview: null, message: error.message || 'الحساب غير موجود على المنصة' };
    if (error.code === 'provider_not_configured') return { status: 'unconfigured', preview: null, message: error.message };
    if (error.status === 400) return { status: 'invalid', preview: null, message: error.message };
    if (error.status === 429) return { status: 'rate_limited', preview: null, message: error.message };
    return { status: 'error', preview: null, message: error.message };
  }
  return { status: 'error', preview: null, message: 'ما قدرنا نتحقق من الحساب الحين' };
}

export function ResolveStatusView({ state, compact = false }: { state: ResolveState; compact?: boolean }) {
  switch (state.status) {
    case 'idle':
      return null;
    case 'typing':
    case 'checking':
      return (
        <p className="flex items-center gap-1.5 text-xs text-zinc-500">
          <Loader2 className="size-3.5 animate-spin" />
          نتحقق من الحساب…
        </p>
      );
    case 'ok': {
      const p = state.preview!;
      return (
        <div className={cn('flex items-center gap-2.5 rounded-xl bg-emerald-500/[0.06] ring-1 ring-inset ring-emerald-500/15', compact ? 'p-1.5 pe-3' : 'p-2 pe-3')}>
          <Avatar src={p.avatarUrl} name={p.displayName} size={compact ? 26 : 32} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-zinc-100" dir="auto">
              {p.displayName}
            </p>
            <p dir="ltr" className="truncate text-end text-[11px] text-zinc-500">
              {p.handle}
            </p>
          </div>
          <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-zinc-500 hover:text-zinc-200" aria-label="فتح الحساب">
            <ExternalLink className="size-3.5" />
          </a>
          <CircleCheck className="size-4 shrink-0 text-emerald-400" />
        </div>
      );
    }
    case 'unconfigured':
      return (
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-amber-300/90">
          <KeyRound className="mt-px size-3.5 shrink-0" />
          {state.message}
        </p>
      );
    case 'rate_limited':
      return (
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-amber-300/90">
          <Timer className="mt-px size-3.5 shrink-0" />
          {state.message} (تقدر تحفظ، والبوت بيتحقق وقت الحفظ)
        </p>
      );
    default:
      return (
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-rose-300">
          <CircleX className="mt-px size-3.5 shrink-0" />
          {state.message}
        </p>
      );
  }
}

export function PlatformPicker({ value, onChange }: { value: Platform; onChange: (p: Platform) => void }) {
  return (
    <Segmented<Platform>
      size="sm"
      value={value}
      onChange={onChange}
      ariaLabel="المنصة"
      options={PLATFORMS.map((p) => ({
        value: p,
        label: PLATFORM_META[p].label,
        icon: <PlatformIcon platform={p} className="size-3.5" />,
      }))}
    />
  );
}

/** Per-account content kinds: inherit the guild setting (null) or pick from what the platform supports. */
export function ContentKindsOverride({
  platform,
  value,
  onChange,
  guildKinds,
  disabled,
}: {
  platform: Platform;
  value: ContentKind[] | null;
  onChange: (kinds: ContentKind[] | null) => void;
  guildKinds?: ContentKind[];
  disabled?: boolean;
}) {
  const supported = PLATFORM_META[platform].contentKinds;
  const [custom, setCustom] = useState(value !== null);
  const inherited = supported.filter((k) => guildKinds?.includes(k) ?? true);

  return (
    <div className="space-y-2">
      <Segmented<'inherit' | 'custom'>
        size="sm"
        value={custom ? 'custom' : 'inherit'}
        onChange={(mode) => {
          setCustom(mode === 'custom');
          onChange(mode === 'custom' ? (value ?? inherited) : null);
        }}
        options={[
          { value: 'inherit', label: 'حسب إعدادات السيرفر', disabled },
          { value: 'custom', label: 'مخصص', disabled },
        ]}
      />
      {custom ? (
        <div className="flex flex-wrap gap-1.5">
          {supported.map((kind) => {
            const selected = (value ?? []).includes(kind);
            return (
              <ToggleChip
                key={kind}
                size="sm"
                selected={selected}
                disabled={disabled}
                title={CONTENT_KIND_HINTS[kind]}
                onToggle={() => onChange(selected ? (value ?? []).filter((k) => k !== kind) : [...(value ?? []), kind])}
              >
                {CONTENT_KIND_LABELS_AR[kind]}
              </ToggleChip>
            );
          })}
          {(value ?? []).length === 0 && <span className="self-center text-[11px] text-amber-300/90">ولا نوع: ما راح تنرسل مقاطع لهذا الحساب</span>}
        </div>
      ) : (
        <p className="text-[11.5px] text-zinc-500">
          {inherited.length > 0 ? `حالياً: ${inherited.map((k) => CONTENT_KIND_LABELS_AR[k]).join('، ')}` : 'إعدادات السيرفر ما فيها أنواع تنطبق على هذي المنصة'}
        </p>
      )}
    </div>
  );
}
