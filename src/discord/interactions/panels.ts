/**
 * Interactive panels: the #1 notification-role toggle and the #9 "apply as a streamer" button.
 *
 * Posting is idempotent per guild and kind: a panel already in the configured channel is edited in place
 * (refreshed texts/buttons); after the admin moves the panel channel, a new panel is posted there and the old
 * message is deleted (best effort). The last panel per guild/kind is remembered in repos.panels.
 */
import { ButtonStyle, ComponentType } from 'discord.js';
import { ValidationError } from '../../core/errors.js';
import { childLogger } from '../../core/logger.js';
import type { GuildSettings, Language, PanelKind } from '../../db/models.js';
import type { Repositories } from '../../db/repositories.js';
import type { MessageRef } from '../../services/ports.js';
import { cleanText, truncate } from '../format.js';
import { guildLanguage, ti } from '../i18n/interactions.js';
import type { RoleAssignDecision } from '../permissions.js';
import { DISCORD_LIMITS } from '../templates.js';
import { KeyedQueue } from '../util.js';
import { deliveryFailureText } from './failures.js';
import { CustomIds } from './ids.js';
import { GONE_REASONS, type InteractiveMessenger } from './messenger.js';
import type { InteractiveMessage } from './types.js';

const log = childLogger('discord.panels');

export const PANEL_COLORS: Record<PanelKind, number> = { notify: 0x5865f2, apply: 0x57f287 };

/** Admin text from the settings: trimmed and cut to the Discord limit; null when empty. */
function customText(value: string | null | undefined, max: number, singleLine: boolean): string | null {
  if (typeof value !== 'string') return null;
  const text = singleLine ? cleanText(value) : value.replace(/\r\n/g, '\n').trim();
  return text ? truncate(text, max) : null;
}

/** #1 — notify panel: embed + one toggle button. A custom description may use {role}. */
export function buildNotifyPanel(settings: GuildSettings): InteractiveMessage {
  const lang = guildLanguage(settings);
  const feature = settings.features.notifyRole;
  const role = feature.roleId ? `<@&${feature.roleId}>` : '';
  const variant = feature.pingOnLive && feature.pingOnContent ? 'both' : feature.pingOnContent ? 'content' : 'live';
  const title = customText(feature.panelTitle, DISCORD_LIMITS.title, true) ?? ti(lang, 'panel.notify.title');
  const custom = customText(feature.panelDescription, DISCORD_LIMITS.description, false);
  const description = custom ? truncate(custom.replace(/\{role\}/g, role), DISCORD_LIMITS.description) : ti(lang, `panel.notify.desc.${variant}`, { role });
  return {
    content: '',
    embeds: [{ color: PANEL_COLORS.notify, title, description }],
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          { type: ComponentType.Button, style: ButtonStyle.Primary, custom_id: CustomIds.notifyToggle, label: ti(lang, 'panel.notify.button'), emoji: { name: '🔔' } },
        ],
      },
    ],
  };
}

/** #9 — apply panel: embed + one "apply" button. */
export function buildApplyPanel(settings: GuildSettings): InteractiveMessage {
  const lang = guildLanguage(settings);
  const feature = settings.features.applications;
  const title = customText(feature.panelTitle, DISCORD_LIMITS.title, true) ?? ti(lang, 'panel.apply.title');
  const description = customText(feature.panelDescription, DISCORD_LIMITS.description, false) ?? ti(lang, 'panel.apply.desc');
  return {
    content: '',
    embeds: [{ color: PANEL_COLORS.apply, title, description }],
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          { type: ComponentType.Button, style: ButtonStyle.Success, custom_id: CustomIds.applyOpen, label: ti(lang, 'panel.apply.button'), emoji: { name: '📝' } },
        ],
      },
    ],
  };
}

/** Result of checking whether the bot may hand out a role; null = unknown (Discord not ready). */
export type RoleCheck = { exists: false } | { exists: true; name: string; elevated: boolean; decision: RoleAssignDecision };

export interface PanelPublisherDeps {
  repos: Repositories;
  messenger: InteractiveMessenger;
  isReady(): boolean;
  checkRole(guildId: string, roleId: string, lang: Language): Promise<RoleCheck | null>;
}

export class PanelPublisher {
  private readonly queue = new KeyedQueue();

  constructor(private readonly deps: PanelPublisherDeps) {}

  /** Posts or refreshes a panel. Throws ValidationError (guild language) explaining what to fix. */
  post(guildId: string, kind: PanelKind): Promise<MessageRef> {
    return this.queue.run(`${guildId}:${kind}`, () => this.publish(guildId, kind));
  }

  private async publish(guildId: string, kind: PanelKind): Promise<MessageRef> {
    const settings = this.deps.repos.settings.get(guildId);
    const lang = guildLanguage(settings);
    const channelId = kind === 'notify' ? await this.notifyChannel(guildId, settings, lang) : this.applyChannel(settings, lang);
    if (!this.deps.isReady()) throw new ValidationError(ti(lang, 'common.notReady'));

    const message = kind === 'notify' ? buildNotifyPanel(settings) : buildApplyPanel(settings);
    const label = ti(lang, kind === 'notify' ? 'label.notifyPanel' : 'label.applyPanel');
    const previous = this.deps.repos.panels.get(guildId, kind);

    if (previous && previous.channelId === channelId) {
      const ref = { channelId: previous.channelId, messageId: previous.messageId };
      const edited = await this.deps.messenger.edit(guildId, ref, message);
      if (edited.ok) {
        this.deps.repos.panels.set(guildId, kind, edited.ref.channelId, edited.ref.messageId);
        return edited.ref;
      }
      // Lost access or a temporary problem: posting a second panel next to the old one would not help.
      if (!GONE_REASONS.has(edited.reason)) throw new ValidationError(deliveryFailureText(lang, edited, label, channelId));
    }

    const sent = await this.deps.messenger.send(guildId, channelId, message);
    if (!sent.ok) throw new ValidationError(deliveryFailureText(lang, sent, label, channelId));
    this.deps.repos.panels.set(guildId, kind, sent.ref.channelId, sent.ref.messageId);
    if (previous && previous.channelId !== channelId) {
      const outcome = await this.deps.messenger.delete(guildId, { channelId: previous.channelId, messageId: previous.messageId }).catch(() => 'failed' as const);
      if (outcome === 'failed') log.info({ guildId, kind, previous }, 'Old panel message could not be deleted');
    }
    return sent.ref;
  }

  private async notifyChannel(guildId: string, settings: GuildSettings, lang: Language): Promise<string> {
    const feature = settings.features.notifyRole;
    if (!feature.roleId) throw new ValidationError(ti(lang, 'panel.notify.noRole'), 'features.notifyRole.roleId');
    if (!feature.panelChannelId) throw new ValidationError(ti(lang, 'panel.notify.noChannel'), 'features.notifyRole.panelChannelId');
    if (feature.roleId === settings.liveRoleId || feature.roleId === settings.streamerRoleId) {
      throw new ValidationError(ti(lang, 'panel.notify.roleConflict'), 'features.notifyRole.roleId');
    }
    const check = await this.deps.checkRole(guildId, feature.roleId, lang);
    if (check) {
      if (!check.exists) throw new ValidationError(ti(lang, 'panel.notify.roleMissing'), 'features.notifyRole.roleId');
      if (check.elevated) throw new ValidationError(ti(lang, 'panel.notify.roleElevated'), 'features.notifyRole.roleId');
      if (!check.decision.ok) throw new ValidationError(check.decision.message, 'features.notifyRole.roleId');
    }
    return feature.panelChannelId;
  }

  private applyChannel(settings: GuildSettings, lang: Language): string {
    const feature = settings.features.applications;
    if (!feature.enabled) throw new ValidationError(ti(lang, 'panel.apply.disabled'), 'features.applications.enabled');
    if (!feature.panelChannelId) throw new ValidationError(ti(lang, 'panel.apply.noChannel'), 'features.applications.panelChannelId');
    return feature.panelChannelId;
  }
}
