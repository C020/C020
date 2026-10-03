import { cn } from '../lib/cn';
import { defaultAvatarUrl } from '../lib/discord';
import { Avatar } from './ui/Avatar';

/** Streamer avatar with a red "live" ring. */
export function StreamerAvatar({
  name,
  avatarUrl,
  discordUserId,
  live = false,
  size = 40,
  className,
}: {
  name: string;
  avatarUrl: string | null;
  discordUserId?: string;
  live?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <span className={cn('relative inline-flex shrink-0 rounded-full', live && 'p-[2px] bg-gradient-to-br from-rose-500 via-fuchsia-500 to-rose-500', className)}>
      <Avatar
        src={avatarUrl ?? (discordUserId ? defaultAvatarUrl(discordUserId) : null)}
        name={name}
        size={live ? size - 4 : size}
        ring={!live}
        className={cn(live && 'ring-2 ring-zinc-950')}
      />
      {live && (
        <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-[5px] bg-rose-600 px-1 text-[9px] font-bold leading-[14px] text-white ring-2 ring-zinc-950">
          LIVE
        </span>
      )}
    </span>
  );
}
