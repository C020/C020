import { createContext, useContext } from 'react';
import type { MeResponse } from '../api/types';

export const SessionContext = createContext<MeResponse | null>(null);

/** The logged-in session (only available under the auth gate). */
export function useSession(): MeResponse {
  const me = useContext(SessionContext);
  if (!me) throw new Error('useSession() used outside the authenticated area');
  return me;
}
