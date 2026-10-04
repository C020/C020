import { Check, ChevronDown, Hash, Megaphone, Search, ShieldAlert, TriangleAlert, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { DiscordChannel, DiscordRole } from '../api/types';
import { cn } from '../lib/cn';
import { extractSnowflake, isSnowflake } from '../lib/discord';
import { roleColorHex } from '../lib/format';
import { Spinner } from './ui/Spinner';

export interface PickerOption {
  id: string;
  label: string;
  sublabel?: string;
  icon?: ReactNode;
  /** Shown under the control when this option is selected, and as a small marker in the list. */
  warning?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export interface EntityPickerProps {
  id?: string;
  value: string;
  onChange: (id: string) => void;
  options: PickerOption[];
  loading?: boolean;
  /** Lookups failed: the picker still accepts a pasted ID. */
  unavailable?: boolean;
  placeholder: string;
  searchPlaceholder?: string;
  notFoundText: string;
  invalid?: boolean;
  allowClear?: boolean;
  emptyIcon?: ReactNode;
}

/**
 * Combobox that accepts either a choice from the Discord lookup list or a raw ID typed/pasted directly
 * (also works when the bot can't fetch the list right now).
 */
export function EntityPicker({
  id,
  value,
  onChange,
  options,
  loading,
  unavailable,
  placeholder,
  searchPlaceholder = 'ابحث بالاسم أو الصق الآيدي…',
  notFoundText,
  invalid,
  allowClear = true,
  emptyIcon,
}: EntityPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const selected = useMemo(() => options.find((o) => o.id === value) ?? null, [options, value]);
  const trimmedValue = value.trim();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    const asId = extractSnowflake(q);
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.id.includes(asId) || o.sublabel?.toLowerCase().includes(q));
  }, [options, query]);

  const pastedId = extractSnowflake(query);
  const offerRawId = isSnowflake(pastedId) && !options.some((o) => o.id === pastedId);
  const rows: Array<{ kind: 'raw'; id: string } | { kind: 'option'; option: PickerOption }> = [
    ...(offerRawId ? [{ kind: 'raw' as const, id: pastedId }] : []),
    ...filtered.map((option) => ({ kind: 'option' as const, option })),
  ];

  useEffect(() => {
    if (!open) return;
    setActive(0);
    const t = setTimeout(() => searchRef.current?.focus(), 10);
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  useEffect(() => setActive(0), [query]);

  const choose = (nextId: string): void => {
    onChange(nextId);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[active];
      if (!row) return;
      if (row.kind === 'raw') choose(row.id);
      else if (!row.option.disabled) choose(row.option.id);
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
    }
  };

  const warning = selected?.warning ?? (trimmedValue && !selected && !loading && !unavailable ? notFoundText : null);

  return (
    <div ref={rootRef} className="relative">
      <button
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-invalid={invalid || undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (allowClear && trimmedValue && (e.key === 'Delete' || e.key === 'Backspace')) {
            e.preventDefault();
            onChange('');
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(
          'flex h-10 w-full items-center gap-2 rounded-xl bg-zinc-900/70 pe-2 ps-3 text-start text-sm ring-inset transition-[box-shadow] focus:outline-none',
          invalid
            ? 'ring-1 ring-rose-500/60 focus-visible:ring-2'
            : open
              ? 'ring-2 ring-violet-500/70'
              : 'ring-1 ring-white/[0.08] hover:ring-white/[0.14] focus-visible:ring-2 focus-visible:ring-violet-500/70',
        )}
      >
        {selected ? (
          <>
            {selected.icon}
            <span className="truncate text-zinc-100">{selected.label}</span>
            {selected.sublabel && <span className="hidden truncate text-xs text-zinc-500 sm:inline">{selected.sublabel}</span>}
          </>
        ) : trimmedValue ? (
          <>
            <TriangleAlert className="size-4 shrink-0 text-amber-400" />
            <span dir="ltr" className="truncate font-mono text-[13px] text-zinc-300">
              {trimmedValue}
            </span>
          </>
        ) : (
          <span className="truncate text-zinc-500">{placeholder}</span>
        )}
        <span className="ms-auto flex shrink-0 items-center gap-1">
          {loading && <Spinner className="size-3.5 text-zinc-500" />}
          {trimmedValue && (
            <span dir="ltr" className="hidden font-mono text-[11px] text-zinc-600 md:inline">
              {trimmedValue}
            </span>
          )}
          {allowClear && trimmedValue && (
            <span
              role="button"
              aria-label="مسح"
              onClick={(e) => {
                e.stopPropagation();
                onChange('');
              }}
              className="grid size-6 place-items-center rounded-md text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
            >
              <X className="size-3.5" />
            </span>
          )}
          <ChevronDown className={cn('size-4 text-zinc-500 transition-transform', open && 'rotate-180')} />
        </span>
      </button>

      {warning && !open && (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-amber-300/90">
          <ShieldAlert className="mt-px size-3.5 shrink-0" />
          {warning}
        </p>
      )}

      {open && (
        <div className="absolute inset-x-0 top-full z-30 mt-1.5 animate-pop-in overflow-hidden rounded-xl border border-white/[0.08] bg-zinc-900/98 shadow-2xl shadow-black/60 backdrop-blur-xl">
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-3">
            <Search className="size-4 shrink-0 text-zinc-500" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              className="h-10 w-full bg-transparent text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
            />
          </div>
          {unavailable && (
            <p className="border-b border-white/[0.06] bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-amber-300/90">
              ما قدرنا نجيب القائمة من ديسكورد الحين، تقدر تلصق الآيدي مباشرة.
            </p>
          )}
          <ul id={listId} role="listbox" className="max-h-72 overflow-y-auto p-1.5">
            {rows.length === 0 && (
              <li className="flex flex-col items-center gap-2 px-3 py-6 text-center text-[13px] text-zinc-500">
                {emptyIcon}
                {loading ? 'جاري التحميل…' : query ? 'ما فيه نتائج. تقدر تلصق الآيدي (17–20 رقم).' : 'القائمة فاضية'}
              </li>
            )}
            {rows.map((row, index) => {
              if (row.kind === 'raw') {
                return (
                  <li
                    key="raw"
                    role="option"
                    aria-selected={index === active}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(row.id)}
                    className={cn('flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm', index === active ? 'bg-white/[0.07]' : '')}
                  >
                    <TriangleAlert className="size-4 shrink-0 text-amber-400" />
                    <span className="text-zinc-200">استخدام الآيدي مباشرة</span>
                    <span dir="ltr" className="ms-auto font-mono text-xs text-zinc-500">
                      {row.id}
                    </span>
                  </li>
                );
              }
              const { option } = row;
              const isSelected = option.id === value;
              return (
                <li
                  key={option.id}
                  role="option"
                  aria-selected={index === active}
                  aria-disabled={option.disabled || undefined}
                  title={option.disabled ? option.disabledReason : option.warning}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => !option.disabled && choose(option.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm',
                    option.disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
                    index === active && !option.disabled && 'bg-white/[0.07]',
                  )}
                >
                  {option.icon}
                  <span className="min-w-0 truncate text-zinc-200">{option.label}</span>
                  {option.sublabel && <span className="hidden min-w-0 truncate text-xs text-zinc-500 sm:inline">{option.sublabel}</span>}
                  <span className="ms-auto flex shrink-0 items-center gap-1.5">
                    {option.warning && !option.disabled && <TriangleAlert className="size-3.5 text-amber-400" />}
                    {option.disabled && option.disabledReason && <span className="text-[11px] text-zinc-500">{option.disabledReason}</span>}
                    {isSelected && <Check className="size-4 text-violet-400" />}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ───────────── Discord-specific pickers ─────────────

const ROLE_NOT_FOUND_TEXT = 'هذي الرتبة مو موجودة في السيرفر (يمكن انحذفت).';

function RoleDot({ color }: { color: number }) {
  return <span className="size-3 shrink-0 rounded-full ring-2 ring-black/30" style={{ backgroundColor: roleColorHex(color) }} />;
}

export interface RolePickerProps extends Omit<EntityPickerProps, 'options' | 'placeholder' | 'notFoundText'> {
  roles: DiscordRole[] | undefined;
  guildId: string;
  /** "assign": the bot must be able to give this role; "mention": only pinged. */
  purpose: 'assign' | 'mention';
  placeholder?: string;
}

export function RolePicker({ roles, guildId, purpose, placeholder = 'اختر رتبة أو الصق الآيدي', ...rest }: RolePickerProps) {
  const options = useMemo<PickerOption[]>(
    () =>
      (roles ?? [])
        .filter((r) => r.id !== guildId)
        .map((role) => {
          const managed = role.managed && purpose === 'assign';
          return {
            id: role.id,
            label: role.name,
            icon: <RoleDot color={role.color} />,
            disabled: managed,
            disabledReason: managed ? 'تابعة لبوت/تكامل' : undefined,
            warning:
              purpose === 'assign' && !role.assignable && !role.managed
                ? 'البوت ما يقدر يعطي هذي الرتبة: رتبته لازم تكون فوقها في ترتيب الرتب (وعنده Manage Roles).'
                : undefined,
          };
        }),
    [roles, guildId, purpose],
  );
  return <EntityPicker options={options} placeholder={placeholder} notFoundText={ROLE_NOT_FOUND_TEXT} {...rest} />;
}

export interface ChannelPickerProps extends Omit<EntityPickerProps, 'options' | 'placeholder' | 'notFoundText'> {
  channels: DiscordChannel[] | undefined;
  placeholder?: string;
}

export function ChannelPicker({ channels, placeholder = 'اختر روم أو الصق الآيدي', ...rest }: ChannelPickerProps) {
  const options = useMemo<PickerOption[]>(
    () =>
      (channels ?? []).map((channel) => ({
        id: channel.id,
        label: channel.name,
        sublabel: channel.parentName ?? undefined,
        icon: channel.type === 'announcement' ? <Megaphone className="size-4 shrink-0 text-zinc-500" /> : <Hash className="size-4 shrink-0 text-zinc-500" />,
        warning: channel.botCanPost ? undefined : 'البوت ما يقدر يرسل في هذا الروم: اسمح له بـ View Channel و Send Messages و Embed Links (و Attach Files لصور تيك توك).',
      })),
    [channels],
  );
  return <EntityPicker options={options} placeholder={placeholder} notFoundText="هذا الروم مو موجود في السيرفر (أو البوت ما يشوفه)." {...rest} />;
}

