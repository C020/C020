/**
 * RoleManager on top of discord.js. Every role change for a guild runs through one FIFO queue, so a live
 * start and a reconcile can never race each other. Public methods never throw except `reconcile`, which
 * reports guild-level problems (bot offline / not in guild) as Arabic ValidationErrors for the dashboard;
 * per-role and per-member problems are skipped with a throttled audit warning instead. Single changes report a
 * RoleChangeOutcome so callers can retry the 'transient' ones (Discord not ready, REST/network errors).
 */
import type { Client, Collection, Guild, GuildMember, Role } from 'discord.js';
import { DiscordjsErrorCodes, PermissionFlagsBits } from 'discord.js';
import { ValidationError } from '../core/errors.js';
import { childLogger } from '../core/logger.js';
import type { GuildSettings } from '../db/models.js';
import type { Repositories } from '../db/repositories.js';
import type { AuditService } from '../services/audit.js';
import type { RoleChangeOutcome, RoleManager } from '../services/ports.js';
import { classifyDiscordError, describeDiscordError } from './apiErrors.js';
import { decideRoleAssignability, isElevatedPermissions, type RoleAssignDecision } from './permissions.js';
import { isSnowflake, KeyedQueue, WarnThrottle } from './util.js';

const log = childLogger('discord.roles');

export type RoleKind = 'live' | 'streamer';

const ROLE_LABELS: Record<RoleKind, string> = { live: 'Streaming Now', streamer: 'Streamer' };

export interface RoleReconcilePlan {
  add: string[];
  remove: string[];
}

/**
 * Pure diff between who holds a role and who should. `members` (when known) limits additions to people
 * actually in the guild; `removable` protects holders the bot must not touch (e.g. manually given roles).
 */
export function planRoleReconcile(input: {
  holders: Iterable<string>;
  desired: Iterable<string>;
  members?: ReadonlySet<string> | null;
  removable?: (userId: string) => boolean;
}): RoleReconcilePlan {
  const holders = new Set(input.holders);
  const desired = new Set(input.desired);
  const add = [...desired].filter((id) => !holders.has(id) && (!input.members || input.members.has(id))).sort();
  const remove = [...holders].filter((id) => !desired.has(id) && (input.removable?.(id) ?? true)).sort();
  return { add, remove };
}

export interface RoleServiceDeps {
  getClient: () => Client | null;
  repos: Repositories;
  audit: AuditService;
  warnThrottle?: WarnThrottle;
  /** Reports whether the full member list could be fetched (members intent health for diagnostics). */
  onMembersFetch?: (guildId: string, ok: boolean) => void;
}

/** Why a role could not be used: 'config' needs an admin fix (missing role, hierarchy...), 'transient' may succeed later. */
type RoleProblem = Extract<RoleChangeOutcome, 'config' | 'transient'>;

export class DiscordRoles implements RoleManager {
  private readonly queue = new KeyedQueue();
  private readonly getClient: () => Client | null;
  private readonly repos: Repositories;
  private readonly audit: AuditService;
  private readonly throttle: WarnThrottle;
  private readonly onMembersFetch: (guildId: string, ok: boolean) => void;

  constructor(deps: RoleServiceDeps) {
    this.getClient = deps.getClient;
    this.repos = deps.repos;
    this.audit = deps.audit;
    this.throttle = deps.warnThrottle ?? new WarnThrottle();
    this.onMembersFetch = deps.onMembersFetch ?? (() => {});
  }

  setLive(guildId: string, userId: string, live: boolean, reason: string): Promise<RoleChangeOutcome> {
    return this.apply(guildId, userId, 'live', live, reason);
  }

  setStreamer(guildId: string, userId: string, isStreamer: boolean, reason: string): Promise<RoleChangeOutcome> {
    return this.apply(guildId, userId, 'streamer', isStreamer, reason);
  }

  /**
   * Removes a role that is no longer configured (e.g. the previous "Streaming Now" role) from the given members.
   * Members who do not hold it are skipped; a deleted role means nobody holds it anymore. Never throws.
   */
  removeRoleFrom(guildId: string, roleId: string, userIds: string[], reason: string): Promise<void> {
    const targets = [...new Set(userIds)].filter(isSnowflake);
    if (targets.length === 0 || !isSnowflake(roleId) || roleId === guildId) return Promise.resolve();
    return this.queue
      .run(guildId, async () => {
        const client = this.getClient();
        if (!client?.isReady()) {
          log.warn({ guildId, roleId }, 'Discord not ready; old role cleanup skipped');
          return;
        }
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;
        // Settings changed back before this ran: the role is managed again (reconcile owns it now).
        const settings = this.repos.settings.get(guildId);
        if (roleId === settings.liveRoleId || roleId === settings.streamerRoleId) return;
        let role: Role | null = guild.roles.cache.get(roleId) ?? null;
        if (!role) {
          role = await guild.roles.fetch(roleId).catch((err: unknown) => {
            log.warn({ guildId, roleId, err: describeDiscordError(err) }, 'Role fetch failed; old role cleanup skipped');
            return null;
          });
        }
        // A deleted role is held by nobody anymore.
        if (!role) return;
        const decision = await this.assignability(guild, role);
        if (decision === 'transient') return;
        if (!decision.ok) {
          this.warn(guildId, `old_role:${decision.code}:${role.id}`, `ما قدر البوت يشيل رتبة ${role.name} القديمة من الستريمرز: ${decision.message}`);
          return;
        }
        for (const userId of targets) {
          const member = await this.fetchMember(guild, userId);
          if (typeof member === 'string' || !member.roles.cache.has(role.id)) continue;
          await this.change(guild, role, member, false, reason, 'live');
        }
      })
      .catch((err) => log.error({ err, guildId, roleId }, 'Removing old role failed unexpectedly'));
  }

  async reconcile(guildId: string, liveUserIds: Set<string>, streamerUserIds: Set<string>): Promise<{ added: number; removed: number }> {
    return this.queue.run(guildId, async () => {
      const client = this.getClient();
      if (!client?.isReady()) throw new ValidationError('البوت غير متصل بديسكورد حالياً، جرّب بعد شوي');
      const guild = client.guilds.cache.get(guildId);
      if (!guild) throw new ValidationError('البوت مو موجود في هذا السيرفر');

      const settings = this.repos.settings.get(guildId);
      // The bot only ever gives the live role to registered streamers, so only they can lose it here: an existing,
      // widely held role picked as "Streaming Now" must not be stripped from everyone else.
      const registered = new Set(this.repos.streamers.list(guildId).map((s) => s.discordUserId));
      const targets: Array<{ kind: RoleKind; roleId: string | null; desired: Set<string>; removable: (id: string) => boolean }> = [
        { kind: 'live', roleId: settings.liveRoleId, desired: liveUserIds, removable: (id) => registered.has(id) },
      ];
      // Same role for both (misconfiguration flagged by diagnostics): live semantics win, no add/remove flapping.
      if (settings.options.autoStreamerRole && settings.streamerRoleId !== settings.liveRoleId) {
        targets.push({
          kind: 'streamer',
          roleId: settings.streamerRoleId,
          desired: streamerUserIds,
          removable: this.streamerRemovalPolicy(guildId, settings),
        });
      }

      const active = targets.filter((t) => t.roleId);
      if (active.length === 0) return { added: 0, removed: 0 };
      const wanted = new Set(active.flatMap((t) => [...t.desired]));
      const members = await this.loadMembers(guild, wanted);

      let added = 0;
      let removed = 0;
      for (const target of active) {
        const role = await this.resolveTarget(guild, target.roleId!, target.kind);
        if (typeof role === 'string') continue;
        const holders = new Set([...members.byId.values()].filter((m) => m.roles.cache.has(role.id)).map((m) => m.id));
        // Without the full member list, cached role holders are the best view of who still has the role.
        if (!members.complete) for (const id of role.members.keys()) holders.add(id);
        const plan = planRoleReconcile({
          holders,
          desired: target.desired,
          members: new Set(members.byId.keys()),
          removable: target.removable,
        });
        const adds = plan.add.length > 0 && this.refusesToGrant(guild, role, target.kind) ? [] : plan.add;
        for (const userId of adds) {
          const member = members.byId.get(userId);
          if (member && (await this.change(guild, role, member, true, 'مزامنة الرتب', target.kind)) === 'applied') added++;
        }
        for (const userId of plan.remove) {
          const member = members.byId.get(userId) ?? guild.members.cache.get(userId);
          if (member && (await this.change(guild, role, member, false, 'مزامنة الرتب', target.kind)) === 'applied') removed++;
        }
      }
      return { added, removed };
    });
  }

  // ───────────────────────────── internals ─────────────────────────────

  /**
   * Applies one role change and reports what happened: 'transient' (Discord not ready, REST/network error) is
   * worth retrying, 'config' needs an admin fix (missing role, hierarchy, permissions), 'noop' means nothing
   * had to change (already in the wanted state, role not configured, member not in the guild).
   */
  private apply(guildId: string, userId: string, kind: RoleKind, want: boolean, reason: string): Promise<RoleChangeOutcome> {
    return this.queue
      .run(guildId, async (): Promise<RoleChangeOutcome> => {
        const client = this.getClient();
        if (!client?.isReady()) {
          log.warn({ guildId, userId, kind, want }, 'Discord not ready; role change skipped (caller may retry)');
          return 'transient';
        }
        if (!isSnowflake(userId)) return 'noop';
        const settings = this.repos.settings.get(guildId);
        const roleId = kind === 'live' ? settings.liveRoleId : settings.streamerRoleId;
        if (!roleId) return 'noop';
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
          this.warn(guildId, `not_in_guild`, 'البوت مو موجود في السيرفر، ما قدر يعدّل الرتب');
          return 'config';
        }
        if (guild.available === false) {
          log.warn({ guildId, userId, kind, want }, 'Guild unavailable (Discord outage); role change skipped');
          return 'transient';
        }
        const role = await this.resolveTarget(guild, roleId, kind);
        if (typeof role === 'string') return role;
        if (want && this.refusesToGrant(guild, role, kind)) return 'config';
        const member = await this.fetchMember(guild, userId);
        if (member === 'transient') return 'transient';
        if (member === 'missing') {
          log.debug({ guildId, userId, kind }, 'Member not in guild; role change skipped');
          return 'noop';
        }
        return this.change(guild, role, member, want, reason, kind);
      })
      .catch((err): RoleChangeOutcome => {
        log.error({ err, guildId, userId, kind }, 'Role change failed unexpectedly');
        return 'transient';
      });
  }

  /** Validates the role and the bot's ability to manage it; warns (throttled) and returns the problem otherwise. */
  private async resolveTarget(guild: Guild, roleId: string, kind: RoleKind): Promise<Role | RoleProblem> {
    const label = ROLE_LABELS[kind];
    let role: Role | null = guild.roles.cache.get(roleId) ?? null;
    if (!role && isSnowflake(roleId)) {
      try {
        role = await guild.roles.fetch(roleId);
      } catch (err) {
        // fetch() resolves null for an unknown role; anything thrown is a REST/network failure.
        log.warn({ guildId: guild.id, roleId, err: describeDiscordError(err) }, 'Role fetch failed');
        return classifyDiscordError(err) === 'unknown_role' ? 'config' : 'transient';
      }
    }
    if (!role) {
      this.warn(guild.id, `role_missing:${roleId}`, `رتبة ${label} المحددة (${roleId}) غير موجودة في السيرفر — يمكن انحذفت، حدّثها من الإعدادات`);
      return 'config';
    }
    const decision = await this.assignability(guild, role);
    if (decision === 'transient') return 'transient';
    if (!decision.ok) {
      this.warn(guild.id, `role:${decision.code}:${role.id}`, decision.message);
      return 'config';
    }
    return role;
  }

  /**
   * Never hands out a role with moderation/admin power (settings reject picking one, but a role chosen before that
   * check, picked while Discord was offline, or edited afterwards may still carry it). Taking it away stays allowed.
   */
  private refusesToGrant(guild: Guild, role: Role, kind: RoleKind): boolean {
    if (!isElevatedPermissions(role.permissions?.bitfield ?? 0n)) return false;
    this.warn(
      guild.id,
      `role_elevated:${role.id}`,
      `رتبة ${role.name} فيها صلاحيات إدارية (مثل Administrator أو Manage Roles أو Ban Members)، فالبوت ما راح يعطيها لأحد تلقائياً — اختر رتبة ${ROLE_LABELS[kind]} بدون صلاحيات إدارية من الإعدادات`,
    );
    return true;
  }

  /** Can the bot add/remove this role? 'transient' when the bot's own member could not be resolved. */
  private async assignability(guild: Guild, role: Role): Promise<RoleAssignDecision | 'transient'> {
    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    if (!me) {
      log.warn({ guildId: guild.id }, 'Could not resolve the bot member');
      return 'transient';
    }
    const highest = me.roles.highest;
    return decideRoleAssignability({
      guildId: guild.id,
      role: { id: role.id, name: role.name, position: role.position, managed: role.managed },
      bot: {
        hasManageRoles: me.permissions.has(PermissionFlagsBits.ManageRoles),
        highestRole: highest && highest.id !== guild.id ? { id: highest.id, position: highest.position } : null,
      },
    });
  }

  /** Adds/removes the role and reports the outcome ('applied' when something changed). Never throws. */
  private async change(guild: Guild, role: Role, member: GuildMember, want: boolean, reason: string, kind: RoleKind): Promise<RoleChangeOutcome> {
    if (member.roles.cache.has(role.id) === want) return 'noop';
    try {
      if (want) await member.roles.add(role, reason);
      else await member.roles.remove(role, reason);
    } catch (err) {
      switch (classifyDiscordError(err)) {
        case 'unknown_member':
          return 'noop';
        case 'unknown_role':
          this.warn(guild.id, `role_missing:${role.id}`, `رتبة ${ROLE_LABELS[kind]} (${role.name}) انحذفت من السيرفر — حدّثها من الإعدادات`);
          return 'config';
        case 'unknown_channel':
          // Unknown Guild: the bot is no longer in the server.
          return 'config';
        case 'forbidden':
          this.warn(
            guild.id,
            `role_forbidden:${role.id}`,
            `ديسكورد رفض تعديل رتبة ${role.name} — تأكد إن عند البوت صلاحية Manage Roles وإن رتبة البوت فوق رتبة ${role.name}`,
          );
          return 'config';
        case 'invalid':
          log.warn({ guildId: guild.id, userId: member.id, roleId: role.id, err: describeDiscordError(err) }, 'Role change rejected by Discord');
          return 'config';
        default:
          // Network error, 5xx after discord.js retries, timeout: worth retrying later.
          log.warn({ guildId: guild.id, userId: member.id, roleId: role.id, err: describeDiscordError(err) }, 'Role change failed');
          return 'transient';
      }
    }
    this.audit.record({
      guildId: guild.id,
      action: want ? 'role.add' : 'role.remove',
      message: want ? `تم إعطاء رتبة ${role.name} لـ ${member.displayName} (${reason})` : `تم سحب رتبة ${role.name} من ${member.displayName} (${reason})`,
      details: { userId: member.id, roleId: role.id, kind, reason },
      mirror: false,
    });
    return 'applied';
  }

  /** 'missing' = not in the guild (Unknown Member); 'transient' = the lookup itself failed. */
  private async fetchMember(guild: Guild, userId: string): Promise<GuildMember | 'missing' | 'transient'> {
    const cached = guild.members.cache.get(userId);
    if (cached) return cached;
    try {
      return await guild.members.fetch(userId);
    } catch (err) {
      if (classifyDiscordError(err) === 'unknown_member') return 'missing';
      log.warn({ guildId: guild.id, userId, err: describeDiscordError(err) }, 'Member fetch failed');
      return 'transient';
    }
  }

  /**
   * Full member list (needs the privileged GuildMembers intent). When that fails, falls back to fetching
   * only the members we care about; removals then rely on cached role holders.
   */
  private async loadMembers(guild: Guild, wanted: Set<string>): Promise<{ byId: Map<string, GuildMember>; complete: boolean }> {
    try {
      const all: Collection<string, GuildMember> = await guild.members.fetch();
      this.onMembersFetch(guild.id, true);
      return { byId: new Map(all.filter((m) => !m.user.bot).map((m) => [m.id, m] as const)), complete: true };
    } catch (err) {
      const timedOut = (err as { code?: unknown })?.code === DiscordjsErrorCodes.GuildMembersTimeout;
      this.onMembersFetch(guild.id, !timedOut);
      log.warn({ guildId: guild.id, err: describeDiscordError(err) }, 'Full member fetch failed; falling back to targeted fetches');
    }
    const byId = new Map<string, GuildMember>();
    for (const userId of wanted) {
      const member = await this.fetchMember(guild, userId);
      if (typeof member !== 'string') byId.set(userId, member);
    }
    return { byId, complete: false };
  }

  /**
   * The Streamer role is only removed from people the bot knows as streamers (registered but disabled,
   * when the guild removes roles on delete). Members who got the role by hand are never touched.
   */
  private streamerRemovalPolicy(guildId: string, settings: GuildSettings): (userId: string) => boolean {
    if (!settings.options.removeStreamerRoleOnDelete) return () => false;
    const disabled = new Set(
      this.repos.streamers
        .list(guildId)
        .filter((s) => !s.enabled)
        .map((s) => s.discordUserId),
    );
    return (userId) => disabled.has(userId);
  }

  private warn(guildId: string, key: string, message: string): void {
    log.warn({ guildId, key }, message);
    if (!this.throttle.allow(`${guildId}:${key}`)) return;
    this.audit.record({ guildId, action: 'discord.roles', level: 'warn', message, details: { key } });
  }
}
