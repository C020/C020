import { Braces, Eye, Loader2, RotateCcw } from 'lucide-react';
import { useRef, useState } from 'react';
import { TEMPLATE_VARIABLES } from '../../../../src/shared/api';
import { isApiError } from '../../api/client';
import { usePreview, useUpdateStreamer } from '../../api/queries';
import type { StreamerDto, TemplateSpec, Templates } from '../../api/types';
import { DiscordMessage } from '../../components/discord/DiscordMessage';
import { ColorField, TemplateTextInput } from '../../components/templates/TemplateFields';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ErrorState } from '../../components/ui/ErrorState';
import { Segmented } from '../../components/ui/Segmented';
import { Skeleton } from '../../components/ui/Skeleton';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useGuild } from '../../hooks/useGuild';
import { useSession } from '../../hooks/useSession';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { cn } from '../../lib/cn';
import { overrideDrafts, overridesFromDrafts, sameOverrideDrafts, type OverrideDrafts } from '../../lib/streamerTemplates';
import {
  draftFromSpec,
  insertAtCursor,
  isDefaultDraft,
  specFromDraft,
  TEMPLATE_LIMITS,
  TEMPLATE_TYPE_LABELS,
  TEMPLATE_TYPES,
  variableDescription,
  type TemplateTextField,
  type TemplateType,
} from '../../lib/templates';
import { toast } from '../../lib/toast';
import { t } from '../../i18n';

/** #5 — per-streamer color + template overrides with a live Discord preview. */
export function StreamerMessages({ streamer }: { streamer: StreamerDto }) {
  const { guildId } = useGuild();
  const update = useUpdateStreamer(guildId);
  const [type, setType] = useState<TemplateType>('live');
  const [base, setBase] = useState<OverrideDrafts>(() => overrideDrafts(streamer.templates));
  const [drafts, setDrafts] = useState<OverrideDrafts>(() => overrideDrafts(streamer.templates));
  const [color, setColor] = useState<number | null>(streamer.color);
  const [activeField, setActiveField] = useState<TemplateTextField>('description');
  const refs = useRef<Partial<Record<TemplateTextField, HTMLInputElement | HTMLTextAreaElement | null>>>({});

  const colorDirty = color !== streamer.color;
  const templatesDirty = !sameOverrideDrafts(drafts, base);
  const dirty = colorDirty || templatesDirty;
  const draft = drafts[type];
  const overLimit = TEMPLATE_TYPES.some((ty) => (Object.keys(TEMPLATE_LIMITS) as TemplateTextField[]).some((f) => [...drafts[ty][f]].length > TEMPLATE_LIMITS[f]));
  useUnsavedChangesGuard(dirty);

  const setField = (field: TemplateTextField, value: string): void => setDrafts((d) => ({ ...d, [type]: { ...d[type], [field]: value } }));

  const insertVariable = (key: string): void => {
    const el = refs.current[activeField];
    const { text, caret } = insertAtCursor(draft[activeField], el?.selectionStart ?? null, el?.selectionEnd ?? null, `{${key}}`);
    setField(activeField, text);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  const save = (): void => {
    if (!dirty || update.isPending) return;
    if (overLimit) {
      toast.error(t('tpl.tooLong'));
      return;
    }
    const body: { color?: number | null; templates?: Templates } = {};
    if (colorDirty) body.color = color;
    if (templatesDirty) body.templates = overridesFromDrafts(drafts);
    update.mutate(
      { id: streamer.id, body },
      {
        onSuccess: (next) => {
          const fresh = overrideDrafts(next.templates);
          setBase(fresh);
          setDrafts(fresh);
          setColor(next.color);
          toast.success(t('custom.saved'));
        },
        onError: (e) => toast.error(isApiError(e) ? e.message : t('tpl.saveFailed')),
      },
    );
  };

  const discard = (): void => {
    setDrafts(base);
    setColor(streamer.color);
  };

  return (
    <div className="space-y-5">
      <ColorField value={color} onChange={setColor} label={t('custom.color')} hint={t('custom.colorHint')} inheritLabel={t('custom.colorInherit')} />

      <div className="space-y-3 border-t border-white/[0.06] pt-5">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">{t('custom.title')}</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{t('custom.desc')}</p>
        </div>
        <Segmented<TemplateType>
          size="sm"
          value={type}
          onChange={setType}
          ariaLabel={t('custom.type')}
          options={TEMPLATE_TYPES.map((ty) => ({
            value: ty,
            label: (
              <span className="inline-flex items-center gap-1.5">
                {TEMPLATE_TYPE_LABELS[ty].label}
                {!isDefaultDraft(drafts[ty]) && <span className="size-1.5 rounded-full bg-violet-400" aria-label={t('tpl.custom')} />}
              </span>
            ),
          }))}
        />
        <div className="flex items-center justify-between gap-2">
          {isDefaultDraft(draft) ? <Badge size="sm">{t('custom.inheriting')}</Badge> : <Badge tone="violet" size="sm">{t('tpl.custom')}</Badge>}
          <Button size="xs" variant="ghost" icon={<RotateCcw className="size-3.5" />} disabled={isDefaultDraft(draft)} onClick={() => setDrafts((d) => ({ ...d, [type]: draftFromSpec(undefined) }))}>
            {t('custom.clearType')}
          </Button>
        </div>

        <div className="rounded-xl bg-white/[0.02] p-3 ring-1 ring-inset ring-white/[0.05]">
          <p className="mb-2 flex items-center gap-1.5 text-xs text-zinc-400">
            <Braces className="size-3.5" />
            {t('tpl.variablesHint')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {TEMPLATE_VARIABLES[type].map((v) => (
              <button
                key={v.key}
                type="button"
                title={variableDescription(type, v)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertVariable(v.key)}
                className="inline-flex h-7 items-center rounded-lg bg-violet-500/10 px-2 text-xs ring-1 ring-inset ring-violet-400/20 hover:bg-violet-500/20"
              >
                <code dir="ltr" className="font-mono text-violet-200">{`{${v.key}}`}</code>
              </button>
            ))}
          </div>
        </div>

        {(['content', 'title', 'description', 'footer'] as const).map((field) => (
          <TemplateTextInput
            key={`${type}-${field}`}
            field={field}
            value={draft[field]}
            placeholder=""
            variables={TEMPLATE_VARIABLES[type]}
            active={activeField === field}
            onFocus={() => setActiveField(field)}
            onChange={(v) => setField(field, v)}
            inputRef={(el) => {
              refs.current[field] = el;
            }}
            emptyPlaceholder={t('custom.inheritPlaceholder')}
          />
        ))}
        <ColorField
          value={draft.color}
          onChange={(c) => setDrafts((d) => ({ ...d, [type]: { ...d[type], color: c } }))}
          label={t('custom.embedColor')}
          hint={t('custom.embedColorHint')}
          inheritLabel={t('custom.colorInherit')}
        />
      </div>

      <StreamerPreview streamerId={streamer.id} type={type} spec={specFromDraft(draft)} />

      {dirty && (
        <div className="sticky bottom-0 -mx-5 flex flex-wrap items-center justify-end gap-2 border-t border-white/[0.08] bg-zinc-900/95 px-5 py-3 backdrop-blur">
          <span className="me-auto text-xs text-amber-300/90">{t('custom.unsaved')}</span>
          <Button size="sm" variant="ghost" onClick={discard} disabled={update.isPending}>
            {t('save.undo')}
          </Button>
          <Button size="sm" variant="primary" onClick={save} loading={update.isPending} disabled={overLimit}>
            {t('common.save')}
          </Button>
        </div>
      )}
    </div>
  );
}

function StreamerPreview({ streamerId, type, spec }: { streamerId: number; type: TemplateType; spec: TemplateSpec }) {
  const { guildId } = useGuild();
  const me = useSession();
  const debounced = useDebouncedValue(spec, 450);
  const preview = usePreview(guildId, type, debounced, streamerId);
  const updating = preview.isFetching || JSON.stringify(spec) !== JSON.stringify(debounced);
  return (
    <section className="space-y-2 border-t border-white/[0.06] pt-5">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
        <Eye className="size-4 text-zinc-400" />
        {t('tpl.preview')}
        {updating && <Loader2 className="size-3.5 animate-spin text-zinc-500" aria-label={t('common.updating')} />}
      </h3>
      {preview.data ? (
        <div className={cn('transition-opacity', preview.isPlaceholderData && 'opacity-70')}>
          <DiscordMessage message={preview.data} author={{ name: me.bot?.username ?? 'Stream Bot', avatarUrl: me.bot?.avatarUrl ?? null, id: me.bot?.id }} />
        </div>
      ) : preview.isError ? (
        <ErrorState compact error={preview.error} onRetry={() => void preview.refetch()} retrying={preview.isFetching} title={t('tpl.previewFailed')} />
      ) : (
        <Skeleton className="h-56 rounded-xl" />
      )}
    </section>
  );
}
