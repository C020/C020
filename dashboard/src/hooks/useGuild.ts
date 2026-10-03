import { createContext, useContext } from 'react';
import type { GuildSummary } from '../api/types';
import type { RealtimeStatus } from './useGuildEvents';

export interface GuildContextValue {
  guildId: string;
  guild: GuildSummary;
  realtime: RealtimeStatus;
  basePath: string;
}

export const GuildContext = createContext<GuildContextValue | null>(null);

export function useGuild(): GuildContextValue {
  const value = useContext(GuildContext);
  if (!value) throw new Error('useGuild() used outside a guild route');
  return value;
}

/** Same as useGuild() but tolerates pages rendered outside a guild (e.g. /system). */
export function useOptionalGuild(): GuildContextValue | null {
  return useContext(GuildContext);
}
