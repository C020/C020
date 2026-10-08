/**
 * Settings sections for the v2 optional features. Each section edits `draft.features` (saved together with the rest
 * of the settings as a deep partial); actions that post to Discord (panels, digest) use the SAVED settings, so they
 * ask to save first while there are unsaved changes.
 */
import { BellRing, CircleCheck, CircleX, ClipboardList, Clapperboard, Gauge, Globe, Link2, MonitorPlay, Route, Send, TriangleAlert, Upload, Volume2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useOverview, usePostDigestNow, usePostPanel } from '../../api/queries';
import type { ContentKind, DiscordChannel, DiscordRole, FeatureLanguage, GuildFeatures, PanelKind, Platform } from '../../api/types';
import { ChannelPicker, RolePicker } from '../../components/EntityPicker';
import { PlatformIcon } from '../../components/PlatformIcon';
import { Badge } from '../../components/ui/Badge';
import { Button, buttonClasses } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Field } from '../../components/ui/Field';
import { Input, Textarea, fieldClasses } from '../../components/ui/Input';
import { NumberField } from '../../components/ui/NumberField';
import { Segmented } from '../../components/ui/Segmented';
import { SwitchRow } from '../../components/ui/Switch';
import { useGuild } from '../../hooks/useGuild';
import { useSession } from '../../hooks/useSession';
import { COMMON_TIMEZONES, counterPreview, FEATURE_LIMITS, formatHourOfDay, setRoute } from '../../lib/features';
import { CONTENT_KIND_LABELS, CONTENT_KINDS, PLATFORM_META, PLATFORMS } from '../../lib/platforms';
import { toast } from '../../lib/toast';
import { t, useI18n } from '../../i18n';

export interface FeatureSectionsProps {
  features: GuildFeatures;
  saved: GuildFeatures;
  onChange: (update: (f: GuildFeatures) => GuildFeatures) => void;
  fieldError: (field: string) => string | null;
  roles: DiscordRole[] | undefined;
  channels: DiscordChannel[] | undefined;
  loading: boolean;
  unavailable: boolean;
  /** Unsaved changes exist (Discord actions use the saved settings). */
  dirty: boolean;
}

type Patch<K extends keyof GuildFeatures> = Partial<GuildFeatures[K]>;

export function FeatureSections(props: FeatureSectionsProps) {
  const { features, onChange } = props;
  const set = <K extends 'notifyRole' | 'routing' | 'clips' | 'counter' | 'applications' | 'silent' | 'linking' | 'manualPosts' | 'presence'>(key: K, patch: Patch<K>): void =>
    onChange((f) => ({ ...f, [key]: { ...f[key], ...patch } }));
  const common = { ...props, set, features };
  return (
    <>
      <NotifyRoleSection {...common} />
      <RoutingSection {...common} />
      <ClipsSection {...common} />
      <CounterSection {...common} />
      <ApplicationsSection {...common} />
      <SilentSection {...common} />
      <PresenceSection {...common} />
      <LinkingSection {...common} />
      <ManualPostsSection {...common} />
      <LanguageSection {...common} />
    </>
  );
}

type SectionProps = FeatureSectionsProps & {
  set: <K extends 'notifyRole' | 'routing' | 'clips' | 'counter' | 'applications' | 'silent' | 'linking' | 'manualPosts' | 'presence'>(key: K, patch: Patch<K>) => void;
};

export function Section({ id, icon, title, description, actions, badge, children }: { id: string; icon: ReactNode; title: string; description?: string; actions?: ReactNode; badge?: ReactNode; children: ReactNode }) {
  return (
    <Card id={id} className="scroll-mt-24">
      <CardHeader
        icon={icon}
        title={
          badge ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              {title}
              {badge}
            </span>
          ) : (
            title
          )
        }
        description={description}
        actions={actions}
      />
      <CardBody>{children}</CardBody>
    </Card>
  );
}

function OnBadge({ on }: { on: boolean }) {
  return on ? (
    <Badge tone="success" size="sm">
      {t('settings.on')}
    </Badge>
  ) : (
    <Badge size="sm">{t('settings.off')}</Badge>
  );
}

function Notice({ tone, children }: { tone: 'warn' | 'info'; children: ReactNode }) {
  return (
    <p
      className={
        tone === 'warn'
          ? 'flex items-start gap-2 rounded-xl bg-amber-500/[0.07] p-3 text-[13px] leading-relaxed text-amber-100/90 ring-1 ring-inset ring-amber-500/20'
          : 'flex items-start gap-2 rounded-xl bg-sky-500/[0.06] p-3 text-[13px] leading-relaxed text-sky-100/90 ring-1 ring-inset ring-sky-500/20'
      }
    >
      <TriangleAlert className={tone === 'warn' ? 'mt-0.5 size-4 shrink-0 text-amber-300' : 'mt-0.5 size-4 shrink-0 text-sky-300'} />
      <span>{children}</span>
    </p>
  );
}

/** "Post / refresh panel" — uses the saved settings, so it is blocked while editing. */
function PanelButton({ kind, ready, dirty, notReadyHint }: { kind: PanelKind; ready: boolean; dirty: boolean; notReadyHint: string }) {
  const { guildId } = useGuild();
  const post = usePostPanel(guildId);
  const title = dirty ? t('settings.saveFirst') : !ready ? notReadyHint : undefined;
  return (
    <Button
      size="sm"
      variant="secondary"
      icon={<Send className="size-3.5" />}
      loading={post.isPending}
      disabled={dirty || !ready}
      title={title}
      onClick={() =>
        post.mutate(kind, {
          onSuccess: (r) => toast.success(t('features.panelPosted'), { action: r.messageUrl ? { label: t('tpl.openMessage'), href: r.messageUrl } : undefined }),
        })
      }
    >
      {t('features.postPanel')}
    </Button>
  );
}

const pickerProps = (p: FeatureSectionsProps) => ({ loading: p.loading, unavailable: p.unavailable });

// ───────────── #1 notify role ─────────────

function NotifyRoleSection(p: SectionProps) {
  const { guildId } = useGuild();
  const f = p.features.notifyRole;
  const savedReady = !!p.saved.notifyRole.roleId && !!p.saved.notifyRole.panelChannelId;
  return (
    <Section
      id="notify"
      icon={<BellRing className="size-[18px]" />}
      title={t('features.notify.title')}
      description={t('features.notify.desc')}
      badge={<OnBadge on={!!f.roleId} />}
      actions={<PanelButton kind="notify" ready={savedReady} dirty={p.dirty} notReadyHint={t('features.notify.panelNotReady')} />}
    >
      <div className="grid gap-5 md:grid-cols-2">
        <Field label={t('features.notify.role')} htmlFor="field-features.notifyRole.roleId" hint={t('features.notify.roleHint')} error={p.fieldError('features.notifyRole.roleId')}>
          <RolePicker
            id="field-features.notifyRole.roleId"
            guildId={guildId}
            purpose="assign"
            roles={p.roles}
            value={f.roleId ?? ''}
            onChange={(v) => p.set('notifyRole', { roleId: v || null })}
            invalid={!!p.fieldError('features.notifyRole.roleId')}
            {...pickerProps(p)}
          />
        </Field>
        <Field label={t('features.panelChannel')} htmlFor="field-features.notifyRole.panelChannelId" hint={t('features.notify.panelHint')} error={p.fieldError('features.notifyRole.panelChannelId')}>
          <ChannelPicker
            id="field-features.notifyRole.panelChannelId"
            channels={p.channels}
            value={f.panelChannelId ?? ''}
            onChange={(v) => p.set('notifyRole', { panelChannelId: v || null })}
            invalid={!!p.fieldError('features.notifyRole.panelChannelId')}
            {...pickerProps(p)}
          />
        </Field>
      </div>
      <div className="mt-4 divide-y divide-white/[0.05] border-t border-white/[0.05]">
        <SwitchRow title={t('features.notify.pingLive')} description={t('features.notify.pingLiveDesc')} checked={f.pingOnLive} onChange={(v) => p.set('notifyRole', { pingOnLive: v })} disabled={!f.roleId} />
        <SwitchRow title={t('features.notify.pingContent')} description={t('features.notify.pingContentDesc')} checked={f.pingOnContent} onChange={(v) => p.set('notifyRole', { pingOnContent: v })} disabled={!f.roleId} />
      </div>
      <PanelTexts feature="notifyRole" title={f.panelTitle} description={f.panelDescription} set={p.set} fieldError={p.fieldError} defaults={{ title: t('features.notify.defaultTitle'), description: t('features.notify.defaultDesc') }} />
    </Section>
  );
}

function PanelTexts({
  feature,
  title,
  description,
  set,
  fieldError,
  defaults,
}: {
  feature: 'notifyRole' | 'applications';
  title: string | null;
  description: string | null;
  set: SectionProps['set'];
  fieldError: (f: string) => string | null;
  defaults: { title: string; description: string };
}) {
  const titleId = `field-features.${feature}.panelTitle`;
  const descId = `field-features.${feature}.panelDescription`;
  return (
    <details className="group mt-4 rounded-xl bg-white/[0.02] ring-1 ring-inset ring-white/[0.05]">
      <summary className="cursor-pointer select-none px-3.5 py-3 text-[13px] font-medium text-zinc-300 hover:text-zinc-100">{t('features.panelTexts')}</summary>
      <div className="grid gap-4 px-3.5 pb-4">
        <Field label={t('features.panelTitle')} htmlFor={titleId} hint={t('features.optionalDefault')} error={fieldError(titleId.slice(6))} aside={`${[...(title ?? '')].length}/${FEATURE_LIMITS.panelTitle}`}>
          <Input id={titleId} dir="auto" maxLength={FEATURE_LIMITS.panelTitle} placeholder={defaults.title} value={title ?? ''} onChange={(e) => set(feature, { panelTitle: e.target.value || null })} />
        </Field>
        <Field label={t('features.panelDescription')} htmlFor={descId} hint={t('features.optionalDefault')} error={fieldError(descId.slice(6))} aside={`${[...(description ?? '')].length}/${FEATURE_LIMITS.panelDescription}`}>
          <Textarea id={descId} dir="auto" rows={3} maxLength={FEATURE_LIMITS.panelDescription} placeholder={defaults.description} value={description ?? ''} onChange={(e) => set(feature, { panelDescription: e.target.value || null })} />
        </Field>
      </div>
    </details>
  );
}

// ───────────── #4 routing ─────────────

function RoutingSection(p: SectionProps) {
  const r = p.features.routing;
  const routed = Object.keys(r.liveByPlatform).length + Object.keys(r.contentByPlatform).length + Object.keys(r.contentByKind).length;
  const picker = (map: 'liveByPlatform' | 'contentByPlatform' | 'contentByKind', key: Platform | ContentKind, label: ReactNode) => {
    const id = `field-features.routing.${map}.${key}`;
    const value = (r[map] as Partial<Record<string, string>>)[key] ?? '';
    return (
      <Field key={`${map}-${key}`} label={label} htmlFor={id} error={p.fieldError(id.slice(6))}>
        <ChannelPicker
          id={id}
          channels={p.channels}
          value={value}
          placeholder={t('features.routing.default')}
          onChange={(v) => p.set('routing', { [map]: setRoute(r[map] as Partial<Record<string, string>>, key, v) } as Patch<'routing'>)}
          invalid={!!p.fieldError(id.slice(6))}
          {...pickerProps(p)}
        />
      </Field>
    );
  };
  const platformLabel = (platform: Platform) => (
    <span className="inline-flex items-center gap-1.5">
      <PlatformIcon platform={platform} className="size-3.5" />
      {PLATFORM_META[platform].label}
    </span>
  );
  return (
    <Section
      id="routing"
      icon={<Route className="size-[18px]" />}
      title={t('features.routing.title')}
      description={t('features.routing.desc')}
      badge={routed > 0 ? <Badge tone="violet" size="sm">{t('features.routing.count', { count: routed })}</Badge> : undefined}
    >
      <div className="space-y-6">
        <div>
          <h4 className="mb-3 text-[13px] font-semibold text-zinc-300">{t('features.routing.live')}</h4>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{PLATFORMS.map((pl) => picker('liveByPlatform', pl, platformLabel(pl)))}</div>
        </div>
        <div className="border-t border-white/[0.05] pt-5">
          <h4 className="mb-3 text-[13px] font-semibold text-zinc-300">{t('features.routing.contentPlatform')}</h4>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{PLATFORMS.map((pl) => picker('contentByPlatform', pl, platformLabel(pl)))}</div>
        </div>
        <div className="border-t border-white/[0.05] pt-5">
          <h4 className="mb-1 text-[13px] font-semibold text-zinc-300">{t('features.routing.contentKind')}</h4>
          <p className="mb-3 text-xs text-zinc-500">{t('features.routing.kindWins')}</p>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{CONTENT_KINDS.map((k) => picker('contentByKind', k, CONTENT_KIND_LABELS[k]))}</div>
        </div>
      </div>
    </Section>
  );
}

// ───────────── #6 clips ─────────────

function ClipsSection(p: SectionProps) {
  const { guildId } = useGuild();
  const { lang } = useI18n();
  const c = p.features.clips;
  const digestNow = usePostDigestNow(guildId);
  const savedDigest = p.saved.clips.mode === 'digest';
  return (
    <Section
      id="clips"
      icon={<Clapperboard className="size-[18px]" />}
      title={t('features.clips.title')}
      description={t('features.clips.desc')}
      actions={
        c.mode === 'digest' ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<Send className="size-3.5" />}
            loading={digestNow.isPending}
            disabled={p.dirty || !savedDigest}
            title={p.dirty ? t('settings.saveFirst') : undefined}
            onClick={() =>
              digestNow.mutate(undefined, {
                onSuccess: (r) =>
                  r.messageUrl
                    ? toast.success(t('features.clips.digestPosted'), { action: { label: t('tpl.openMessage'), href: r.messageUrl } })
                    : toast.info(t('features.clips.digestEmpty')),
              })
            }
          >
            {t('features.clips.postNow')}
          </Button>
        ) : undefined
      }
    >
      <div className="grid gap-5 md:grid-cols-2">
        <Field label={t('features.clips.minViews')} htmlFor="field-features.clips.minViews" hint={t('features.clips.minViewsHint')} error={p.fieldError('features.clips.minViews')}>
          <NumberField
            id="field-features.clips.minViews"
            value={c.minViews}
            onChange={(v) => p.set('clips', { minViews: v })}
            {...FEATURE_LIMITS.minViews}
            step={10}
            suffix={t('features.clips.views')}
            invalid={!!p.fieldError('features.clips.minViews')}
          />
        </Field>
        <SwitchRow className="self-start" title={t('features.clips.featured')} description={t('features.clips.featuredDesc')} checked={c.featuredOnly} onChange={(v) => p.set('clips', { featuredOnly: v })} />
      </div>
      <div className="mt-5 space-y-4 border-t border-white/[0.05] pt-5">
        <Segmented<'each' | 'digest'>
          value={c.mode}
          onChange={(mode) => p.set('clips', { mode })}
          ariaLabel={t('features.clips.mode')}
          options={[
            { value: 'each', label: t('features.clips.each') },
            { value: 'digest', label: t('features.clips.digest') },
          ]}
        />
        <p className="text-xs text-zinc-500">{c.mode === 'each' ? t('features.clips.eachDesc') : t('features.clips.digestDesc')}</p>
        {c.mode === 'digest' && (
          <div className="grid gap-5 md:grid-cols-3">
            <Field label={t('features.clips.hour')} htmlFor="field-features.clips.digestHour" hint={t('features.clips.hourHint', { tz: p.features.timezone })} error={p.fieldError('features.clips.digestHour')}>
              <select id="field-features.clips.digestHour" className={fieldClasses(!!p.fieldError('features.clips.digestHour'), 'h-10 w-full px-3')} value={c.digestHour} onChange={(e) => p.set('clips', { digestHour: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {formatHourOfDay(h, lang)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('features.clips.max')} htmlFor="field-features.clips.digestMax" error={p.fieldError('features.clips.digestMax')}>
              <NumberField id="field-features.clips.digestMax" value={c.digestMax} onChange={(v) => p.set('clips', { digestMax: v })} {...FEATURE_LIMITS.digestMax} invalid={!!p.fieldError('features.clips.digestMax')} />
            </Field>
            <Field label={t('features.clips.digestChannel')} htmlFor="field-features.clips.digestChannelId" hint={t('features.clips.digestChannelHint')} error={p.fieldError('features.clips.digestChannelId')}>
              <ChannelPicker
                id="field-features.clips.digestChannelId"
                channels={p.channels}
                value={c.digestChannelId ?? ''}
                placeholder={t('features.routing.default')}
                onChange={(v) => p.set('clips', { digestChannelId: v || null })}
                invalid={!!p.fieldError('features.clips.digestChannelId')}
                {...pickerProps(p)}
              />
            </Field>
          </div>
        )}
      </div>
    </Section>
  );
}

// ───────────── #8 counter ─────────────

function CounterSection(p: SectionProps) {
  const { guildId } = useGuild();
  const overview = useOverview(guildId);
  const c = p.features.counter;
  const liveNow = overview.data?.counts.liveNow ?? 0;
  const err = p.fieldError('features.counter.template');
  return (
    <Section id="counter" icon={<Gauge className="size-[18px]" />} title={t('features.counter.title')} description={t('features.counter.desc')} badge={<OnBadge on={!!c.channelId} />}>
      <div className="grid gap-5 md:grid-cols-2">
        <Field label={t('features.counter.channel')} htmlFor="field-features.counter.channelId" hint={t('features.counter.channelHint')} error={p.fieldError('features.counter.channelId')}>
          <ChannelPicker
            id="field-features.counter.channelId"
            channels={p.channels}
            value={c.channelId ?? ''}
            onChange={(v) => p.set('counter', { channelId: v || null })}
            invalid={!!p.fieldError('features.counter.channelId')}
            {...pickerProps(p)}
          />
        </Field>
        <Field label={t('features.counter.template')} htmlFor="field-features.counter.template" hint={t('features.counter.templateHint')} error={err} aside={`${[...c.template].length}/${FEATURE_LIMITS.counterTemplate}`}>
          <Input id="field-features.counter.template" dir="auto" maxLength={FEATURE_LIMITS.counterTemplate + 10} value={c.template} onChange={(e) => p.set('counter', { template: e.target.value })} invalid={!!err} />
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl bg-white/[0.02] p-3 ring-1 ring-inset ring-white/[0.05]">
        <span className="text-xs text-zinc-500">{t('features.counter.preview')}</span>
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-discord-bg px-2.5 py-1 text-[13px] text-zinc-200" dir="auto">
          <Volume2 className="size-3.5 text-zinc-400" />
          {counterPreview(c.template, liveNow) || '—'}
        </span>
        <span className="ms-auto text-[11px] text-zinc-600">{t('features.counter.rateHint')}</span>
      </div>
    </Section>
  );
}

// ───────────── #9 applications ─────────────

function ApplicationsSection(p: SectionProps) {
  const { basePath } = useGuild();
  const a = p.features.applications;
  const savedReady = p.saved.applications.enabled && !!p.saved.applications.panelChannelId;
  return (
    <Section
      id="applications"
      icon={<ClipboardList className="size-[18px]" />}
      title={t('features.apps.title')}
      description={t('features.apps.desc')}
      badge={<OnBadge on={a.enabled} />}
      actions={
        <>
          <Link to={`${basePath}/applications`} className={buttonClasses('ghost', 'sm')}>
            {t('features.apps.open')}
          </Link>
          <PanelButton kind="apply" ready={savedReady} dirty={p.dirty} notReadyHint={t('features.apps.panelNotReady')} />
        </>
      }
    >
      <SwitchRow title={t('features.apps.enable')} description={t('features.apps.enableDesc')} checked={a.enabled} onChange={(v) => p.set('applications', { enabled: v })} />
      <div className="mt-2 grid gap-5 border-t border-white/[0.05] pt-4 md:grid-cols-2">
        <Field label={t('features.panelChannel')} htmlFor="field-features.applications.panelChannelId" hint={t('features.apps.panelHint')} error={p.fieldError('features.applications.panelChannelId')}>
          <ChannelPicker
            id="field-features.applications.panelChannelId"
            channels={p.channels}
            value={a.panelChannelId ?? ''}
            onChange={(v) => p.set('applications', { panelChannelId: v || null })}
            invalid={!!p.fieldError('features.applications.panelChannelId')}
            {...pickerProps(p)}
          />
        </Field>
        <Field label={t('features.apps.review')} htmlFor="field-features.applications.reviewChannelId" hint={t('features.apps.reviewHint')} error={p.fieldError('features.applications.reviewChannelId')}>
          <ChannelPicker
            id="field-features.applications.reviewChannelId"
            channels={p.channels}
            value={a.reviewChannelId ?? ''}
            onChange={(v) => p.set('applications', { reviewChannelId: v || null })}
            invalid={!!p.fieldError('features.applications.reviewChannelId')}
            {...pickerProps(p)}
          />
        </Field>
      </div>
      <div className="mt-2 border-t border-white/[0.05]">
        <SwitchRow title={t('features.apps.dm')} description={t('features.apps.dmDesc')} checked={a.dmApplicant} onChange={(v) => p.set('applications', { dmApplicant: v })} />
      </div>
      <PanelTexts feature="applications" title={a.panelTitle} description={a.panelDescription} set={p.set} fieldError={p.fieldError} defaults={{ title: t('features.apps.defaultTitle'), description: t('features.apps.defaultDesc') }} />
    </Section>
  );
}

// ───────────── #10 silent ─────────────

function SilentSection(p: SectionProps) {
  const s = p.features.silent;
  return (
    <Section id="silent" icon={<Volume2 className="size-[18px]" />} title={t('features.silent.title')} description={t('features.silent.desc')}>
      <div className="divide-y divide-white/[0.05]">
        <SwitchRow title={t('features.silent.live')} description={t('features.silent.liveDesc')} checked={s.live} onChange={(v) => p.set('silent', { live: v })} />
        <SwitchRow title={t('features.silent.content')} description={t('features.silent.contentDesc')} checked={s.content} onChange={(v) => p.set('silent', { content: v })} />
      </div>
    </Section>
  );
}

// ───────────── #15 presence ─────────────

function PresenceSection(p: SectionProps) {
  const me = useSession();
  const intent = me.capabilities?.presenceIntent ?? false;
  const pr = p.features.presence;
  return (
    <Section id="presence" icon={<MonitorPlay className="size-[18px]" />} title={t('features.presence.title')} description={t('features.presence.desc')} badge={<OnBadge on={pr.enabled && intent} />}>
      {!intent && <Notice tone="warn">{t('features.presence.noIntent')}</Notice>}
      <div className="divide-y divide-white/[0.05]">
        <SwitchRow title={t('features.presence.enable')} description={t('features.presence.enableDesc')} checked={pr.enabled} onChange={(v) => p.set('presence', { enabled: v })} disabled={!intent && !pr.enabled} />
        <div className="space-y-2 py-3">
          <p className="text-sm font-medium text-zinc-200">{t('features.presence.scope')}</p>
          <Segmented<'registered' | 'everyone'>
            size="sm"
            value={pr.scope}
            onChange={(scope) => p.set('presence', { scope })}
            ariaLabel={t('features.presence.scope')}
            options={[
              { value: 'registered', label: t('features.presence.registered') },
              { value: 'everyone', label: t('features.presence.everyone') },
            ]}
          />
          <p className="text-xs text-zinc-500">{pr.scope === 'registered' ? t('features.presence.registeredDesc') : t('features.presence.everyoneDesc')}</p>
        </div>
        <SwitchRow title={t('features.presence.notify')} description={t('features.presence.notifyDesc')} checked={pr.notify} onChange={(v) => p.set('presence', { notify: v })} />
      </div>
    </Section>
  );
}

// ───────────── #11 linking ─────────────

function LinkingSection(p: SectionProps) {
  const me = useSession();
  const linking = me.capabilities?.linking ?? { twitch: false, tiktok: false };
  const any = linking.twitch || linking.tiktok;
  const l = p.features.linking;
  return (
    <Section id="linking" icon={<Link2 className="size-[18px]" />} title={t('features.linking.title')} description={t('features.linking.desc')} badge={<OnBadge on={l.enabled && any} />}>
      <div className="mb-3 flex flex-wrap gap-2">
        {(['twitch', 'tiktok'] as const).map((platform) => (
          <span key={platform} className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-xs ring-1 ring-inset ring-white/[0.06]">
            <PlatformIcon platform={platform} className="size-3.5" />
            {PLATFORM_META[platform].label}
            {linking[platform] ? (
              <span className="inline-flex items-center gap-1 text-emerald-300">
                <CircleCheck className="size-3.5" />
                {t('features.linking.available')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-zinc-500">
                <CircleX className="size-3.5" />
                {t('features.linking.unavailable')}
              </span>
            )}
          </span>
        ))}
      </div>
      {!any && <Notice tone="info">{t('features.linking.noneAvailable')}</Notice>}
      <SwitchRow title={t('features.linking.enable')} description={t('features.linking.enableDesc')} checked={l.enabled} onChange={(v) => p.set('linking', { enabled: v })} disabled={!any && !l.enabled} />
    </Section>
  );
}

// ───────────── #14 manual posts ─────────────

function ManualPostsSection(p: SectionProps) {
  const { basePath } = useGuild();
  const m = p.features.manualPosts;
  return (
    <Section
      id="manual"
      icon={<Upload className="size-[18px]" />}
      title={t('features.manual.title')}
      description={t('features.manual.desc')}
      badge={<OnBadge on={m.enabled} />}
      actions={
        p.saved.manualPosts.enabled ? (
          <Link to={`${basePath}/manual-post`} className={buttonClasses('secondary', 'sm')}>
            {t('features.manual.open')}
          </Link>
        ) : undefined
      }
    >
      <SwitchRow title={t('features.manual.enable')} description={t('features.manual.enableDesc')} checked={m.enabled} onChange={(v) => p.set('manualPosts', { enabled: v })} />
    </Section>
  );
}

// ───────────── #16 language & timezone ─────────────

function LanguageSection(p: SectionProps) {
  const tz = p.features.timezone;
  const zones: string[] = COMMON_TIMEZONES.includes(tz as (typeof COMMON_TIMEZONES)[number]) ? [...COMMON_TIMEZONES] : [tz, ...COMMON_TIMEZONES];
  const err = p.fieldError('features.timezone');
  return (
    <Section id="language" icon={<Globe className="size-[18px]" />} title={t('features.lang.title')} description={t('features.lang.desc')}>
      <div className="grid gap-5 md:grid-cols-2">
        <Field label={t('features.lang.bot')} hint={t('features.lang.botHint')}>
          <Segmented<FeatureLanguage>
            value={p.features.language}
            onChange={(language) => p.onChange((f) => ({ ...f, language }))}
            ariaLabel={t('features.lang.bot')}
            options={[
              { value: 'ar', label: t('features.lang.ar') },
              { value: 'en', label: t('features.lang.en') },
            ]}
          />
        </Field>
        <Field label={t('features.lang.timezone')} htmlFor="field-features.timezone" hint={t('features.lang.timezoneHint', { now: nowIn(tz) })} error={err}>
          <select id="field-features.timezone" dir="ltr" className={fieldClasses(!!err, 'h-10 w-full px-3')} value={tz} onChange={(e) => p.onChange((f) => ({ ...f, timezone: e.target.value }))}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Section>
  );
}

function nowIn(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(Date.now());
  } catch {
    return '—';
  }
}
