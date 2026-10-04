import {
  AtSign,
  Bell,
  BellOff,
  Clapperboard,
  Hash,
  Layers,
  Radio,
  RefreshCw,
  Settings,
  Shield,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { isApiError } from '../api/client';
import { useDiscordLookups, useSettings, useSyncRoles, useUpdateSettings } from '../api/queries';
import type { ContentKind, GuildOptions, PingMode, Platform, SettingsDto } from '../api/types';
import { ChannelPicker, RolePicker } from '../components/EntityPicker';
import { PageHeader } from '../components/PageHeader';
import { SaveBar } from '../components/SaveBar';
import { PlatformTile } from '../components/PlatformIcon';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { ToggleChip } from '../components/ui/Chip';
import { ErrorState } from '../components/ui/ErrorState';
import { Field } from '../components/ui/Field';
import { NumberField } from '../components/ui/NumberField';
import { Segmented } from '../components/ui/Segmented';
import { Skeleton } from '../components/ui/Skeleton';
import { Switch, SwitchRow } from '../components/ui/Switch';
import { useGuild } from '../hooks/useGuild';
import { useModHotkey } from '../hooks/useHotkey';
import { useLatest } from '../hooks/useLatest';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard';
import { cn } from '../lib/cn';
import { CONTENT_KIND_HINTS, CONTENT_KIND_LABELS_AR, CONTENT_KINDS, PLATFORM_META, PLATFORMS } from '../lib/platforms';
import { diffSettings, draftFromSettings, hasChanges, OPTION_LIMITS, validateDraft, type SettingsDraft } from '../lib/settings';
import { toast } from '../lib/toast';

export default function SettingsPage() {
  const { guildId } = useGuild();
  const settings = useSettings(guildId);

  return (
    <div className="space-y-6">
      <PageHeader title="الإعدادات" icon={<Settings className="size-5" />} description="الرتب، الرومات، المنشن، المنصات وخيارات الإشعارات" />
      {settings.data ? (
        <SettingsForm saved={settings.data} />
      ) : settings.isError ? (
        <Card>
          <ErrorState error={settings.error} onRetry={() => void settings.refetch()} retrying={settings.isFetching} />
        </Card>
      ) : (
        <div className="space-y-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-48 rounded-2xl" />
          ))}
        </div>
      )}
    </div>
  );
}

function SettingsForm({ saved }: { saved: SettingsDto }) {
  const { guildId } = useGuild();
  const lookups = useDiscordLookups(guildId);
  const updateSettings = useUpdateSettings(guildId);
  const syncRoles = useSyncRoles(guildId);
  const location = useLocation();

  const [base, setBase] = useState(saved);
  const [draft, setDraft] = useState<SettingsDraft>(() => draftFromSettings(saved));
  const [serverError, setServerError] = useState<{ field?: string; message: string } | null>(null);
  const [staleBase, setStaleBase] = useState(false);

  const update = useMemo(() => diffSettings(base, draft), [base, draft]);
  const dirty = hasChanges(update);
  const errors = useMemo(() => validateDraft(draft, guildId), [draft, guildId]);
  const errorCount = Object.keys(errors).length;
  const changeCount = Object.keys(update).length + (update.options ? Object.keys(update.options).length - 1 : 0);

  // Settings changed elsewhere (another admin, slash command): adopt them unless the user is editing.
  const latest = useLatest({ base, draft, dirty });
  useEffect(() => {
    const { base: currentBase, draft: currentDraft, dirty: editing } = latest.current;
    if (saved === currentBase) return;
    if (!editing || !hasChanges(diffSettings(saved, currentDraft))) {
      setBase(saved);
      setDraft(draftFromSettings(saved));
      setStaleBase(false);
      return;
    }
    setStaleBase(true);
  }, [saved, latest]);

  useEffect(() => {
    const id = location.hash.slice(1);
    if (!id) return;
    const t = setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
    return () => clearTimeout(t);
  }, [location.hash]);

  useUnsavedChangesGuard(dirty);

  const set = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }));
    if (serverError?.field === key) setServerError(null);
  };
  const setOption = <K extends keyof GuildOptions>(key: K, value: GuildOptions[K]): void => {
    setDraft((d) => ({ ...d, options: { ...d.options, [key]: value } }));
    if (serverError?.field === `options.${key}`) setServerError(null);
  };

  const fieldError = (field: string): string | null => errors[field] ?? (serverError?.field === field ? serverError.message : null);

  const reset = (): void => {
    setBase(saved);
    setDraft(draftFromSettings(saved));
    setServerError(null);
    setStaleBase(false);
  };

  const save = (): void => {
    if (!dirty || updateSettings.isPending) return;
    if (errorCount > 0) {
      toast.error('فيه حقول تحتاج تصحيح قبل الحفظ');
      return;
    }
    setServerError(null);
    updateSettings.mutate(update, {
      onSuccess: (next) => {
        setBase(next);
        setDraft(draftFromSettings(next));
        setStaleBase(false);
        toast.success('تم حفظ الإعدادات');
      },
      onError: (error) => {
        const message = isApiError(error) ? error.message : 'ما قدرنا نحفظ الإعدادات';
        setServerError({ field: isApiError(error) ? error.field : undefined, message });
        toast.error(message);
        const field = isApiError(error) ? error.field : undefined;
        if (field) document.getElementById(`field-${field}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      },
    });
  };

  useModHotkey('s', save, dirty);

  const runSync = (): void => {
    syncRoles.mutate(undefined, {
      onSuccess: (result) =>
        toast.success('تمت مزامنة الرتب', {
          description: result.added + result.removed === 0 ? 'كل الرتب مضبوطة، ما احتجنا نغيّر شي' : `انعطت ${result.added} رتبة وانشالت ${result.removed}`,
        }),
    });
  };

  const roles = lookups.data?.roles;
  const channels = lookups.data?.channels;
  const lookupsUnavailable = lookups.isError;
  const pickerCommon = { loading: lookups.isPending, unavailable: lookupsUnavailable };

  return (
    <div className="space-y-5">
      {staleBase && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-sky-500/[0.07] p-4 ring-1 ring-inset ring-sky-500/20">
          <RefreshCw className="size-4 text-sky-300" />
          <p className="flex-1 text-[13px] text-sky-100/90">الإعدادات تغيّرت من مكان ثاني وأنت تعدّل. تقدر تكمل وتحفظ تعديلاتك، أو تحمّل النسخة الجديدة.</p>
          <Button size="sm" variant="secondary" onClick={reset}>
            تحميل النسخة الجديدة
          </Button>
        </div>
      )}

      {lookupsUnavailable && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-amber-500/[0.07] p-4 ring-1 ring-inset ring-amber-500/20">
          <TriangleAlert className="size-4 text-amber-300" />
          <p className="flex-1 text-[13px] text-amber-100/90">ما قدرنا نجيب الرتب والرومات من ديسكورد الحين. تقدر تلصق الآيدي مباشرة، أو تعيد المحاولة.</p>
          <Button size="sm" variant="secondary" onClick={() => void lookups.refetch()} loading={lookups.isFetching}>
            إعادة المحاولة
          </Button>
        </div>
      )}

      <Section
        id="roles"
        icon={<Shield className="size-[18px]" />}
        title="الرتب"
        description="تقدر تختار الرتبة من القائمة أو تلصق الآيدي حقها مباشرة. رتبة البوت لازم تكون فوق الرتبتين."
        actions={
          <Button size="sm" variant="secondary" onClick={runSync} loading={syncRoles.isPending} disabled={dirty} title={dirty ? 'احفظ التغييرات أول' : undefined} icon={<RefreshCw className="size-3.5" />}>
            مزامنة الرتب
          </Button>
        }
      >
        <div className="grid gap-5 md:grid-cols-2">
          <Field label="رتبة الستريمر (Streamer)" htmlFor="field-streamerRoleId" hint="تنعطى تلقائياً لكل ستريمر مسجّل." error={fieldError('streamerRoleId')}>
            <RolePicker
              id="field-streamerRoleId"
              guildId={guildId}
              purpose="assign"
              roles={roles}
              value={draft.streamerRoleId}
              onChange={(v) => set('streamerRoleId', v)}
              invalid={!!fieldError('streamerRoleId')}
              {...pickerCommon}
            />
          </Field>
          <Field label="رتبة يبث الحين (Streaming Now)" htmlFor="field-liveRoleId" hint="تنعطى وقت البث، وتنشال لما يخلص في كل المنصات." error={fieldError('liveRoleId')}>
            <RolePicker
              id="field-liveRoleId"
              guildId={guildId}
              purpose="assign"
              roles={roles}
              value={draft.liveRoleId}
              onChange={(v) => set('liveRoleId', v)}
              invalid={!!fieldError('liveRoleId')}
              {...pickerCommon}
            />
          </Field>
        </div>
        <div className="mt-4 divide-y divide-white/[0.05] border-t border-white/[0.05]">
          <SwitchRow
            title="إعطاء رتبة الستريمر تلقائياً"
            description="أول ما تضيف ستريمر ياخذ الرتبة، والبوت يتأكد منها دورياً."
            checked={draft.options.autoStreamerRole}
            onChange={(v) => setOption('autoStreamerRole', v)}
          />
          <SwitchRow
            title="سحب رتبة الستريمر عند الحذف"
            description="لما تحذف ستريمر من اللوحة تنشال منه رتبة Streamer."
            checked={draft.options.removeStreamerRoleOnDelete}
            onChange={(v) => setOption('removeStreamerRoleOnDelete', v)}
          />
        </div>
      </Section>

      <Section id="channels" icon={<Hash className="size-[18px]" />} title="الرومات" description="وين تنرسل الإشعارات. البوت يحتاج صلاحية View Channel و Send Messages و Embed Links، و Attach Files لصور تيك توك.">
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          <Field label="روم إشعارات البث" htmlFor="field-liveChannelId" hint="إشعار البث المباشر والملخص بعده." error={fieldError('liveChannelId')}>
            <ChannelPicker id="field-liveChannelId" channels={channels} value={draft.liveChannelId} onChange={(v) => set('liveChannelId', v)} invalid={!!fieldError('liveChannelId')} {...pickerCommon} />
          </Field>
          <Field label="روم إشعارات المقاطع" htmlFor="field-contentChannelId" hint="فيديوهات، شورتس، كليبات… (تقدر تخليه نفس روم البث)." error={fieldError('contentChannelId')}>
            <ChannelPicker
              id="field-contentChannelId"
              channels={channels}
              value={draft.contentChannelId}
              onChange={(v) => set('contentChannelId', v)}
              invalid={!!fieldError('contentChannelId')}
              {...pickerCommon}
            />
          </Field>
          <Field label="روم السجل (اختياري)" htmlFor="field-logChannelId" hint="الأخطاء والتنبيهات المهمة توصل هنا." error={fieldError('logChannelId')}>
            <ChannelPicker id="field-logChannelId" channels={channels} value={draft.logChannelId} onChange={(v) => set('logChannelId', v)} invalid={!!fieldError('logChannelId')} {...pickerCommon} />
          </Field>
        </div>
      </Section>

      <Section id="ping" icon={<AtSign className="size-[18px]" />} title="المنشن مع الإشعار" description="الافتراضي بدون منشن. المنشن ينضاف لإشعار البث والمقاطع، وما ينضاف للملخص ولا للتحديثات.">
        <Segmented<PingMode>
          value={draft.pingMode}
          onChange={(v) => set('pingMode', v)}
          ariaLabel="نوع المنشن"
          options={[
            { value: 'none', label: 'بدون منشن', icon: <BellOff className="size-3.5" /> },
            { value: 'everyone', label: '@everyone', icon: <Bell className="size-3.5" /> },
            { value: 'here', label: '@here', icon: <Bell className="size-3.5" /> },
            { value: 'role', label: 'رتبة معيّنة', icon: <Users className="size-3.5" /> },
          ]}
        />
        {(draft.pingMode === 'everyone' || draft.pingMode === 'here') && (
          <p className="mt-3 flex items-center gap-2 text-[13px] text-amber-300/90">
            <TriangleAlert className="size-4 shrink-0" />
            بينمنشن {draft.pingMode === 'everyone' ? 'كل أعضاء السيرفر' : 'كل المتصلين'} مع كل بث ومقطع. تأكد إن البوت عنده صلاحية Mention Everyone.
          </p>
        )}
        {draft.pingMode === 'role' && (
          <Field className="mt-4 max-w-md" label="الرتبة اللي تنمنشن" htmlFor="field-pingRoleId" error={fieldError('pingRoleId')} hint="لازم تكون الرتبة قابلة للمنشن أو البوت عنده Mention Everyone.">
            <RolePicker
              id="field-pingRoleId"
              guildId={guildId}
              purpose="mention"
              roles={roles}
              value={draft.pingRoleId}
              onChange={(v) => set('pingRoleId', v)}
              invalid={!!fieldError('pingRoleId')}
              {...pickerCommon}
            />
          </Field>
        )}
      </Section>

      <Section id="platforms" icon={<Layers className="size-[18px]" />} title="المنصات" description="المنصات المقفلة ما تنراقب في هذا السيرفر (حتى لو فيه حسابات مربوطة).">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {PLATFORMS.map((platform) => (
            <PlatformToggle
              key={platform}
              platform={platform}
              enabled={draft.platformsEnabled.includes(platform)}
              onChange={(on) => set('platformsEnabled', on ? PLATFORMS.filter((p) => p === platform || draft.platformsEnabled.includes(p)) : draft.platformsEnabled.filter((p) => p !== platform))}
            />
          ))}
        </div>
      </Section>

      <Section id="content" icon={<Clapperboard className="size-[18px]" />} title="إشعارات المقاطع" description="أنواع المحتوى اللي ينعلن عنها. تقدر تخصصها لكل حساب من صفحة الستريمرز.">
        <div className="flex flex-wrap gap-2">
          {CONTENT_KINDS.map((kind) => (
            <ToggleChip
              key={kind}
              selected={draft.contentKinds.includes(kind)}
              title={CONTENT_KIND_HINTS[kind]}
              onToggle={() => set('contentKinds', toggleKind(draft.contentKinds, kind))}
            >
              {CONTENT_KIND_LABELS_AR[kind]}
            </ToggleChip>
          ))}
        </div>
        {draft.contentKinds.length === 0 && <p className="mt-3 text-[13px] text-amber-300/90">كل الأنواع مقفلة، يعني ما راح تنرسل أي إشعارات مقاطع.</p>}
        <div className="mt-5 grid gap-5 border-t border-white/[0.05] pt-5 md:grid-cols-2">
          <Field label="أقصى عمر للمقطع" htmlFor="field-options.contentMaxAgeHours" error={fieldError('options.contentMaxAgeHours')} hint="أي مقطع أقدم من كذا ما ينعلن. يحميك من سبام المقاطع القديمة لما تضيف حساب جديد.">
            <NumberField
              id="field-options.contentMaxAgeHours"
              value={draft.options.contentMaxAgeHours}
              onChange={(v) => setOption('contentMaxAgeHours', v)}
              {...OPTION_LIMITS.contentMaxAgeHours}
              suffix="ساعة"
              invalid={!!fieldError('options.contentMaxAgeHours')}
            />
          </Field>
          <SwitchRow
            className="self-start"
            title="تجاهل تسجيل البث المعلن"
            description="إذا البث نفسه انعلن كلايف، ما نرسل إشعار ثاني لتسجيله (VOD / إعادة البث)."
            checked={draft.options.skipVodOfAnnouncedLive}
            onChange={(v) => setOption('skipVodOfAnnouncedLive', v)}
          />
        </div>
      </Section>

      <Section id="live" icon={<Radio className="size-[18px]" />} title="خيارات البث" description="كيف تتصرف رسالة البث أثناءه وبعده.">
        <div className="grid gap-5 md:grid-cols-2">
          <Field
            label="مدة دمج البث المتقطع"
            htmlFor="field-options.reconnectMergeMinutes"
            error={fieldError('options.reconnectMergeMinutes')}
            hint="لو البث طاح ورجع خلال هالمدة، نكمل على نفس الرسالة والجلسة بدل إشعار جديد (0 = كل رجعة إشعار جديد)."
          >
            <NumberField
              id="field-options.reconnectMergeMinutes"
              value={draft.options.reconnectMergeMinutes}
              onChange={(v) => setOption('reconnectMergeMinutes', v)}
              {...OPTION_LIMITS.reconnectMergeMinutes}
              suffix="دقيقة"
              invalid={!!fieldError('options.reconnectMergeMinutes')}
            />
          </Field>
          <Field
            label="تحديث رسالة البث كل"
            htmlFor="field-options.liveUpdateMinutes"
            error={fieldError('options.liveUpdateMinutes')}
            hint="تتحدث الرسالة بعدد المشاهدين والعنوان واللعبة والمنصات (0 = بدون تحديث دوري)."
          >
            <NumberField
              id="field-options.liveUpdateMinutes"
              value={draft.options.liveUpdateMinutes}
              onChange={(v) => setOption('liveUpdateMinutes', v)}
              {...OPTION_LIMITS.liveUpdateMinutes}
              suffix="دقيقة"
              invalid={!!fieldError('options.liveUpdateMinutes')}
            />
          </Field>
        </div>
        <div className="mt-4 border-t border-white/[0.05]">
          <SwitchRow
            title="ملخص بعد البث"
            description="لما يخلص البث تتحول نفس الرسالة لملخص: المدة، أعلى وأوسط مشاهدين، الألعاب، المنصات وروابط الإعادة."
            checked={draft.options.summaryEnabled}
            onChange={(v) => setOption('summaryEnabled', v)}
          />
        </div>
      </Section>

      <SaveBar
        visible={dirty}
        changeCount={changeCount}
        errorCount={errorCount}
        saving={updateSettings.isPending}
        onSave={save}
        onReset={reset}
        onShowErrors={() => {
          const first = Object.keys(errors)[0];
          if (first) document.getElementById(`field-${first}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }}
      />
    </div>
  );
}

function toggleKind(list: ContentKind[], kind: ContentKind): ContentKind[] {
  return list.includes(kind) ? list.filter((k) => k !== kind) : CONTENT_KINDS.filter((k) => k === kind || list.includes(k));
}

function Section({ id, icon, title, description, actions, children }: { id: string; icon: ReactNode; title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <Card id={id} className="scroll-mt-24">
      <CardHeader icon={icon} title={title} description={description} actions={actions} />
      <CardBody>{children}</CardBody>
    </Card>
  );
}

function PlatformToggle({ platform, enabled, onChange }: { platform: Platform; enabled: boolean; onChange: (on: boolean) => void }) {
  const meta = PLATFORM_META[platform];
  return (
    <div
      role="presentation"
      onClick={() => onChange(!enabled)}
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-xl p-3 ring-1 ring-inset transition-[background-color,box-shadow,opacity]',
        enabled ? 'bg-white/[0.04] ring-white/[0.1]' : 'bg-transparent opacity-60 ring-white/[0.05] hover:opacity-80',
      )}
    >
      <PlatformTile platform={platform} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-zinc-100">{meta.label}</p>
        <p className={cn('text-xs', enabled ? 'text-emerald-400/90' : 'text-zinc-500')}>{enabled ? 'شغّالة' : 'متوقفة'}</p>
      </div>
      <Switch checked={enabled} onChange={onChange} label={meta.label} />
    </div>
  );
}
