import { CircleAlert, CircleCheck, ExternalLink, Image as ImageIcon, Link2, Loader2, Send, Settings, Upload, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { isApiError } from '../api/client';
import { useInspectManualPost, useManualPost, useSettings, useStreamers } from '../api/queries';
import type { ContentKind, ManualPostPreviewDto } from '../api/types';
import { PageHeader } from '../components/PageHeader';
import { PlatformIcon } from '../components/PlatformIcon';
import { Badge } from '../components/ui/Badge';
import { Button, buttonClasses } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Field } from '../components/ui/Field';
import { Input, fieldClasses } from '../components/ui/Input';
import { Skeleton } from '../components/ui/Skeleton';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useGuild } from '../hooks/useGuild';
import { confirmDialog } from '../lib/confirm';
import { CONTENT_KIND_LABELS, PLATFORM_META } from '../lib/platforms';
import { toast } from '../lib/toast';
import { t } from '../i18n';

/** Looks like an http(s) URL worth sending to the inspect endpoint. */
export function looksLikeUrl(value: string): boolean {
  return /^https?:\/\/\S+\.\S+/i.test(value.trim());
}

export default function ManualPostPage() {
  const { guildId, basePath } = useGuild();
  const settings = useSettings(guildId);
  const enabled = settings.data?.features?.manualPosts?.enabled ?? false;

  return (
    <div className="space-y-6">
      <PageHeader title={t('manual.title')} icon={<Upload className="size-5" />} description={t('manual.desc')} />
      {!settings.data ? (
        settings.isError ? (
          <Card>
            <ErrorState error={settings.error} onRetry={() => void settings.refetch()} retrying={settings.isFetching} />
          </Card>
        ) : (
          <Skeleton className="h-72 rounded-2xl" />
        )
      ) : !enabled ? (
        <Card>
          <EmptyState
            icon={<Upload className="size-6" />}
            title={t('manual.disabled')}
            description={t('manual.disabledDesc')}
            action={
              <Link to={`${basePath}/settings#manual`} className={buttonClasses('primary', 'sm')}>
                <Settings className="size-3.5" />
                {t('manual.openSettings')}
              </Link>
            }
          />
        </Card>
      ) : (
        <ManualPostForm />
      )}
    </div>
  );
}

function ManualPostForm() {
  const { guildId } = useGuild();
  const [url, setUrl] = useState('');
  const debounced = useDebouncedValue(url.trim(), 600);
  const inspect = useInspectManualPost(guildId, debounced);
  const streamers = useStreamers(guildId);
  const post = useManualPost(guildId);
  const [title, setTitle] = useState('');
  const [thumbnail, setThumbnail] = useState('');
  const [streamerId, setStreamerId] = useState<string>('');
  const [kind, setKind] = useState<ContentKind | ''>('');
  const [error, setError] = useState<string | null>(null);

  const trimmed = url.trim();
  const typing = trimmed !== debounced;
  const preview = inspect.data && debounced === trimmed ? inspect.data : null;
  const invalidUrl = trimmed.length > 0 && !looksLikeUrl(trimmed) && !typing;

  const reset = (): void => {
    setUrl('');
    setTitle('');
    setThumbnail('');
    setStreamerId('');
    setKind('');
    setError(null);
  };

  const submit = async (): Promise<void> => {
    if (!preview || post.isPending) return;
    if (preview.alreadyPosted) {
      const ok = await confirmDialog({ title: t('manual.alreadyTitle'), description: t('manual.alreadyDesc'), confirmLabel: t('manual.postAnyway') });
      if (!ok) return;
    }
    const thumb = thumbnail.trim();
    if (thumb && !looksLikeUrl(thumb)) {
      setError(t('manual.badThumb'));
      return;
    }
    setError(null);
    post.mutate(
      {
        url: preview.url,
        title: title.trim() || null,
        thumbnailUrl: thumb || null,
        streamerId: streamerId ? Number(streamerId) : null,
        kind: kind || null,
      },
      {
        onSuccess: (result) => {
          toast.success(t('manual.posted'), { action: result.messageUrl ? { label: t('tpl.openMessage'), href: result.messageUrl } : undefined });
          reset();
        },
        onError: (e) => setError(isApiError(e) ? e.message : t('manual.failed')),
      },
    );
  };

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader icon={<Link2 className="size-[18px]" />} title={t('manual.step1')} description={t('manual.step1Desc')} />
        <CardBody className="space-y-5">
          <Field label={t('manual.url')} htmlFor="manual-url" hint={t('manual.urlHint')} error={invalidUrl ? t('manual.invalidUrl') : null}>
            <Input
              id="manual-url"
              data-autofocus
              dir="ltr"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              maxLength={500}
              placeholder="https://kick.com/…/clips/…"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
              invalid={invalidUrl || (inspect.isError && !typing)}
              trailing={inspect.isFetching || typing ? <Loader2 className="size-4 animate-spin text-zinc-500" /> : undefined}
            />
          </Field>
          {inspect.isError && !typing && looksLikeUrl(trimmed) && (
            <p className="flex items-start gap-1.5 text-[13px] text-rose-300" role="alert">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              {isApiError(inspect.error) ? inspect.error.message : t('manual.inspectFailed')}
            </p>
          )}

          {preview && (
            <>
              <div className="grid gap-5 md:grid-cols-2">
                <Field label={t('manual.titleOverride')} htmlFor="manual-title" hint={t('manual.optional')}>
                  <Input id="manual-title" dir="auto" maxLength={256} placeholder={preview.title ?? t('manual.titlePlaceholder')} value={title} onChange={(e) => setTitle(e.target.value)} />
                </Field>
                <Field label={t('manual.thumbOverride')} htmlFor="manual-thumb" hint={t('manual.optional')}>
                  <Input id="manual-thumb" dir="ltr" maxLength={500} placeholder="https://…" value={thumbnail} onChange={(e) => setThumbnail(e.target.value)} />
                </Field>
                <Field label={t('manual.streamer')} htmlFor="manual-streamer" hint={preview.streamer ? t('manual.streamerMatched', { name: preview.streamer.displayName }) : t('manual.streamerNone')}>
                  <select id="manual-streamer" className={fieldClasses(false, 'h-10 w-full px-3')} value={streamerId} onChange={(e) => setStreamerId(e.target.value)}>
                    <option value="">{preview.streamer ? t('manual.streamerAuto', { name: preview.streamer.displayName }) : t('manual.streamerUnset')}</option>
                    {(streamers.data ?? []).map((s) => (
                      <option key={s.id} value={String(s.id)}>
                        {s.displayName}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('manual.kind')} htmlFor="manual-kind">
                  <select id="manual-kind" className={fieldClasses(false, 'h-10 w-full px-3')} value={kind} onChange={(e) => setKind(e.target.value as ContentKind | '')}>
                    <option value="">{t('manual.kindAuto', { kind: CONTENT_KIND_LABELS[preview.kind] })}</option>
                    {PLATFORM_META[preview.platform].contentKinds.map((k) => (
                      <option key={k} value={k}>
                        {CONTENT_KIND_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              {error && (
                <p className="flex items-start gap-1.5 text-[13px] text-rose-300" role="alert">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" />
                  {error}
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={reset} disabled={post.isPending}>
                  {t('manual.clear')}
                </Button>
                <Button variant="primary" onClick={() => void submit()} loading={post.isPending} icon={<Send className="size-4" />}>
                  {t('manual.post')}
                </Button>
              </div>
            </>
          )}
        </CardBody>
      </Card>

      <Card className="xl:sticky xl:top-24">
        <CardHeader icon={<ImageIcon className="size-[18px]" />} title={t('manual.preview')} />
        <CardBody>
          {preview ? (
            <PreviewCard preview={preview} title={title} thumbnail={thumbnail} />
          ) : inspect.isFetching ? (
            <Skeleton className="h-56 rounded-xl" />
          ) : (
            <p className="py-10 text-center text-[13px] text-zinc-500">{t('manual.previewEmpty')}</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function PreviewCard({ preview, title, thumbnail }: { preview: ManualPostPreviewDto; title: string; thumbnail: string }) {
  const meta = PLATFORM_META[preview.platform];
  const thumb = looksLikeUrl(thumbnail) ? thumbnail.trim() : preview.thumbnailUrl;
  const shownTitle = title.trim() || preview.title || t('common.untitled');
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl bg-white/[0.03] ring-1 ring-inset ring-white/[0.06]">
        {thumb ? (
          <img src={thumb} alt="" referrerPolicy="no-referrer" className="aspect-video w-full object-cover" />
        ) : (
          <div className="grid aspect-video place-items-center text-zinc-600">
            <ImageIcon className="size-8" />
          </div>
        )}
        <div className="space-y-2 p-3.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge>
              <PlatformIcon platform={preview.platform} className="size-3.5" />
              {meta.label}
            </Badge>
            <Badge tone="violet">{CONTENT_KIND_LABELS[preview.kind]}</Badge>
            {preview.alreadyPosted ? (
              <Badge tone="warning">{t('manual.alreadyBadge')}</Badge>
            ) : (
              <Badge tone="success">
                <CircleCheck className="size-3" />
                {t('manual.newBadge')}
              </Badge>
            )}
          </div>
          <p className="text-[14px] font-medium text-zinc-100" dir="auto">
            {shownTitle}
          </p>
          <p className="flex items-center gap-1.5 text-xs text-zinc-400">
            <UserRound className="size-3.5" />
            {preview.streamer ? preview.streamer.displayName : t('manual.noStreamer')}
          </p>
          <a href={preview.url} target="_blank" rel="noopener noreferrer" dir="ltr" className="flex items-center gap-1 truncate text-xs text-zinc-500 hover:text-zinc-300">
            <ExternalLink className="size-3 shrink-0" />
            <span className="truncate">{preview.url}</span>
          </a>
        </div>
      </div>
      {preview.alreadyPosted && <p className="text-xs text-amber-300/90">{t('manual.alreadyDesc')}</p>}
    </div>
  );
}
