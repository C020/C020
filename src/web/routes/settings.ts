import type { FastifyInstance } from 'fastify';
import type { SettingsDto } from '../../shared/api.js';
import { toSettingsDto } from '../dto.js';
import { HttpError } from '../httpErrors.js';
import { canManageRoles } from '../permissions.js';
import { parseInput, settingsUpdateSchema } from '../schemas.js';
import type { AuthState } from '../types.js';
import {
  ASSIGNED_ROLE_FIELDS,
  changedFields,
  describeChanges,
  mergeSettings,
  NOTIFY_ROLE_FIELD,
  SETTING_LABELS_AR,
  toPatch,
  validateDiscordReferences,
  validateMergedSettings,
} from '../settingsLogic.js';
import { bestEffort, guildIdOf, requireAuth, type ApiDeps } from './deps.js';

/** Changing these re-syncs roles so the new role ids take effect for existing streamers right away. */
const ROLE_SYNC_FIELDS = new Set(['streamerRoleId', 'liveRoleId', 'options.autoStreamerRole']);
/** Changing these changes what the monitor polls. */
const MONITOR_FIELDS = new Set(['platformsEnabled', 'contentKinds']);

/** ADMIN_USER_IDS, or owner / Administrator / Manage Roles in this guild (from the refreshed session guild list). */
export function mayChangeAssignedRoles(auth: AuthState, guildId: string): boolean {
  return auth.isAdmin || auth.session.guilds.some((g) => g.id === guildId && canManageRoles(g));
}

export function registerSettingsRoutes(g: FastifyInstance, deps: ApiDeps): void {
  const { ctx } = deps;

  g.get('/settings', async (request): Promise<SettingsDto> => toSettingsDto(ctx.repos.settings.get(guildIdOf(request))));

  g.put('/settings', async (request): Promise<SettingsDto> => {
    const guildId = guildIdOf(request);
    const auth = requireAuth(request);
    const patch = parseInput(settingsUpdateSchema, request.body ?? {});

    const before = ctx.repos.settings.get(guildId);
    const merged = mergeSettings(before, patch);
    validateMergedSettings(guildId, merged);
    const fields = changedFields(before, merged);
    if (fields.length === 0) return toSettingsDto(before);
    const roleField = fields.find((f) => ASSIGNED_ROLE_FIELDS.has(f));
    if (roleField && !mayChangeAssignedRoles(auth, guildId)) {
      throw new HttpError(
        403,
        'forbidden',
        roleField === NOTIFY_ROLE_FIELD
          ? 'تغيير رتبة الإشعارات يحتاج صلاحية Manage Roles (أو Administrator أو تكون صاحب السيرفر)، لأن الأعضاء ياخذونها من البوت بزر'
          : 'تغيير رتبة الستريمر أو رتبة البث المباشر يحتاج صلاحية Manage Roles (أو Administrator أو تكون صاحب السيرفر)، لأن البوت يعطي هذي الرتب ويشيلها تلقائياً',
        roleField,
      );
    }
    await validateDiscordReferences(ctx, guildId, before, merged);

    const saved = ctx.repos.settings.update(guildId, toPatch(merged));
    ctx.audit.record({
      guildId,
      actor: auth.actor,
      action: 'settings.update',
      message: `تم تحديث الإعدادات: ${[...new Set(fields.map((f) => SETTING_LABELS_AR[f] ?? f))].join('، ')}`,
      details: { changes: describeChanges(before, saved, fields) },
      mirror: true,
    });

    if (fields.some((f) => MONITOR_FIELDS.has(f))) bestEffort(request, 'Notifying monitor', () => ctx.monitor.channelsChanged());
    // The previous "Streaming Now" role stays on whoever the bot gave it to (only registered streamers) unless it
    // is taken back here; reconcile and session end only know the new role. Also when the role was cleared.
    const oldLiveRoleId = before.liveRoleId;
    if (oldLiveRoleId && oldLiveRoleId !== saved.liveRoleId && oldLiveRoleId !== saved.streamerRoleId) {
      const userIds = ctx.repos.streamers.list(guildId).map((s) => s.discordUserId);
      bestEffort(request, 'Removing the previous live role', () => ctx.discord.removeRoleFrom(guildId, oldLiveRoleId, userIds, 'تغيّرت رتبة البث المباشر'));
    }
    const roleRelevant = fields.some((f) => ROLE_SYNC_FIELDS.has(f)) && (saved.streamerRoleId || saved.liveRoleId);
    if (roleRelevant) bestEffort(request, 'Role sync after settings change', () => ctx.sessions.syncRoles(guildId, auth.actor));

    // v2 services react to their settings right away instead of waiting for their next timer.
    if (fields.some((f) => f.startsWith('features.counter.'))) bestEffort(request, 'Refreshing the live counter', () => ctx.counter?.refresh(guildId));
    if (fields.some((f) => f.startsWith('features.presence.'))) bestEffort(request, 'Re-syncing presences', () => ctx.presence?.reconcile(guildId));

    return toSettingsDto(saved);
  });
}
