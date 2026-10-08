/**
 * #1 — the notification-role toggle button (custom_id sb:notify:toggle). Adds the role when the member does not
 * have it, removes it otherwise, and answers ephemerally in the guild language.
 */
import { guildLanguage, ti } from '../i18n/interactions.js';
import { COLORS, embed } from '../commands/replies.js';
import { deferEphemeral, failureEmbed, memberDisplayName, replyEphemeral, warnEmbed } from './reply.js';
import type { ComponentInteraction, InteractionEnv } from './types.js';

export async function handleNotifyToggle(interaction: ComponentInteraction, env: InteractionEnv, guildId: string): Promise<void> {
  const settings = env.services.repos.settings.get(guildId);
  const lang = guildLanguage(settings);
  const feature = settings.features.notifyRole;
  const roleId = feature.roleId;
  if (!roleId) {
    await replyEphemeral(interaction, { embeds: [warnEmbed(ti(lang, 'notify.disabled'))] });
    return;
  }
  // Misconfiguration guard: the button must never hand out (or take away) a role the bot manages itself.
  if (roleId === settings.liveRoleId || roleId === settings.streamerRoleId) {
    await replyEphemeral(interaction, { embeds: [failureEmbed(ti(lang, 'notify.error.setup'), lang)] });
    return;
  }
  // Role changes go through Discord's REST API (and possibly a member fetch): acknowledge first.
  if (!(await deferEphemeral(interaction))) return;

  const userId = interaction.user.id;
  const result = await env.toggleRole(guildId, userId, roleId, lang === 'en' ? 'Stream alerts button' : 'زر إشعارات البثوث');
  const role = `<@&${roleId}>`;
  switch (result.status) {
    case 'added': {
      const variant = feature.pingOnLive && feature.pingOnContent ? 'both' : feature.pingOnLive ? 'live' : feature.pingOnContent ? 'content' : 'none';
      const body = `${ti(lang, `notify.added.${variant}`, { role })}\n${ti(lang, 'notify.added.hint')}`;
      await replyEphemeral(interaction, { embeds: [embed(COLORS.success, ti(lang, 'notify.added.title'), body)] });
      env.services.audit.record({
        guildId,
        actor: `user:${userId}`,
        action: 'notify.subscribe',
        message: `${memberDisplayName(interaction)} فعّل إشعارات البثوث (رتبة ${result.roleName})`,
        details: { userId, roleId },
        mirror: false,
      });
      return;
    }
    case 'removed':
      await replyEphemeral(interaction, { embeds: [embed(COLORS.info, ti(lang, 'notify.removed.title'), ti(lang, 'notify.removed.body', { role }))] });
      env.services.audit.record({
        guildId,
        actor: `user:${userId}`,
        action: 'notify.unsubscribe',
        message: `${memberDisplayName(interaction)} أوقف إشعارات البثوث (رتبة ${result.roleName})`,
        details: { userId, roleId },
        mirror: false,
      });
      return;
    case 'not_member':
      await replyEphemeral(interaction, { embeds: [failureEmbed(ti(lang, 'notify.error.notMember'), lang)] });
      return;
    case 'config':
      await replyEphemeral(interaction, { embeds: [failureEmbed(ti(lang, 'notify.error.config'), lang)] });
      return;
    default:
      await replyEphemeral(interaction, { embeds: [failureEmbed(ti(lang, 'notify.error.transient'), lang)] });
  }
}
