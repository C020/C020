import { CircleCheck, CircleX, Clock, Globe, Info, Radio, RefreshCw, ServerCog, Tag, Webhook, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { useSystem } from '../api/queries';
import type { ProviderStatus } from '../api/types';
import { AppShell } from '../components/layout/AppShell';
import { PageHeader } from '../components/PageHeader';
import { PlatformTile } from '../components/PlatformIcon';
import { Badge, StatusDot } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ErrorState } from '../components/ui/ErrorState';
import { Skeleton } from '../components/ui/Skeleton';
import { useNow } from '../hooks/useNow';
import { cn } from '../lib/cn';
import { formatDateTime, formatDurationLong, formatNumber, formatRelative } from '../lib/format';
import { PLATFORM_META } from '../lib/platforms';

export default function SystemPage() {
  return <SystemStatusView />;
}

/** /system outside a guild (reachable from the guild picker). */
export function StandaloneSystemPage() {
  return (
    <AppShell>
      <SystemStatusView />
    </AppShell>
  );
}

type Health = 'ok' | 'warn' | 'error' | 'off';

function providerHealth(p: ProviderStatus): Health {
  if (!p.configured) return 'off';
  if (p.consecutiveErrors >= 3) return 'error';
  if (p.consecutiveErrors > 0 || (p.lastError && !p.lastSuccessAt)) return 'warn';
  return 'ok';
}

const HEALTH_LABELS: Record<Health, string> = { ok: 'شغّالة', warn: 'فيها أخطاء متقطعة', error: 'متعطلة', off: 'غير مهيّأة' };

export function SystemStatusView() {
  const system = useSystem();
  const now = useNow(1000);
  const data = system.data;
  // Uptime keeps ticking between polls.
  const uptime = data ? data.uptimeSec + Math.max(0, Math.floor((now - system.dataUpdatedAt) / 1000)) : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="حالة النظام"
        icon={<ServerCog className="size-5" />}
        description="حالة المراقبة لكل منصة، الويب هوكس، وآخر الأخطاء"
        actions={
          <Button variant="ghost" size="sm" onClick={() => void system.refetch()} loading={system.isFetching && !system.isPending} icon={<RefreshCw className="size-3.5" />}>
            تحديث
          </Button>
        }
      />

      {system.isError && !data ? (
        <Card>
          <ErrorState error={system.error} onRetry={() => void system.refetch()} retrying={system.isFetching} />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <InfoTile icon={<Clock className="size-4" />} label="مدة التشغيل" loading={!data} value={formatDurationLong(uptime)} />
            <InfoTile icon={<Tag className="size-4" />} label="الإصدار" loading={!data} value={<span dir="ltr">v{data?.version}</span>} />
            <InfoTile
              icon={<Webhook className="size-4" />}
              label="الويب هوكس"
              loading={!data}
              value={data?.webhooksEnabled ? <span className="text-emerald-300">مفعّلة</span> : <span className="text-zinc-400">متوقفة (استطلاع فقط)</span>}
            />
            <InfoTile
              icon={<Globe className="size-4" />}
              label="الرابط العام"
              loading={!data}
              value={
                data?.publicUrl ? (
                  <span dir="ltr" className="block truncate text-start text-[13px]">
                    {data.publicUrl.replace(/^https?:\/\//, '')}
                  </span>
                ) : (
                  <span className="text-zinc-400">غير محدد</span>
                )
              }
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {!data
              ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-64 rounded-2xl" />)
              : data.providers.map((provider) => <ProviderCard key={provider.platform} provider={provider} now={now} />)}
          </div>

          <Card className="flex items-start gap-3 p-4 text-[13px] leading-relaxed text-zinc-400 sm:p-5">
            <Info className="mt-0.5 size-4 shrink-0 text-sky-300" />
            <p>
              الاستطلاع الدوري (Polling) هو المصدر الأساسي للحالة دايماً. الويب هوكس (Twitch EventSub و Kick و YouTube WebSub) تسرّع وصول الإشعار لما تكون مفعّلة، وإذا تعطلت
              يكمل البوت بالاستطلاع بدون ما يفوته شي.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

function InfoTile({ icon, label, value, loading }: { icon: ReactNode; label: string; value: ReactNode; loading?: boolean }) {
  return (
    <div className="glass rounded-2xl p-4">
      <p className="flex items-center gap-1.5 text-xs text-zinc-500">
        {icon}
        {label}
      </p>
      <div className="mt-2 text-[15px] font-semibold text-zinc-100">{loading ? <Skeleton className="h-5 w-24" /> : value}</div>
    </div>
  );
}

function ProviderCard({ provider, now }: { provider: ProviderStatus; now: number }) {
  const health = providerHealth(provider);
  const meta = PLATFORM_META[provider.platform];
  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-center gap-3">
        <PlatformTile platform={provider.platform} size="lg" />
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-zinc-100">{meta.label}</h3>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-400">
            <StatusDot tone={health} />
            {HEALTH_LABELS[health]}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {provider.configured ? (
            <Badge tone="success">
              <CircleCheck className="size-3" />
              مفعّلة
            </Badge>
          ) : (
            <Badge tone="neutral">
              <CircleX className="size-3" />
              بدون مفاتيح
            </Badge>
          )}
          {provider.configured &&
            (provider.push ? (
              <Badge tone="violet">
                <Zap className="size-3" />
                Webhooks
              </Badge>
            ) : (
              <Badge tone="neutral">استطلاع فقط</Badge>
            ))}
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
        <Metric label="حسابات متابَعة" value={formatNumber(provider.trackedChannels)} />
        <Metric
          label="لايف الحين"
          value={
            <span className={cn('inline-flex items-center gap-1', provider.liveChannels > 0 && 'text-rose-300')}>
              {provider.liveChannels > 0 && <Radio className="size-3.5" />}
              {formatNumber(provider.liveChannels)}
            </span>
          }
        />
        <Metric label="أخطاء متتالية" value={<span className={cn(provider.consecutiveErrors > 0 && 'text-amber-300')}>{formatNumber(provider.consecutiveErrors)}</span>} />
      </dl>

      <div className="mt-4 space-y-1.5 text-[12.5px]">
        <p className="flex items-center justify-between gap-3 text-zinc-500">
          <span>آخر فحص ناجح</span>
          <span className="text-zinc-300" title={provider.lastSuccessAt ? formatDateTime(provider.lastSuccessAt) : undefined}>
            {provider.lastSuccessAt ? formatRelative(provider.lastSuccessAt, now) : '—'}
          </span>
        </p>
      </div>

      {provider.lastError && (
        <div className="mt-3 rounded-xl bg-rose-500/[0.07] p-3 ring-1 ring-inset ring-rose-500/15">
          <p className="text-[11.5px] font-medium text-rose-300">آخر خطأ</p>
          <p className="mt-1 break-words text-xs leading-relaxed text-rose-100/80" dir="auto">
            {provider.lastError}
          </p>
        </div>
      )}

      {provider.notes.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-white/[0.06] pt-3">
          {provider.notes.map((note, i) => (
            <li key={i} className="flex gap-2 text-xs leading-relaxed text-zinc-400">
              <Info className="mt-0.5 size-3.5 shrink-0 text-zinc-500" />
              <span dir="auto">{note}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl bg-white/[0.03] px-2 py-2.5 ring-1 ring-inset ring-white/[0.05]">
      <dd className="text-lg font-semibold tabular-nums text-zinc-100">{value}</dd>
      <dt className="mt-0.5 text-[11px] text-zinc-500">{label}</dt>
    </div>
  );
}
