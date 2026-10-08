/**
 * custom_id values of the bot's buttons and modals. Everything starts with "sb:" so interactions of other
 * features (or other bots sharing a client) are never mistaken for ours. Discord caps custom_id at 100 chars.
 */

export const CUSTOM_ID_PREFIX = 'sb:';

export const CustomIds = {
  /** #1 — notification-role toggle button on the notify panel. */
  notifyToggle: 'sb:notify:toggle',
  /** #9 — "apply as a streamer" button on the apply panel. */
  applyOpen: 'sb:apply:open',
  /** #9 — the application modal. */
  applySubmit: 'sb:apply:submit',
  /** #9 — reviewer buttons on the review message. */
  applyApprove: (applicationId: number): string => `sb:apply:approve:${applicationId}`,
  applyReject: (applicationId: number): string => `sb:apply:reject:${applicationId}`,
  /** #9 — the reject-reason modal opened by the reject button. */
  applyRejectReason: (applicationId: number): string => `sb:apply:rejectreason:${applicationId}`,
} as const;

/** Text input ids inside the modals. */
export const ModalFields = {
  twitch: 'twitch',
  kick: 'kick',
  youtube: 'youtube',
  tiktok: 'tiktok',
  note: 'note',
  reason: 'reason',
} as const;

export type ParsedCustomId =
  | { action: 'notify.toggle' }
  | { action: 'apply.open' }
  | { action: 'apply.submit' }
  | { action: 'apply.approve' | 'apply.reject' | 'apply.rejectReason'; applicationId: number };

const WITH_ID: Record<string, 'apply.approve' | 'apply.reject' | 'apply.rejectReason'> = {
  'sb:apply:approve:': 'apply.approve',
  'sb:apply:reject:': 'apply.reject',
  'sb:apply:rejectreason:': 'apply.rejectReason',
};

/** Parses one of our custom ids; null for foreign or malformed ids. */
export function parseCustomId(customId: string | null | undefined): ParsedCustomId | null {
  if (typeof customId !== 'string' || !customId.startsWith(CUSTOM_ID_PREFIX) || customId.length > 100) return null;
  if (customId === CustomIds.notifyToggle) return { action: 'notify.toggle' };
  if (customId === CustomIds.applyOpen) return { action: 'apply.open' };
  if (customId === CustomIds.applySubmit) return { action: 'apply.submit' };
  for (const [prefix, action] of Object.entries(WITH_ID)) {
    if (!customId.startsWith(prefix)) continue;
    const rest = customId.slice(prefix.length);
    if (!/^\d{1,15}$/.test(rest)) return null;
    const applicationId = Number(rest);
    return Number.isSafeInteger(applicationId) && applicationId > 0 ? { action, applicationId } : null;
  }
  return null;
}
