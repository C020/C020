import { Lock, Radio, RefreshCw, ShieldCheck } from 'lucide-react';
import { Suspense, type ReactNode } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { isApiError } from '../api/client';
import { useMe } from '../api/queries';
import { DiscordLogo } from '../components/DiscordLogo';
import { PlatformIcon } from '../components/PlatformIcon';
import { Button } from '../components/ui/Button';
import { ErrorState } from '../components/ui/ErrorState';
import { Spinner } from '../components/ui/Spinner';
import { SessionContext } from '../hooks/useSession';
import { PLATFORMS } from '../lib/platforms';

/** Resolves the session: splash while loading, login screen when logged out, otherwise the app. */
export function AuthGate() {
  const me = useMe();

  if (me.data === undefined) {
    if (me.isError) {
      if (isApiError(me.error) && me.error.code === 'dashboard_disabled') return <LoginScreen disabledMessage={me.error.message} />;
      return (
        <CenteredScreen>
          <ErrorState error={me.error} onRetry={() => void me.refetch()} retrying={me.isFetching} title="ما قدرنا نفتح لوحة التحكم" />
        </CenteredScreen>
      );
    }
    return <SplashScreen />;
  }
  if (me.data === null) return <LoginScreen />;

  return (
    <SessionContext.Provider value={me.data}>
      <Suspense fallback={<SplashScreen />}>
        <Outlet />
      </Suspense>
    </SessionContext.Provider>
  );
}

function CenteredScreen({ children }: { children: ReactNode }) {
  return <div className="grid min-h-dvh place-items-center p-6">{children}</div>;
}

export function SplashScreen() {
  return (
    <CenteredScreen>
      <div className="flex flex-col items-center gap-4 text-zinc-400">
        <div className="relative grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 shadow-[0_12px_40px_-12px_rgb(124_58_237/0.9)]">
          <Radio className="size-6 text-white" />
          <span className="absolute -end-1 -top-1 size-3.5 animate-pulse rounded-full bg-rose-500 ring-[3px] ring-zinc-950" />
        </div>
        <Spinner className="size-5 text-violet-400" />
      </div>
    </CenteredScreen>
  );
}

function LoginScreen({ disabledMessage }: { disabledMessage?: string }) {
  const location = useLocation();
  const next = `${location.pathname}${location.search}`;
  const loginHref = `/auth/login${next && next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`;

  return (
    <CenteredScreen>
      <div className="w-full max-w-md animate-pop-in">
        <div className="glass relative overflow-hidden rounded-3xl p-8 text-center shadow-2xl shadow-black/50">
          <div className="pointer-events-none absolute -top-24 left-1/2 size-64 -translate-x-1/2 rounded-full bg-violet-600/20 blur-3xl" />
          <div className="relative mx-auto mb-6 grid size-16 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 shadow-[0_16px_48px_-12px_rgb(124_58_237/0.9)]">
            <Radio className="size-7 text-white" />
            <span className="absolute -end-1 -top-1 size-4 rounded-full bg-rose-500 ring-4 ring-zinc-900" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">لوحة تحكم بوت البثوث</h1>
          <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-zinc-400">
            تحكم بالستريمرز، إشعارات البث والمقاطع، والرتب التلقائية لكل المنصات من مكان واحد.
          </p>
          <div className="mt-5 flex items-center justify-center gap-3">
            {PLATFORMS.map((p) => (
              <span key={p} className="grid size-9 place-items-center rounded-xl bg-white/[0.04] ring-1 ring-inset ring-white/[0.06]">
                <PlatformIcon platform={p} className="size-[18px]" />
              </span>
            ))}
          </div>

          {disabledMessage ? (
            <div className="mt-7 rounded-2xl bg-amber-500/10 p-4 text-start ring-1 ring-inset ring-amber-500/20">
              <div className="flex items-center gap-2 text-sm font-medium text-amber-200">
                <Lock className="size-4" />
                لوحة التحكم مقفلة حالياً
              </div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-amber-100/80">{disabledMessage}</p>
              <Button size="sm" variant="secondary" className="mt-3" icon={<RefreshCw className="size-3.5" />} onClick={() => window.location.reload()}>
                تحديث الصفحة
              </Button>
            </div>
          ) : (
            <>
              <a
                href={loginHref}
                className="mt-7 inline-flex h-12 w-full items-center justify-center gap-2.5 rounded-xl bg-blurple text-[15px] font-semibold text-white shadow-[0_12px_32px_-12px_rgb(88_101_242/0.9)] transition-[background-color,transform] hover:bg-[#4752c4] active:scale-[0.98]"
              >
                <DiscordLogo className="size-5" />
                تسجيل الدخول بديسكورد
              </a>
              <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-zinc-500">
                <ShieldCheck className="size-3.5" />
                يدخل بس مشرفين السيرفر (Manage Server) أو الأدمن المحددين
              </p>
            </>
          )}
        </div>
      </div>
    </CenteredScreen>
  );
}
