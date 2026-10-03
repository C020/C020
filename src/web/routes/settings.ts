import type { FastifyInstance } from 'fastify';
import type { SettingsDto } from '../../shared/api.js';
import { toSettingsDto } from '../dto.js';
import { parseInput, settingsUpdateSchema } from '../schemas.js';
import {
  changedFields,
  describeChanges,
  mergeSettings,
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
    const roleRelevant = fields.some((f) => ROLE_SYNC_FIELDS.has(f)) && (saved.streamerRoleId || saved.liveRoleId);
    if (roleRelevant) bestEffort(request, 'Role sync after settings change', () => ctx.sessions.syncRoles(guildId, auth.actor));

    return toSettingsDto(saved);
  });
}
