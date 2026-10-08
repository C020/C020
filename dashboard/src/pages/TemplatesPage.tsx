import { Braces, Eye, Loader2, MessageSquareText, RefreshCw, RotateCcw, Send, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TEMPLATE_VARIABLES } from '../../../src/shared/api';
import { isApiError } from '../api/client';
import { useDiscordLookups, usePreview, useSettings, useTestMessage, useUpdateSettings } from '../api/queries';
import type { SettingsDto, TemplateSpec, Templates } from '../api/types';
import { DiscordMessage } from '../components/discord/DiscordMessage';
import { ColorField, TemplateTextInput } from '../components/templates/TemplateFields';
import type { MentionResolver } from '../components/discord/DiscordMarkdown';
import { PageHeader } from '../components/PageHeader';
import { SaveBar } from '../components/SaveBar';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { ErrorState } from '../components/ui/ErrorState';
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
import { roleColorHex } from '../lib/format';
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
  variableDescription,
  TEMPLATE_TYPES,
  type TemplateDraft,
  type TemplateTextField,
  type TemplateType,
} from '../lib/templates';
import { toast } from '../lib/toast';
import { t } from '../i18n';

type Drafts = Record<TemplateType, TemplateDraft>;

function draftsFrom(templates: Templates): Drafts {
  return { live: draftFromSpec(templates.live), summary: draftFromSpec(templates.summary), content: draftFromSpec(templates.content) };
}

export default function TemplatesPage() {
  const { guildId } = useGuild();
  const settings = useSettings(guildId);
  return (
    <div className="space-y-6">
      <PageHeader title={t('nav.templates')} icon={<MessageSquareText className="size-5" />} description={t('tpl.desc')} />
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
        toast.error(t('tpl.tooLong'));
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
            toast.success(dirtyTypes.length > 1 ? t('tpl.savedMany') : t('tpl.savedOne'));
            resolve(true);
          },
          onError: (error) => {
            toast.error(isApiError(error) ? error.message : t('tpl.saveFailed'));
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
      title: t('tpl.resetTitle', { name: TEMPLATE_TYPE_LABELS[tab].label }),
      description: t('tpl.resetDesc'),
      confirmLabel: t('tpl.resetConfirm'),
    });
    if (ok) setDrafts((d) => ({ ...d, [tab]: draftFromSpec(undefined) }));
  };

  const sendTest = async (): Promise<void> => {
    if (!sameDraft(drafts[tab], bases[tab])) {
      const ok = await confirmDialog({
        title: t('tpl.saveFirstTitle'),
        description: t('tpl.saveFirstDesc'),
        confirmLabel: t('tpl.saveAndSend'),
      });
      if (!ok || !(await save())) return;
    }
    testMessage.mutate(tab, {
      onSuccess: (result) =>
        toast.success(t('tpl.testSent'), {
          description: tab === 'content' ? t('tpl.inContentChannel') : t('tpl.inLiveChannel'),
          action: result.messageUrl ? { label: t('tpl.openMessage'), href: result.messageUrl } : undefined,
        }),
    });
  };

  const variables = TEMPLATE_VARIABLES[tab];

  return (
    <>
      <Tabs<TemplateType>
        value={tab}
        onChange={setTab}
        items={TEMPLATE_TYPES.map((type) => ({
          value: type,
          label: TEMPLATE_TYPE_LABELS[type].label,
          badge: !sameDraft(drafts[type], bases[type]) ? (
            <span className="size-1.5 rounded-full bg-amber-400" aria-label={t('tpl.hasChanges')} />
          ) : !isDefaultDraft(bases[type]) ? (
            <Badge tone="violet" size="sm">
              {t('tpl.custom')}
            </Badge>
          ) : undefined,
        }))}
      />

      {externalChange && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl bg-sky-500/[0.07] p-4 ring-1 ring-inset ring-sky-500/20">
          <RefreshCw className="size-4 text-sky-300" />
          <p className="flex-1 text-[13px] text-sky-100/90">{t('tpl.changedElsewhere')}</p>
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
            {t('settings.loadNew')}
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
                {t('tpl.default')}
              </Button>
            }
          />
          <CardBody className="space-y-5">
            <div className="rounded-xl bg-white/[0.02] p-3 ring-1 ring-inset ring-white/[0.05]">
              <p className="mb-2 flex items-center gap-1.5 text-xs text-zinc-400">
                <Braces className="size-3.5" />
                {t('tpl.variablesHint')}
                <span className="font-medium text-violet-300">{TEMPLATE_FIELD_LABELS[activeField].label}</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {variables.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    title={variableDescription(tab, v)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertVariable(v.key)}
                    className="group inline-flex h-7 items-center gap-1.5 rounded-lg bg-violet-500/10 px-2 text-xs ring-1 ring-inset ring-violet-400/20 transition-colors hover:bg-violet-500/20"
                  >
                    <code dir="ltr" className="font-mono text-violet-200">{`{${v.key}}`}</code>
                    <span className="hidden text-zinc-400 group-hover:text-zinc-300 sm:inline">{variableDescription(tab, v)}</span>
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
        saveLabel={dirtyTypes.length > 1 ? t('tpl.saveMany') : t('tpl.saveOne')}
      />
    </>
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
      user: (id) => (id === me.bot?.id ? t('tpl.sampleStreamer') : null),
    };
  }, [lookups.data, me.bot?.id]);

  const updating = preview.isFetching || spec !== debounced;

  return (
    <Card className="xl:sticky xl:top-24">
      <CardHeader
        icon={<Eye className="size-[18px]" />}
        title={t('tpl.preview')}
        description={t('tpl.previewDesc')}
        actions={
          <>
            {updating && <Loader2 className="size-4 animate-spin text-zinc-500" aria-label={t('common.updating')} />}
            <Button size="sm" variant="primary" onClick={onTest} loading={testing} icon={<Send className="size-3.5" />}>
              {t('tpl.sendTest')}
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
          <ErrorState compact error={preview.error} onRetry={() => void preview.refetch()} retrying={preview.isFetching} title={t('tpl.previewFailed')} />
        ) : (
          <Skeleton className="h-72 rounded-xl" />
        )}
        {preview.isError && preview.data && <p className="mt-2 text-xs text-amber-300/90">{t('tpl.previewStale')}</p>}
      </CardBody>
    </Card>
  );
}
