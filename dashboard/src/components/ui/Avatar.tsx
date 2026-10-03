import { useState } from 'react';
import { cn } from '../../lib/cn';
import { initials } from '../../lib/format';

export interface AvatarProps {
  src: string | null | undefined;
  name: string;
  size?: number;
  className?: string;
  rounded?: 'full' | 'xl';
  /** Subtle outline ring (off when the caller draws its own). */
  ring?: boolean;
}

/** Image avatar with an initials fallback (broken/missing image URLs are common for platform avatars). */
export function Avatar({ src, name, size = 40, className, rounded = 'full', ring = true }: AvatarProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = !!src && failed !== src;
  const radius = rounded === 'full' ? 'rounded-full' : 'rounded-xl';
  return (
    <span
      className={cn('relative inline-grid shrink-0 place-items-center overflow-hidden bg-gradient-to-br from-violet-500/30 to-indigo-500/20 text-zinc-100', ring && 'ring-1 ring-white/10', radius, className)}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)) }}
    >
      {showImage ? (
        <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(src)} className="size-full object-cover" />
      ) : (
        <span className="font-semibold">{initials(name)}</span>
      )}
    </span>
  );
}
