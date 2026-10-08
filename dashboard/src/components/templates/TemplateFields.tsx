import { Palette, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { colorIntToHex, hexToColorInt, roleColorHex } from '../../lib/format';
import { TEMPLATE_FIELD_LABELS, TEMPLATE_LIMITS, unknownVariables, type TemplateTextField } from '../../lib/templates';
import { Field } from '../ui/Field';
import { Input, Textarea } from '../ui/Input';
import { t } from '../../i18n';

/** Editor building blocks shared by the Templates page and the streamer drawer's custom messages (#5). */
export function TemplateTextInput({
  field,
  value,
  placeholder,
  emptyPlaceholder,
  variables,
  active,
  onFocus,
  onChange,
  inputRef,
}: {
  field: TemplateTextField;
  value: string;
  placeholder: string;
  /** Placeholder when there is no default text (e.g. "inherits the server template"). */
  emptyPlaceholder?: string;
  variables: ReadonlyArray<{ key: string }>;
  active: boolean;
  onFocus: () => void;
  onChange: (value: string) => void;
  inputRef: (el: HTMLInputElement | HTMLTextAreaElement | null) => void;
}) {
  const limit = TEMPLATE_LIMITS[field];
  const length = [...value].length;
  const unknown = unknownVariables(value, variables);
  const multiline = field === 'content' || field === 'description';
  const id = `tpl-${field}`;
  const meta = TEMPLATE_FIELD_LABELS[field];
  const common = {
    id,
    value,
    onFocus,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
    placeholder: placeholder ? t('tpl.defaultPlaceholder', { text: placeholder.replace(/\n/g, ' ⏎ ') }) : (emptyPlaceholder ?? t('tpl.emptyPlaceholder')),
    invalid: length > limit,
    dir: 'auto' as const,
  };

  return (
    <Field
      label={
        <span className="inline-flex items-center gap-1.5">
          {meta.label}
          {active && <span className="size-1.5 rounded-full bg-violet-400" title={t('tpl.insertHere')} />}
        </span>
      }
      htmlFor={id}
      hint={unknown.length > 0 ? undefined : meta.hint}
      error={length > limit ? t('tpl.overLimit', { limit }) : null}
      aside={<span className={cn('tabular-nums', length > limit * 0.9 && 'text-amber-400', length > limit && 'text-rose-400')}>{`${length}/${limit}`}</span>}
    >
      {multiline ? (
        <Textarea {...common} ref={inputRef} rows={field === 'description' ? 4 : 2} />
      ) : (
        <Input {...common} ref={inputRef} />
      )}
      {unknown.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-amber-300/90">
          <TriangleAlert className="size-3.5 shrink-0" />
          {t('tpl.unknownVars')}
          <code dir="ltr" className="font-mono">
            {unknown.map((k) => `{${k}}`).join(' ')}
          </code>
        </p>
      )}
    </Field>
  );
}

const COLOR_PRESETS = [0x5865f2, 0x9146ff, 0x53fc18, 0xff0000, 0xfe2c55, 0xf59e0b, 0x10b981, 0x0ea5e9, 0xec4899, 0xffffff];

export function ColorField({
  value,
  onChange,
  label = t('tpl.color'),
  hint = t('tpl.colorHint'),
  inheritLabel = t('tpl.platformColor'),
}: {
  value: number | null;
  onChange: (color: number | null) => void;
  label?: string;
  hint?: string;
  inheritLabel?: string;
}) {
  const hex = colorIntToHex(value);
  const [text, setText] = useState(hex ?? '');
  useEffect(() => setText(hex ?? ''), [hex]);

  return (
    <Field label={label} hint={hint} aside={<Palette className="size-3.5" />}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-pressed={value === null}
          className={cn(
            'inline-flex h-9 items-center gap-2 rounded-xl px-3 text-[13px] ring-1 ring-inset transition-colors',
            value === null ? 'bg-violet-500/15 text-violet-200 ring-violet-400/40' : 'text-zinc-400 ring-white/10 hover:text-zinc-200',
          )}
        >
          <span className="size-4 rounded-full" style={{ background: 'conic-gradient(#9146ff 0 25%, #53fc18 0 50%, #ff0000 0 75%, #fe2c55 0)' }} />
          {inheritLabel}
        </button>
        <div className="flex flex-wrap gap-1.5">
          {COLOR_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={colorIntToHex(c) ?? ''}
              onClick={() => onChange(c)}
              className={cn('size-7 rounded-lg ring-1 ring-inset ring-white/15 transition-transform hover:scale-110', value === c && 'ring-2 ring-white')}
              style={{ backgroundColor: roleColorHex(c) }}
            />
          ))}
        </div>
        <label className="relative grid size-9 cursor-pointer place-items-center overflow-hidden rounded-xl ring-1 ring-inset ring-white/15" title={t('tpl.customColor')}>
          <input type="color" value={hex ?? '#5865f2'} onChange={(e) => onChange(hexToColorInt(e.target.value))} className="absolute inset-0 size-full cursor-pointer opacity-0" />
          <span className="size-5 rounded-md" style={{ backgroundColor: hex ?? 'transparent', backgroundImage: hex ? undefined : 'linear-gradient(135deg, #3f3f46 25%, transparent 25%, transparent 50%, #3f3f46 50%, #3f3f46 75%, transparent 75%)', backgroundSize: '8px 8px' }} />
        </label>
        <Input
          dir="ltr"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const parsed = hexToColorInt(e.target.value);
            if (parsed !== null) onChange(parsed);
          }}
          onBlur={() => setText(hex ?? '')}
          placeholder="#5865F2"
          block={false}
          className="w-28 font-mono"
        />
      </div>
    </Field>
  );
}

