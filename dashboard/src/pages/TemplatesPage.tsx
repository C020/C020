import { Braces, Eye, Loader2, MessageSquareText, Palette, RefreshCw, RotateCcw, Send, Sparkles, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TEMPLATE_VARIABLES } from '../../../src/shared/api';
import { isApiError } from '../api/client';
import { useDiscordLookups, usePreview, useSettings, useTestMessage, useUpdateSettings } from '../api/queries';
import type { SettingsDto, TemplateSpec, Templates } from '../api/types';
import { DiscordMessage } from '../components/discord/DiscordMessage';
import type { MentionResolver } from '../components/discord/DiscordMarkdown';
import { PageHeader } from '../components/PageHeader';
import { SaveBar } from '../components/SaveBar';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { ErrorState } from '../components/ui/ErrorState';
import { Field } from '../components/ui/Field';
import { Input, Textarea } from '../components/ui/Input';
import { Skeleton } from '../components/ui/Skeleton';
import { Tabs } from '../components/ui/Tabs';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useGuild } from '../hooks/useGuild';
import { useModHotkey } from '../hooks/useHotkey';
import { useLatest } from '../hooks/useLatest';
import { useSession } from '../hooks/useSession';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard';
import { cn } from '../lib/cn';
import { confirmDialog } from '../lib/confirm';
import { colorIntToHex, hexToColorInt, roleColorHex } from '../lib/format';
import {
  DEFAULT_TEMPLATES,
  draftFromSpec,
  insertAtCursor,
  isDefaultDraft,
  previewSpec,
  sameDraft,
  specFromDraft,
  TEMPLATE_FIELD_LABELS,
  TEMPLATE_LIMITS,
  TEMPLATE_TYPE_LABELS,
  TEMPLATE_TYPES,
  unknownVariables,
  type TemplateDraft,
  type TemplateTextField,
  type TemplateType,
} from '../lib/templates';
import { toast } from '../lib/toast';

type Drafts = Record<TemplateType, TemplateDraft>;

function draftsFrom(templates: Templates): Drafts {
  return { live: draftFromSpec(templates.live), summary: draftFromSpec(templates.summary), content: draftFromSpec(templates.content) };
}

export default function TemplatesPage() {
  const { guildId } = useGuild();
  const settings = useSettings(guildId);
  return (
    <div className="space-y-6">
      <PageHeader title="الرسائل" icon={<MessageSquareText className="size-5" />} description="خصّص شكل إشعارات البث والملخص والمقاطع، وشوف المعاينة مباشرة" />
      {settings.data ? (
        <TemplatesEditor saved={settings.data} />
      ) : settings.isError ? (
        <Card>
          <ErrorState error={settings.error} onRetry={() => void settings.refetch()} retrying={settings.isFetching} />
        </Card>
      ) : (
        <div className="grid gap-5 xl:grid-cols-2">
          <Skeleton className="h-[560px] rounded-2xl" />
          <Skeleton className="h-[420px] rounded-2xl" />
        </div>
      )}
    </div>
  );
}

function TemplatesEditor({ saved }: { saved: SettingsDto }) {
  const { guildId } = useGuild();
  const updateSettings = useUpdateSettings(guildId);
  const testMessage = useTestMessage(guildId);
  const [params, setParams] = useSearchParams();
  const tab: TemplateType = TEMPLATE_TYPES.find((t) => t === params.get('type')) ?? 'live';
  const setTab = (next: TemplateType): void => {
    const p = new URLSearchParams(params);
    if (next === 'live') p.delete('type');
    else p.set('type', next);
    setParams(p, { replace: true });
  };

  const [bases, setBases] = useState<Drafts>(() => draftsFrom(saved.templates));
  const [drafts, setDrafts] = useState<Drafts>(() => draftsFrom(saved.templates));
  const [activeField, setActiveField] = useState<TemplateTextField>('description');
  const [externalChange, setExternalChange] = useState(false);
  const fieldRefs = useRef<Partial<Record<TemplateTextField, HTMLInputElement | HTMLTextAreaElement | null>>>({});

  const dirtyTypes = TEMPLATE_TYPES.filter((t) => !sameDraft(drafts[t], bases[t]));
  const dirty = dirtyTypes.length > 0;
  const draft = drafts[tab];
  const overLimit = (Object.keys(TEMPLATE_LIMITS) as TemplateTextField[]).some((f) => [...draft[f]].length > TEMPLATE_LIMITS[f]);

  // Adopt templates saved elsewhere for every type the user is not editing.
  const latest = useLatest({ bases, drafts });
  useEffect(() => {
    const incoming = draftsFrom(saved.templates);
    const { bases: currentBases, drafts: currentDrafts } = latest.current;
    let conflict = false;
    const nextBases = { ...currentBases };
    const nextDrafts = { ...currentDrafts };
    for (const t of TEMPLATE_TYPES) {
      if (sameDraft(incoming[t], currentBases[t])) continue;
      const editing = !sameDraft(currentDrafts[t], currentBases[t]);
      if (editing && !sameDraft(currentDrafts[t], incoming[t])) {
        conflict = true;
        continue;
      }
      nextBases[t] = incoming[t];
      nextDrafts[t] = incoming[t];
    }
    setBases(nextBases);
    setDrafts(nextDrafts);
    setExternalChange(conflict);
  }, [saved.templates, latest]);

  useUnsavedChangesGuard(dirty);

  const setField = <K extends keyof TemplateDraft>(key: K, value: TemplateDraft[K]): void => {
    setDrafts((d) => ({ ...d, [tab]: { ...d[tab], [key]: value } }));
  };

  const insertVariable = (key: string): void => {
    const field = activeField;
    const el = fieldRefs.current[field];
    const current = drafts[tab][field];
    const { text, caret } = insertAtCursor(current, el?.selectionStart ?? null, el?.selectionEnd ?? null, `{${key}}`);
    setField(field, text);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const save = (): Promise<boolean> =>
    new Promise((resolve) => {
      if (!dirty) return resolve(true);
      if (overLimit) {
        toast.error('فيه نص أطول من حد ديسكورد');
        return resolve(false);
      }
      const templates: Partial<Record<TemplateType, TemplateSpec>> = {};
      for (const t of dirtyTypes) templates[t] = specFromDraft(drafts[t]);
      updateSettings.mutate(
        { templates },
        {
          onSuccess: (next) => {
            const fresh = draftsFrom(next.templates);
            setBases(fresh);
            setDrafts((d) => {
              const out = { ...d };
              for (const t of dirtyTypes) out[t] = fresh[t];
              return out;
            });
            setExternalChange(false);
            toast.success(dirtyTypes.length > 1 ? 'تم حفظ القوالب' : 'تم حفظ القالب');
            resolve(true);
          },
          onError: (error) => {
            toast.error(isApiError(error) ? error.message : 'ما قدرنا نحفظ القالب');
            resolve(false);
          },
        },
      );
    });

  useModHotkey('s', () => void save(), dirty);

  const discard = (): void => {
    setDrafts(bases);
    setExternalChange(false);
  };

  const resetToDefault = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: `إرجاع ${TEMPLATE_TYPE_LABELS[tab].label} للافتراضي؟`,
      description: 'بتنمسح التخصيصات حقت هذا النوع وترجع الرسالة الافتراضية. التغيير ما ينحفظ إلا لما تضغط حفظ.',
      confirmLabel: 'إرجاع للافتراضي',
    });
    if (ok) setDrafts((d) => ({ ...d, [tab]: draftFromSpec(undefined) }));
  };

  const sendTest = async (): Promise<void> => {
    if (!sameDraft(drafts[tab], bases[tab])) {
      const ok = await confirmDialog({
        title: 'نحفظ التغييرات أول؟',
        description: 'رسالة التجربة تنرسل بالقالب المحفوظ. بنحفظ تعديلاتك وبعدها نرسل التجربة.',
        confirmLabel: 'حفظ وإرسال',
      });
      if (!ok || !(await save())) return;
    }
    testMessage.mutate(tab, {
      onSuccess: (result) =>
        toast.success('انرسلت رسالة التجربة', {
          description: tab === 'content' ? 'في روم إشعارات المقاطع' : 'في روم إشعارات البث',
          action: result.messageUrl ? { label: 'فتح الرسالة في ديسكورد', href: result.messageUrl } : undefined,
        }),
    });
  };

  const variables = TEMPLATE_VARIABLES[tab];

  return (
    <>
      <Tabs<TemplateType>
        value={tab}
        onChange={setTab}
        items={TEMPLATE_TYPES.map((t) => ({
          value: t,
          label: TEMPLATE_TYPE_LABELS[t].label,
          badge: !sameDraft(drafts[t], bases[t]) ? (
            <span className="size-1.5 rounded-full bg-amber-400" aria-label="فيه تغييرات" />
          ) : !isDefaultDraft(bases[t]) ? (
            <Badge tone="violet" size="sm">
              مخصص
            </Badge>
          ) : undefined,
        }))}
      />

      {externalChange && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl bg-sky-500/[0.07] p-4 ring-1 ring-inset ring-sky-500/20">
          <RefreshCw className="size-4 text-sky-300" />
          <p className="flex-1 text-[13px] text-sky-100/90">القوالب تغيّرت من مكان ثاني وأنت تعدّل. لو حفظت بتنكتب تعديلاتك فوقها.</p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              const fresh = draftsFrom(saved.templates);
              setBases(fresh);
              setDrafts(fresh);
              setExternalChange(false);
            }}
          >
            تحميل النسخة الجديدة
          </Button>
        </div>
      )}

      <div className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            icon={<Sparkles className="size-[18px]" />}
            title={TEMPLATE_TYPE_LABELS[tab].label}
            description={TEMPLATE_TYPE_LABELS[tab].description}
            actions={
              <Button size="sm" variant="ghost" onClick={() => void resetToDefault()} disabled={isDefaultDraft(draft)} icon={<RotateCcw className="size-3.5" />}>
                الافتراضي
              </Button>
            }
          />
          <CardBody className="space-y-5">
            <div className="rounded-xl bg-white/[0.02] p-3 ring-1 ring-inset ring-white/[0.05]">
              <p className="mb-2 flex items-center gap-1.5 text-xs text-zinc-400">
                <Braces className="size-3.5" />
                المتغيرات — اضغط عشان تنضاف في
                <span className="font-medium text-violet-300">{TEMPLATE_FIELD_LABELS[activeField].label}</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {variables.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    title={v.description}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertVariable(v.key)}
                    className="group inline-flex h-7 items-center gap-1.5 rounded-lg bg-violet-500/10 px-2 text-xs ring-1 ring-inset ring-violet-400/20 transition-colors hover:bg-violet-500/20"
                  >
                    <code dir="ltr" className="font-mono text-violet-200">{`{${v.key}}`}</code>
                    <span className="hidden text-zinc-400 group-hover:text-zinc-300 sm:inline">{v.description}</span>
                  </button>
                ))}
              </div>
            </div>

            {(['content', 'title', 'description', 'footer'] as const).map((field) => (
              <TemplateTextInput
                key={`${tab}-${field}`}
                field={field}
                value={draft[field]}
                placeholder={DEFAULT_TEMPLATES[tab][field]}
                variables={variables}
                active={activeField === field}
                onFocus={() => setActiveField(field)}
                onChange={(v) => setField(field, v)}
                inputRef={(el) => {
                  fieldRefs.current[field] = el;
                }}
              />
            ))}

            <ColorField value={draft.color} onChange={(c) => setField('color', c)} />
          </CardBody>
        </Card>

        <PreviewPanel type={tab} draft={draft} onTest={() => void sendTest()} testing={testMessage.isPending} />
      </div>

      <SaveBar
        visible={dirty}
        changeCount={dirtyTypes.length}
        errorCount={overLimit ? 1 : 0}
        saving={updateSettings.isPending}
        onSave={() => void save()}
        onReset={discard}
        saveLabel={dirtyTypes.length > 1 ? 'حفظ القوالب' : 'حفظ القالب'}
      />
    </>
  );
}

function TemplateTextInput({
  field,
  value,
  placeholder,
  variables,
  active,
  onFocus,
  onChange,
  inputRef,
}: {
  field: TemplateTextField;
  value: string;
  placeholder: string;
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
    placeholder: placeholder ? `الافتراضي: ${placeholder.replace(/\n/g, ' ⏎ ')}` : 'فاضي (بدون نص)',
    invalid: length > limit,
    dir: 'auto' as const,
  };

  return (
    <Field
      label={
        <span className="inline-flex items-center gap-1.5">
          {meta.label}
          {active && <span className="size-1.5 rounded-full bg-violet-400" title="المتغيرات تنضاف هنا" />}
        </span>
      }
      htmlFor={id}
      hint={unknown.length > 0 ? undefined : meta.hint}
      error={length > limit ? `النص أطول من حد ديسكورد (${limit} حرف)` : null}
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
          متغيرات غير معروفة (بتطلع فاضية):
          <code dir="ltr" className="font-mono">
            {unknown.map((k) => `{${k}}`).join(' ')}
          </code>
        </p>
      )}
    </Field>
  );
}

const COLOR_PRESETS = [0x5865f2, 0x9146ff, 0x53fc18, 0xff0000, 0xfe2c55, 0xf59e0b, 0x10b981, 0x0ea5e9, 0xec4899, 0xffffff];

function ColorField({ value, onChange }: { value: number | null; onChange: (color: number | null) => void }) {
  const hex = colorIntToHex(value);
  const [text, setText] = useState(hex ?? '');
  useEffect(() => setText(hex ?? ''), [hex]);

  return (
    <Field label="لون الـ Embed" hint="اتركه على «لون المنصة» عشان ياخذ لون تويتش/كيك/يوتيوب/تيك توك تلقائياً." aside={<Palette className="size-3.5" />}>
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
          لون المنصة
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
        <label className="relative grid size-9 cursor-pointer place-items-center overflow-hidden rounded-xl ring-1 ring-inset ring-white/15" title="لون مخصص">
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

function PreviewPanel({ type, draft, onTest, testing }: { type: TemplateType; draft: TemplateDraft; onTest: () => void; testing: boolean }) {
  const { guildId } = useGuild();
  const me = useSession();
  const spec = useMemo(() => previewSpec(type, draft), [type, draft]);
  const debounced = useDebouncedValue(spec, 450);
  const preview = usePreview(guildId, type, debounced);
  const lookups = useDiscordLookups(guildId);

  const resolver = useMemo<MentionResolver>(() => {
    const roles = new Map((lookups.data?.roles ?? []).map((r) => [r.id, r]));
    const channels = new Map((lookups.data?.channels ?? []).map((c) => [c.id, c.name]));
    return {
      role: (id) => {
        const role = roles.get(id);
        return role ? { name: role.name, color: roleColorHex(role.color) } : null;
      },
      channel: (id) => channels.get(id) ?? null,
      user: (id) => (id === me.bot?.id ? 'ستريمر تجريبي' : null),
    };
  }, [lookups.data, me.bot?.id]);

  const updating = preview.isFetching || spec !== debounced;

  return (
    <Card className="xl:sticky xl:top-24">
      <CardHeader
        icon={<Eye className="size-[18px]" />}
        title="المعاينة"
        description="ببيانات تجريبية، بنفس شكل ديسكورد"
        actions={
          <>
            {updating && <Loader2 className="size-4 animate-spin text-zinc-500" aria-label="جاري التحديث" />}
            <Button size="sm" variant="primary" onClick={onTest} loading={testing} icon={<Send className="size-3.5" />}>
              إرسال تجربة
            </Button>
          </>
        }
      />
      <CardBody>
        {preview.data ? (
          <div className={cn('transition-opacity', preview.isPlaceholderData && 'opacity-70')}>
            <DiscordMessage message={preview.data} author={{ name: me.bot?.username ?? 'Stream Bot', avatarUrl: me.bot?.avatarUrl ?? null, id: me.bot?.id }} resolver={resolver} />
          </div>
        ) : preview.isError ? (
          <ErrorState compact error={preview.error} onRetry={() => void preview.refetch()} retrying={preview.isFetching} title="ما قدرنا نجهز المعاينة" />
        ) : (
          <Skeleton className="h-72 rounded-xl" />
        )}
        {preview.isError && preview.data && <p className="mt-2 text-xs text-amber-300/90">آخر تحديث للمعاينة فشل، المعروضة قديمة.</p>}
      </CardBody>
    </Card>
  );
}
