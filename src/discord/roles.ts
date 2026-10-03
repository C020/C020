/**
 * RoleManager on top of discord.js. Every role change for a guild runs through one FIFO queue, so a live
 * start and a reconcile can never race each other. Public methods never throw except `reconcile`, which
 * reports guild-level problems (bot offline / not in guild) as Arabic ValidationErrors for the dashboard;
 * per-role and per-member problems are skipped with a throttled audit warning instead.
 */
import type { Client, Collection, Guild, GuildMember, Role } from 'discord.js';
import { DiscordjsErrorCodes, PermissionFlagsBits } from 'discord.js';
import { ValidationError } from '../core/errors.js';
import { childLogger } from '../core/logger.js';
import type { GuildSettings } from '../db/models.js';
import type { Repositories } from '../db/repositories.js';
import type { AuditService } from '../services/audit.js';
import type { RoleManager } from '../services/ports.js';
import { classifyDiscordError, describeDiscordError } from './apiErrors.js';
import { decideRoleAssignability } from './permissions.js';
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

interface RoleTarget {
  guild: Guild;
  role: Role;
}

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

  setLive(guildId: string, userId: string, live: boolean, reason: string): Promise<void> {
    return this.apply(guildId, userId, 'live', live, reason);
  }

  setStreamer(guildId: string, userId: string, isStreamer: boolean, reason: string): Promise<void> {
    return this.apply(guildId, userId, 'streamer', isStreamer, reason);
  }

  async reconcile(guildId: string, liveUserIds: Set<string>, streamerUserIds: Set<string>): Promise<{ added: number; removed: number }> {
    return this.queue.run(guildId, async () => {
      const client = this.getClient();
      if (!client?.isReady()) throw new ValidationError('البوت غير متصل بديسكورد حالياً، جرّب بعد شوي');
      const guild = client.guilds.cache.get(guildId);
      if (!guild) throw new ValidationError('البوت مو موجود في هذا السيرفر');

      const settings = this.repos.settings.get(guildId);
      const targets: Array<{ kind: RoleKind; roleId: string | null; desired: Set<string>; removable: (id: string) => boolean }> = [
        { kind: 'live', roleId: settings.liveRoleId, desired: liveUserIds, removable: () => true },
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
        const resolved = await this.resolveTarget(guild, target.roleId!, target.kind);
        if (!resolved) continue;
        const { role } = resolved;
        const holders = new Set([...members.byId.values()].filter((m) => m.roles.cache.has(role.id)).map((m) => m.id));
        // Without the full member list, cached role holders are the best view of who still has the role.
        if (!members.complete) for (const id of role.members.keys()) holders.add(id);
        const plan = planRoleReconcile({
          holders,
          desired: target.desired,
          members: new Set(members.byId.keys()),
          removable: target.removable,
        });
        for (const userId of plan.add) {
          const member = members.byId.get(userId);
          if (member && (await this.change(guild, role, member, true, 'مزامنة الرتب', target.kind))) added++;
        }
        for (const userId of plan.remove) {
          const member = members.byId.get(userId) ?? guild.members.cache.get(userId);
          if (member && (await this.change(guild, role, member, false, 'مزامنة الرتب', target.kind))) removed++;
        }
      }
      return { added, removed };
    });
  }

  // ───────────────────────────── internals ─────────────────────────────

  private apply(guildId: string, userId: string, kind: RoleKind, want: boolean, reason: string): Promise<void> {
    return this.queue
      .run(guildId, async () => {
        const client = this.getClient();
        if (!client?.isReady()) {
          log.warn({ guildId, userId, kind, want }, 'Discord not ready; role change skipped (reconcile will fix it)');
          return;
        }
        if (!isSnowflake(userId)) return;
        const settings = this.repos.settings.get(guildId);
        const roleId = kind === 'live' ? settings.liveRoleId : settings.streamerRoleId;
        if (!roleId) return;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
          this.warn(guildId, `not_in_guild`, 'البوت مو موجود في السيرفر، ما قدر يعدّل الرتب');
          return;
        }
        const target = await this.resolveTarget(guild, roleId, kind);
        if (!target) return;
        const member = await this.fetchMember(guild, userId);
        if (!member) {
          log.debug({ guildId, userId, kind }, 'Member not in guild; role change skipped');
          return;
        }
        await this.change(guild, target.role, member, want, reason, kind);
      })
      .catch((err) => log.error({ err, guildId, userId, kind }, 'Role change failed unexpectedly'));
  }

  /** Validates the role and the bot's ability to manage it; warns (throttled) and returns null otherwise. */
  private async resolveTarget(guild: Guild, roleId: string, kind: RoleKind): Promise<RoleTarget | null> {
    const label = ROLE_LABELS[kind];
    let role: Role | null = guild.roles.cache.get(roleId) ?? null;
    if (!role && isSnowflake(roleId)) role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
      this.warn(guild.id, `role_missing:${roleId}`, `رتبة ${label} المحددة (${roleId}) غير موجودة في السيرفر — يمكن انحذفت، حدّثها من الإعدادات`);
      return null;
    }
    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    if (!me) {
      log.warn({ guildId: guild.id }, 'Could not resolve the bot member');
      return null;
    }
    const highest = me.roles.highest;
    const decision = decideRoleAssignability({
      guildId: guild.id,
      role: { id: role.id, name: role.name, position: role.position, managed: role.managed },
      bot: {
        hasManageRoles: me.permissions.has(PermissionFlagsBits.ManageRoles),
        highestRole: highest && highest.id !== guild.id ? { id: highest.id, position: highest.position } : null,
      },
    });
    if (!decision.ok) {
      this.warn(guild.id, `role:${decision.code}:${role.id}`, decision.message);
      return null;
    }
    return { guild, role };
  }

  /** Adds/removes the role; returns true when something changed. Never throws. */
  private async change(guild: Guild, role: Role, member: GuildMember, want: boolean, reason: string, kind: RoleKind): Promise<boolean> {
    if (member.roles.cache.has(role.id) === want) return false;
    try {
      if (want) await member.roles.add(role, reason);
      else await member.roles.remove(role, reason);
    } catch (err) {
      switch (classifyDiscordError(err)) {
        case 'unknown_member':
          return false;
        case 'unknown_role':
          this.warn(guild.id, `role_missing:${role.id}`, `رتبة ${ROLE_LABELS[kind]} (${role.name}) انحذفت من السيرفر — حدّثها من الإعدادات`);
          return false;
        case 'forbidden':
          this.warn(
            guild.id,
            `role_forbidden:${role.id}`,
            `ديسكورد رفض تعديل رتبة ${role.name} — تأكد إن عند البوت صلاحية Manage Roles وإن رتبة البوت فوق رتبة ${role.name}`,
          );
          return false;
        default:
          log.warn({ guildId: guild.id, userId: member.id, roleId: role.id, err: describeDiscordError(err) }, 'Role change failed');
          return false;
      }
    }
    this.audit.record({
      guildId: guild.id,
      action: want ? 'role.add' : 'role.remove',
      message: want ? `تم إعطاء رتبة ${role.name} لـ ${member.displayName} (${reason})` : `تم سحب رتبة ${role.name} من ${member.displayName} (${reason})`,
      details: { userId: member.id, roleId: role.id, kind, reason },
      mirror: false,
    });
    return true;
  }

  private async fetchMember(guild: Guild, userId: string): Promise<GuildMember | null> {
    const cached = guild.members.cache.get(userId);
    if (cached) return cached;
    try {
      return await guild.members.fetch(userId);
    } catch (err) {
      if (classifyDiscordError(err) !== 'unknown_member') log.warn({ guildId: guild.id, userId, err: describeDiscordError(err) }, 'Member fetch failed');
      return null;
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
      if (member) byId.set(userId, member);
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
