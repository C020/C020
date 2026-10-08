/**
 * Guild setup diagnostics (pure): turns a snapshot of Discord facts plus the guild settings into a list of
 * actionable problems for the dashboard and `/bot status`, in the guild language (#16; Arabic by default).
 * Callers that need another language (the dashboard UI language) can pass a settings copy with a different
 * `features.language`.
 */
import { type GuildSettings, type Language, normalizeFeatures } from '../db/models.js';
import type { GuildDiagnostics } from '../services/ports.js';
import { allNotificationChannelIds } from '../services/routing.js';
import { guildLanguage, ti } from './i18n/interactions.js';
import { decideRoleAssignability, type PermissionName, permissionList, permissionName, type RolePosition } from './permissions.js';

export interface RoleFact extends RolePosition {
  name: string;
  managed: boolean;
  mentionable: boolean;
  /** Grants moderation/admin power (Administrator, Manage Server, Ban Members...); undefined when unknown. */
  elevated?: boolean;
}

export interface ChannelFact {
  id: string;
  name: string;
  /** Text or announcement channel (or a thread) the bot could post in. */
  textBased: boolean;
  /** Posting permissions the bot lacks there. */
  missing: PermissionName[];
  /** Whether the bot may upload files there (expiring TikTok images are uploaded); undefined when unknown. */
  canAttachFiles?: boolean;
  /** #8 — permissions the bot lacks to rename this channel (View Channel, Manage Channel, + Connect for voice). */
  manageMissing?: PermissionName[];
  /** Threads cannot host the live counter. */
  thread?: boolean;
}

export interface GuildFacts {
  guildId: string;
  /** Gateway connected and ready. */
  ready: boolean;
  /** False when the bot is not a member of the guild. */
  inGuild: boolean;
  bot: {
    hasManageRoles: boolean;
    hasMentionEveryone: boolean;
    highestRole: RolePosition | null;
  } | null;
  roles: ReadonlyMap<string, RoleFact>;
  channels: ReadonlyMap<string, ChannelFact>;
  /** Result of the last full member list fetch (false = timed out, i.e. the members intent is off). */
  membersIntentOk: boolean | null;
  /** #15 — the bot logged in with the privileged Presence intent (undefined = unknown, not checked). */
  presenceIntent?: boolean;
}

type Problem = GuildDiagnostics['problems'][number];

type RoleKind = 'streamer' | 'live';
type ChannelKind = 'live' | 'content' | 'log' | 'routed' | 'notifyPanel' | 'applyPanel' | 'review';

/** Problem code prefix per channel kind (the first three predate v2 and must stay stable). */
const CHANNEL_CODES: Record<ChannelKind, string> = {
  live: 'live',
  content: 'content',
  log: 'log',
  routed: 'routed',
  notifyPanel: 'notify_panel',
  applyPanel: 'apply_panel',
  review: 'review',
};

/** Broken notification channels are errors; optional features and the log channel only warn. */
const CHANNEL_LEVELS: Record<ChannelKind, Problem['level']> = {
  live: 'error',
  content: 'error',
  routed: 'error',
  log: 'warn',
  notifyPanel: 'warn',
  applyPanel: 'warn',
  review: 'warn',
};

function roleLabel(kind: RoleKind | 'notify', lang: Language): string {
  return ti(lang, kind === 'streamer' ? 'diag.role.streamer' : kind === 'live' ? 'diag.role.live' : 'diag.role.notify');
}

function channelLabel(kind: ChannelKind | 'counter', lang: Language): string {
  return ti(lang, `diag.channel.${kind}`);
}

class Diagnoser {
  readonly problems: Problem[] = [];

  constructor(
    private readonly facts: GuildFacts,
    private readonly settings: GuildSettings,
    private readonly lang: Language,
  ) {}

  private push(code: string, level: Problem['level'], message: string): void {
    this.problems.push({ code, level, message });
  }

  /** Hierarchy/managed problems of a role (Manage Roles itself is reported once for the whole guild). */
  private hierarchy(role: RoleFact): ReturnType<typeof decideRoleAssignability> | null {
    if (!this.facts.bot) return null;
    // Evaluate the hierarchy as if Manage Roles were granted so the admin sees every problem in one go.
    return decideRoleAssignability({ guildId: this.facts.guildId, role, bot: { ...this.facts.bot, hasManageRoles: true } }, this.lang);
  }

  role(kind: RoleKind, roleId: string | null, required: boolean): void {
    const label = roleLabel(kind, this.lang);
    if (!roleId) {
      if (required) this.push(`${kind}_role_unset`, 'warn', ti(this.lang, 'diag.roleUnset', { label }));
      return;
    }
    const role = this.facts.roles.get(roleId);
    if (!role) {
      this.push(`${kind}_role_not_found`, 'error', ti(this.lang, 'diag.roleNotFound', { label, id: roleId }));
      return;
    }
    const decision = this.hierarchy(role);
    if (decision && !decision.ok) this.push(`${kind}_${decision.code}`, 'error', decision.message);
  }

  channel(kind: ChannelKind, channelId: string | null, needsUploads = false): void {
    const label = channelLabel(kind, this.lang);
    if (!channelId) {
      if (kind === 'live') this.push('live_channel_unset', 'warn', ti(this.lang, 'diag.liveChannelUnset'));
      if (kind === 'content') this.push('content_channel_unset', 'warn', ti(this.lang, 'diag.contentChannelUnset'));
      return;
    }
    const code = CHANNEL_CODES[kind];
    const level = CHANNEL_LEVELS[kind];
    const channel = this.facts.channels.get(channelId);
    if (!channel) {
      this.push(`${code}_channel_not_found`, level, ti(this.lang, 'diag.channelNotFound', { label, id: channelId }));
      return;
    }
    if (!channel.textBased) {
      this.push(`${code}_channel_not_text`, level, ti(this.lang, 'diag.channelNotText', { label, name: channel.name }));
      return;
    }
    if (channel.missing.length > 0) {
      this.push(
        `${code}_channel_no_permission`,
        level,
        ti(this.lang, 'diag.channelNoPermission', { label, name: channel.name, perms: permissionList(channel.missing, this.lang) }),
      );
      return;
    }
    // Not fatal: without it the image is sent as a link, which expires for TikTok.
    if (needsUploads && channel.canAttachFiles === false) {
      this.push(
        `${code}_channel_no_attach_files`,
        'warn',
        ti(this.lang, 'diag.channelNoAttach', { perm: permissionName('AttachFiles', this.lang), label, name: channel.name }),
      );
    }
  }

  ping(): void {
    const { settings, facts, lang } = this;
    if (settings.pingMode === 'none') return;
    const canMentionEveryone = facts.bot?.hasMentionEveryone ?? true;
    if (settings.pingMode === 'everyone' || settings.pingMode === 'here') {
      if (!canMentionEveryone) this.push('ping_no_permission', 'warn', ti(lang, 'diag.pingNoPermission', { mode: settings.pingMode }));
      return;
    }
    if (!settings.pingRoleId) {
      this.push('ping_role_unset', 'warn', ti(lang, 'diag.pingRoleUnset'));
      return;
    }
    const role = facts.roles.get(settings.pingRoleId);
    if (!role) {
      this.push('ping_role_not_found', 'warn', ti(lang, 'diag.pingRoleNotFound', { id: settings.pingRoleId }));
    } else if (!role.mentionable && !canMentionEveryone) {
      this.push('ping_role_not_mentionable', 'warn', ti(lang, 'diag.pingRoleNotMentionable', { name: role.name }));
    }
  }

  /** #1 — the opt-in notification role must be assignable, not elevated and mentionable (when it pings). */
  notifyRole(): void {
    const { settings, facts, lang } = this;
    const feature = settings.features.notifyRole;
    if (!feature.roleId) return;
    const label = roleLabel('notify', lang);
    const role = facts.roles.get(feature.roleId);
    if (!role) {
      this.push('notify_role_not_found', 'error', ti(lang, 'diag.roleNotFound', { label, id: feature.roleId }));
    } else {
      const decision = this.hierarchy(role);
      if (decision && !decision.ok) this.push(`notify_${decision.code}`, 'error', decision.message);
      if (role.elevated) this.push('notify_role_elevated', 'error', ti(lang, 'diag.notifyRoleElevated', { name: role.name }));
      const pings = feature.pingOnLive || feature.pingOnContent;
      if (pings && !role.mentionable && !(facts.bot?.hasMentionEveryone ?? true)) {
        this.push('notify_role_not_mentionable', 'warn', ti(lang, 'diag.notifyRoleNotMentionable', { name: role.name }));
      }
      const other = role.id === settings.liveRoleId ? 'Streaming Now' : role.id === settings.streamerRoleId ? 'Streamer' : null;
      if (other) this.push('notify_role_conflict', 'warn', ti(lang, 'diag.notifyRoleConflict', { other }));
    }
    if (!feature.panelChannelId) this.push('notify_panel_channel_unset', 'warn', ti(lang, 'diag.notifyPanelUnset'));
    else this.channel('notifyPanel', feature.panelChannelId);
  }

  /** #9 — application panel + optional review channel. */
  applications(): void {
    const feature = this.settings.features.applications;
    if (!feature.enabled) return;
    if (!feature.panelChannelId) this.push('apply_panel_channel_unset', 'warn', ti(this.lang, 'diag.applyPanelUnset'));
    else this.channel('applyPanel', feature.panelChannelId);
    if (feature.reviewChannelId) this.channel('review', feature.reviewChannelId);
  }

  /** #8 — the counter channel only needs to be renameable (any channel type except threads). */
  counter(): void {
    const channelId = this.settings.features.counter.channelId;
    if (!channelId) return;
    const channel = this.facts.channels.get(channelId);
    if (!channel) {
      this.push('counter_channel_not_found', 'warn', ti(this.lang, 'diag.channelNotFound', { label: channelLabel('counter', this.lang), id: channelId }));
      return;
    }
    if (channel.thread) {
      this.push('counter_channel_thread', 'warn', ti(this.lang, 'diag.counterIsThread', { name: channel.name }));
      return;
    }
    if (channel.manageMissing && channel.manageMissing.length > 0) {
      this.push(
        'counter_channel_no_permission',
        'warn',
        ti(this.lang, 'diag.counterNoPermission', { name: channel.name, perms: permissionList(channel.manageMissing, this.lang) }),
      );
    }
  }

  /** #15 — presence detection needs the privileged intent at login. */
  presence(): void {
    if (this.settings.features.presence.enabled && this.facts.presenceIntent === false) {
      this.push('presence_intent_missing', 'warn', ti(this.lang, 'diag.presenceIntent'));
    }
  }
}

/** Every channel the diagnostics look at (the gateway collects facts for exactly these). */
export function diagnosedChannelIds(settings: GuildSettings): string[] {
  const f = settings.features ? settings.features : normalizeFeatures(undefined);
  const ids = [
    settings.liveChannelId,
    settings.contentChannelId,
    settings.logChannelId,
    ...allNotificationChannelIds({ ...settings, features: f }),
    f.notifyRole.roleId ? f.notifyRole.panelChannelId : null,
    f.applications.enabled ? f.applications.panelChannelId : null,
    f.applications.enabled ? f.applications.reviewChannelId : null,
    f.counter.channelId,
  ].filter((v): v is string => typeof v === 'string' && v !== '');
  return [...new Set(ids)];
}

export function diagnoseGuild(facts: GuildFacts, rawSettings: GuildSettings): GuildDiagnostics {
  // Settings objects built before the features column existed still diagnose (features off).
  const settings: GuildSettings = rawSettings.features ? rawSettings : { ...rawSettings, features: normalizeFeatures(undefined) };
  const lang = guildLanguage(settings);
  const d = new Diagnoser(facts, settings, lang);
  const result = (botHasManageRoles: boolean): GuildDiagnostics => ({ guildId: facts.guildId, botInGuild: facts.inGuild, botHasManageRoles, problems: d.problems });

  if (!facts.ready) {
    d.problems.push({ code: 'discord_not_ready', level: 'error', message: ti(lang, 'diag.notReady') });
    return result(false);
  }
  if (!facts.inGuild) {
    d.problems.push({ code: 'bot_not_in_guild', level: 'error', message: ti(lang, 'diag.notInGuild') });
    return result(false);
  }

  const hasManageRoles = facts.bot?.hasManageRoles ?? false;
  if (facts.bot && !hasManageRoles) {
    d.problems.push({ code: 'missing_manage_roles', level: 'error', message: ti(lang, 'diag.missingManageRoles') });
  }

  d.role('streamer', settings.streamerRoleId, settings.options.autoStreamerRole);
  d.role('live', settings.liveRoleId, true);
  if (settings.streamerRoleId && settings.streamerRoleId === settings.liveRoleId) {
    d.problems.push({ code: 'same_roles', level: 'warn', message: ti(lang, 'diag.sameRoles') });
  }

  // TikTok images expire, so they are uploaded with content posts and summaries.
  const uploadsImages = settings.platformsEnabled.includes('tiktok');
  d.channel('live', settings.liveChannelId, uploadsImages);
  d.channel('content', settings.contentChannelId, uploadsImages);
  // #4 — every routed channel (per platform / per kind / digest) must be postable too.
  const checked = new Set([settings.liveChannelId, settings.contentChannelId]);
  for (const channelId of allNotificationChannelIds(settings)) {
    if (!checked.has(channelId)) d.channel('routed', channelId, uploadsImages);
  }
  d.channel('log', settings.logChannelId);
  d.ping();
  d.notifyRole();
  d.applications();
  d.counter();
  d.presence();

  if (facts.membersIntentOk === false) {
    d.problems.push({ code: 'members_intent', level: 'warn', message: ti(lang, 'diag.membersIntent') });
  }
  return result(hasManageRoles);
}
