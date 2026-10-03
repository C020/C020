import { useEffect, type ReactNode } from 'react';
import { useOptionalGuild } from '../hooks/useGuild';

const APP_TITLE = 'لوحة تحكم البثوث';

export function PageHeader({ title, description, actions, icon }: { title: string; description?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  const guildName = useOptionalGuild()?.guild.name;
  useEffect(() => {
    document.title = [title, guildName, APP_TITLE].filter(Boolean).join(' · ');
  }, [title, guildName]);

  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4 lg:mb-8">
      <div className="flex min-w-0 items-center gap-3">
        {icon && (
          <div className="hidden size-11 place-items-center rounded-2xl bg-gradient-to-b from-white/[0.08] to-white/[0.02] text-zinc-300 ring-1 ring-inset ring-white/[0.08] sm:grid">{icon}</div>
        )}
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">{title}</h1>
          {description && <p className="mt-1 text-sm text-zinc-400">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
