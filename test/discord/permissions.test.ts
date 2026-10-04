import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  buildInviteUrl,
  compareRolePositions,
  decideRoleAssignability,
  isElevatedPermissions,
  missingPostingPermissions,
  REQUIRED_PERMISSIONS,
} from '../../src/discord/permissions.js';
import { planRoleReconcile } from '../../src/discord/roles.js';
import { GUILD } from './helpers.js';

const role = (id: string, position: number, extra: Partial<{ name: string; managed: boolean }> = {}) => ({
  id,
  position,
  name: extra.name ?? 'Streaming Now',
  managed: extra.managed ?? false,
});

describe('role hierarchy decision', () => {
  const botRole = { id: '900000000000000001', position: 10 };

  it('allows a role strictly below the bot role when the bot can manage roles', () => {
    expect(decideRoleAssignability({ guildId: GUILD, role: role('800000000000000001', 5), bot: { hasManageRoles: true, highestRole: botRole } })).toEqual({ ok: true });
  });

  it('refuses a role above or equal to the bot role with an Arabic hint', () => {
    const above = decideRoleAssignability({ guildId: GUILD, role: role('800000000000000001', 12), bot: { hasManageRoles: true, highestRole: botRole } });
    expect(above).toMatchObject({ ok: false, code: 'role_above_bot' });
    expect(!above.ok && above.message).toContain('رتبة البوت لازم تكون فوق رتبة Streaming Now');
    expect(decideRoleAssignability({ guildId: GUILD, role: role(botRole.id, 10), bot: { hasManageRoles: true, highestRole: botRole } })).toMatchObject({
      ok: false,
      code: 'role_above_bot',
    });
  });

  it('breaks position ties like Discord: the older role (smaller id) ranks higher', () => {
    expect(compareRolePositions({ id: '100000000000000000', position: 3 }, { id: '200000000000000000', position: 3 })).toBeGreaterThan(0);
    expect(compareRolePositions({ id: '200000000000000000', position: 3 }, { id: '100000000000000000', position: 3 })).toBeLessThan(0);
    expect(compareRolePositions({ id: '1', position: 4 }, { id: '2', position: 3 })).toBeGreaterThan(0);
    const tie = decideRoleAssignability({
      guildId: GUILD,
      role: role('200000000000000000', 10),
      bot: { hasManageRoles: true, highestRole: { id: '100000000000000000', position: 10 } },
    });
    expect(tie.ok).toBe(true);
  });

  it('needs Manage Roles and a real highest role', () => {
    expect(decideRoleAssignability({ guildId: GUILD, role: role('800000000000000001', 1), bot: { hasManageRoles: false, highestRole: botRole } })).toMatchObject({
      ok: false,
      code: 'missing_manage_roles',
    });
    expect(decideRoleAssignability({ guildId: GUILD, role: role('800000000000000001', 1), bot: { hasManageRoles: true, highestRole: null } })).toMatchObject({
      ok: false,
      code: 'role_above_bot',
    });
  });

  it('refuses managed roles and @everyone', () => {
    expect(decideRoleAssignability({ guildId: GUILD, role: role('800000000000000001', 1, { managed: true }), bot: { hasManageRoles: true, highestRole: botRole } })).toMatchObject({
      ok: false,
      code: 'role_managed',
    });
    expect(decideRoleAssignability({ guildId: GUILD, role: role(GUILD, 0), bot: { hasManageRoles: true, highestRole: botRole } })).toMatchObject({
      ok: false,
      code: 'role_everyone',
    });
  });
});

describe('channel posting permissions', () => {
  it('lists missing permissions (threads use their own send permission)', () => {
    const granted = new Set([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
    expect(missingPostingPermissions((f) => granted.has(f))).toEqual(['EmbedLinks']);
    expect(missingPostingPermissions((f) => granted.has(f), true)).toEqual(['SendMessagesInThreads', 'EmbedLinks']);
    expect(missingPostingPermissions(() => true)).toEqual([]);
  });
});

describe('invite URL', () => {
  it('requests the bot + commands scopes with the required permissions', () => {
    const url = buildInviteUrl('123456789012345678');
    const expected =
      PermissionFlagsBits.ManageRoles |
      PermissionFlagsBits.ViewChannel |
      PermissionFlagsBits.SendMessages |
      PermissionFlagsBits.EmbedLinks |
      // Expiring TikTok images are uploaded as attachments.
      PermissionFlagsBits.AttachFiles |
      PermissionFlagsBits.ReadMessageHistory;
    expect(REQUIRED_PERMISSIONS).toBe(expected);
    expect(url).toBe(`https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot%20applications.commands&permissions=${expected}`);
  });
});

describe('planRoleReconcile', () => {
  it('adds missing members and removes stale holders', () => {
    const plan = planRoleReconcile({ holders: ['a', 'b'], desired: ['b', 'c', 'd'], members: new Set(['a', 'b', 'c']) });
    // "d" is not in the guild, so it cannot get the role.
    expect(plan).toEqual({ add: ['c'], remove: ['a'] });
  });

  it('only removes holders the policy allows', () => {
    const plan = planRoleReconcile({ holders: ['manual', 'disabled', 'x'], desired: ['x'], removable: (id) => id === 'disabled' });
    expect(plan).toEqual({ add: [], remove: ['disabled'] });
  });

  it('is a no-op when everything already matches', () => {
    expect(planRoleReconcile({ holders: ['a'], desired: ['a'], members: null })).toEqual({ add: [], remove: [] });
  });
});

describe('isElevatedPermissions', () => {
  it('flags moderation/admin power and ignores ordinary member permissions', () => {
    expect(isElevatedPermissions(0n)).toBe(false);
    expect(isElevatedPermissions(PermissionFlagsBits.SendMessages | PermissionFlagsBits.AttachFiles | PermissionFlagsBits.EmbedLinks)).toBe(false);
    for (const flag of [
      PermissionFlagsBits.Administrator,
      PermissionFlagsBits.ManageGuild,
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.ManageWebhooks,
      PermissionFlagsBits.BanMembers,
      PermissionFlagsBits.KickMembers,
      PermissionFlagsBits.ModerateMembers,
      PermissionFlagsBits.MentionEveryone,
    ]) {
      expect(isElevatedPermissions(flag | PermissionFlagsBits.SendMessages)).toBe(true);
    }
  });
});
