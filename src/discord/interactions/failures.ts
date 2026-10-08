/** Admin-facing explanation of a failed send/edit, in the guild language (panels, test messages, review messages). */
import type { Language } from '../../db/models.js';
import { ti } from '../i18n/interactions.js';
import { permissionList } from '../permissions.js';
import type { TransportResult } from '../transport.js';

export type DeliveryFailure = Extract<TransportResult, { ok: false }>;

export function deliveryFailureText(lang: Language, result: DeliveryFailure, label: string, channelId: string): string {
  const where = result.channelName ? `#${result.channelName}` : channelId;
  switch (result.reason) {
    case 'forbidden':
      return result.missing?.length
        ? ti(lang, 'delivery.forbiddenMissing', { label, where, perms: permissionList(result.missing, lang) })
        : ti(lang, 'delivery.forbidden', { label, where });
    case 'channel_missing':
    case 'gone':
      return ti(lang, 'delivery.missing', { label, channel: channelId });
    case 'wrong_guild':
      return ti(lang, 'delivery.wrongGuild', { label, channel: channelId });
    case 'not_text':
      return ti(lang, 'delivery.notText', { label, where });
    case 'invalid':
      return ti(lang, 'delivery.invalid', { label });
    case 'not_ready':
      return ti(lang, 'common.notReady');
    default:
      return ti(lang, 'delivery.error', { label, where });
  }
}
