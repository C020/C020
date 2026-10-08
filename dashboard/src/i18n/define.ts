import type { PluralMessage } from './core';

type Msg = string | PluralMessage;

/**
 * Declares one area's strings side by side. Keys come from `ar`; `en` must have exactly the same
 * keys (a missing or extra key is a type error).
 */
export function defineMessages<const K extends string>(messages: { ar: Record<K, Msg>; en: Record<NoInfer<K>, Msg> }) {
  return messages;
}
