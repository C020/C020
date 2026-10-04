import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { DiscordRoles } from '../../src/discord/roles.js';
import { ValidationError } from '../../src/core/errors.js';
import { db, GUILD } from './helpers.js';
import { FakeClient, FakeGuild, membersTimeoutError } from './fakeDiscord.js';

const LIVE_ROLE = '700000000000000002';
const STREAMER_ROLE = '700000000000000001';
const BOT_ROLE = '700000000000000009';
const A = '200000000000000001';
const B = '200000000000000002';
const X = '200000000000000003';
const MANUAL = '200000000000000004';
const DISABLED = '200000000000000005';

function setup(opts: { botPosition?: number; manageRoles?: boolean } = {}) {
  const { repos, audit } = db();
  const client = new FakeClient();
  const guild = client.addGuild(new FakeGuild(GUILD));
  const streamerRole = guild.addRole(STREAMER_ROLE, 'Streamer', 5);
  const liveRole = guild.addRole(LIVE_ROLE, 'Streaming Now', 6);
  const botRole = guild.addRole(BOT_ROLE, 'StreamBot', opts.botPosition ?? 10);
  guild.addBot('800000000000000000', [botRole], opts.manageRoles === false ? [] : [PermissionFlagsBits.ManageRoles]);
  repos.settings.update(GUILD, { liveRoleId: LIVE_ROLE, streamerRoleId: STREAMER_ROLE });
  const membersFetch: boolean[] = [];
  const roles = new DiscordRoles({ getClient: () => client.asClient(), repos, audit, onMembersFetch: (_g, ok) => membersFetch.push(ok) });
  const warnings = () => repos.audit.list({ guildId: GUILD }).filter((e) => e.action === 'discord.roles');
  const roleLog = () => repos.audit.list({ guildId: GUILD }).filter((e) => e.action.startsWith('role.'));
  return { repos, client, guild, roles, streamerRole, liveRole, warnings, roleLog, membersFetch };
}

describe('DiscordRoles.setLive / setStreamer', () => {
  it('adds and removes the role with an audit-log reason', async () => {
    const { roles, guild, roleLog } = setup();
    const member = guild.addMember(A, 'فهد');
    await roles.setLive(GUILD, A, true, 'بدأ البث');
    expect(member.roles.cache.has(LIVE_ROLE)).toBe(true);
    expect(member.roleCalls).toEqual([{ op: 'add', roleId: LIVE_ROLE, reason: 'بدأ البث' }]);
    await roles.setLive(GUILD, A, true, 'again');
    expect(member.roleCalls).toHaveLength(1);
    await roles.setLive(GUILD, A, false, 'انتهى البث');
    expect(member.roles.cache.has(LIVE_ROLE)).toBe(false);
    expect(roleLog().map((e) => e.action).sort()).toEqual(['role.add', 'role.remove']);
    expect(roleLog().find((e) => e.action === 'role.add')!.message).toBe('تم إعطاء رتبة Streaming Now لـ فهد (بدأ البث)');
  });

  it('fetches members that are not cached yet', async () => {
    const { roles, guild } = setup();
    const member = guild.addMember(A, 'فهد', { cached: false });
    await roles.setStreamer(GUILD, A, true, 'تسجيل');
    expect(member.roles.cache.has(STREAMER_ROLE)).toBe(true);
  });

  it('skips silently when the role is not configured or the member left', async () => {
    const { roles, repos, warnings } = setup();
    await expect(roles.setLive(GUILD, B, true, 'x')).resolves.toBe('noop');
    repos.settings.update(GUILD, { liveRoleId: null });
    await expect(roles.setLive(GUILD, B, true, 'x')).resolves.toBe('noop');
    expect(warnings()).toHaveLength(0);
  });

  it('warns once (in Arabic) when the role is above the bot', async () => {
    const { roles, guild, warnings } = setup({ botPosition: 4 });
    const member = guild.addMember(A, 'فهد');
    await roles.setLive(GUILD, A, true, 'x');
    await roles.setLive(GUILD, A, true, 'x');
    expect(member.roleCalls).toHaveLength(0);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]!.message).toContain('رتبة البوت لازم تكون فوق رتبة Streaming Now');
  });

  it('warns when the bot lacks Manage Roles or the role was deleted', async () => {
    const { roles, guild, warnings, repos } = setup({ manageRoles: false });
    guild.addMember(A, 'فهد');
    await roles.setLive(GUILD, A, true, 'x');
    expect(warnings()[0]!.message).toContain('Manage Roles');
    repos.settings.update(GUILD, { liveRoleId: '799999999999999999' });
    await roles.setLive(GUILD, A, true, 'x');
    expect(warnings()[0]!.message).toContain('غير موجودة');
  });

  it('turns a Discord 403 into a warning instead of throwing', async () => {
    const { roles, guild, warnings } = setup();
    const member = guild.addMember(A, 'فهد');
    member.failNext = { code: 50013 };
    await expect(roles.setLive(GUILD, A, true, 'x')).resolves.toBe('config');
    expect(warnings()[0]!.message).toContain('ديسكورد رفض تعديل رتبة Streaming Now');
  });

  it('does nothing while Discord is not ready', async () => {
    const { roles, guild, client } = setup();
    const member = guild.addMember(A, 'فهد');
    client.ready = false;
    await roles.setLive(GUILD, A, true, 'x');
    expect(member.roleCalls).toHaveLength(0);
  });

  it('serializes changes per guild so the last request wins', async () => {
    const { roles, guild } = setup();
    const member = guild.addMember(A, 'فهد');
    await Promise.all([roles.setLive(GUILD, A, true, 'on'), roles.setLive(GUILD, A, false, 'off'), roles.setLive(GUILD, A, true, 'on again')]);
    expect(member.roleCalls.map((c) => c.op)).toEqual(['add', 'remove', 'add']);
    expect(member.roles.cache.has(LIVE_ROLE)).toBe(true);
  });
});

describe('DiscordRoles.reconcile', () => {
  it('makes roles match: live role for registered streamers, streamer role add-only except known disabled streamers', async () => {
    const { roles, guild, repos, liveRole, streamerRole, membersFetch } = setup();
    repos.streamers.create({ guildId: GUILD, discordUserId: X, displayName: 'مو لايف' });
    repos.streamers.create({ guildId: GUILD, discordUserId: DISABLED, displayName: 'موقوف', enabled: false });
    const a = guild.addMember(A, 'a', { roles: [liveRole] });
    const b = guild.addMember(B, 'b', { cached: false });
    const x = guild.addMember(X, 'x', { roles: [liveRole] });
    const manual = guild.addMember(MANUAL, 'manual', { roles: [streamerRole, liveRole] });
    const disabled = guild.addMember(DISABLED, 'disabled', { roles: [streamerRole] });

    const result = await roles.reconcile(GUILD, new Set([A, B]), new Set([A, B]));
    expect(a.roles.cache.has(LIVE_ROLE)).toBe(true);
    expect(b.roles.cache.has(LIVE_ROLE)).toBe(true);
    expect(x.roles.cache.has(LIVE_ROLE)).toBe(false);
    // Not a registered streamer: the bot never gave them the live role, so it never takes it.
    expect(manual.roles.cache.has(LIVE_ROLE)).toBe(true);
    expect(a.roles.cache.has(STREAMER_ROLE)).toBe(true);
    expect(b.roles.cache.has(STREAMER_ROLE)).toBe(true);
    expect(manual.roles.cache.has(STREAMER_ROLE)).toBe(true);
    expect(disabled.roles.cache.has(STREAMER_ROLE)).toBe(false);
    // live: +b −x, streamer: +a +b −disabled
    expect(result).toEqual({ added: 3, removed: 2 });
    expect(membersFetch).toEqual([true]);
  });

  it('never strips an existing, widely held role picked as Streaming Now from members who are not streamers', async () => {
    const { roles, guild, repos, roleLog } = setup();
    const membersRole = guild.addRole('700000000000000005', 'Members', 3);
    repos.settings.update(GUILD, { liveRoleId: membersRole.id });
    repos.streamers.create({ guildId: GUILD, discordUserId: A, displayName: 'ستريمر' });
    const a = guild.addMember(A, 'a', { roles: [membersRole] });
    const others = [B, X, MANUAL, DISABLED].map((id, i) => guild.addMember(id, `m${i}`, { roles: [membersRole] }));

    const result = await roles.reconcile(GUILD, new Set(), new Set([A]));
    for (const m of others) {
      expect(m.roles.cache.has(membersRole.id)).toBe(true);
      expect(m.roleCalls).toHaveLength(0);
    }
    // The registered streamer is not live, so the bot-managed live role is still taken from them.
    expect(a.roles.cache.has(membersRole.id)).toBe(false);
    expect(result.removed).toBe(1);
    expect(roleLog().filter((e) => e.action === 'role.remove')).toHaveLength(1);
  });

  it('leaves the streamer role alone when auto assignment is off', async () => {
    const { roles, guild, repos } = setup();
    repos.settings.update(GUILD, { options: { autoStreamerRole: false } });
    const a = guild.addMember(A, 'a');
    const result = await roles.reconcile(GUILD, new Set(), new Set([A]));
    expect(a.roles.cache.has(STREAMER_ROLE)).toBe(false);
    expect(result).toEqual({ added: 0, removed: 0 });
  });

  it('falls back to targeted fetches when the member list times out (members intent off)', async () => {
    const { roles, guild, membersFetch } = setup();
    guild.membersFetchError = membersTimeoutError();
    const b = guild.addMember(B, 'b', { cached: false });
    const result = await roles.reconcile(GUILD, new Set([B]), new Set());
    expect(b.roles.cache.has(LIVE_ROLE)).toBe(true);
    expect(result.added).toBe(1);
    expect(membersFetch).toEqual([false]);
  });

  it('skips a role the bot cannot manage but still reconciles the other one', async () => {
    const { roles, guild, warnings } = setup({ botPosition: 6 });
    // Bot role at 6 ties with Streaming Now (older id wins → bot role is newer, so it ranks lower).
    const a = guild.addMember(A, 'a');
    const result = await roles.reconcile(GUILD, new Set([A]), new Set([A]));
    expect(a.roles.cache.has(LIVE_ROLE)).toBe(false);
    expect(a.roles.cache.has(STREAMER_ROLE)).toBe(true);
    expect(result).toEqual({ added: 1, removed: 0 });
    expect(warnings()).toHaveLength(1);
  });

  it('does not flap when Streamer and Streaming Now are the same role', async () => {
    const { roles, guild, repos, liveRole } = setup();
    repos.settings.update(GUILD, { streamerRoleId: LIVE_ROLE });
    repos.streamers.create({ guildId: GUILD, discordUserId: A, displayName: 'a' });
    const a = guild.addMember(A, 'a', { roles: [liveRole] });
    const result = await roles.reconcile(GUILD, new Set(), new Set([A]));
    expect(a.roleCalls.map((c) => c.op)).toEqual(['remove']);
    expect(result).toEqual({ added: 0, removed: 1 });
  });

  it('reports guild-level problems as Arabic validation errors', async () => {
    const { roles, client } = setup();
    await expect(roles.reconcile('999999999999999999', new Set(), new Set())).rejects.toThrow(ValidationError);
    client.ready = false;
    await expect(roles.reconcile(GUILD, new Set(), new Set())).rejects.toThrow('غير متصل');
  });
});

describe('DiscordRoles outcomes (setLive / setStreamer report what happened)', () => {
  const restError = (status: number) => Object.assign(new Error('Service Unavailable'), { status });

  it('reports applied, then noop when the member already has the wanted state', async () => {
    const { roles, guild } = setup();
    guild.addMember(A, 'فهد');
    await expect(roles.setLive(GUILD, A, true, 'on')).resolves.toBe('applied');
    await expect(roles.setLive(GUILD, A, true, 'on')).resolves.toBe('noop');
    await expect(roles.setStreamer(GUILD, A, true, 'reg')).resolves.toBe('applied');
    await expect(roles.setLive(GUILD, A, false, 'off')).resolves.toBe('applied');
  });

  it('reports transient when Discord is not ready', async () => {
    const { roles, guild, client } = setup();
    guild.addMember(A, 'فهد');
    client.ready = false;
    await expect(roles.setLive(GUILD, A, false, 'x')).resolves.toBe('transient');
  });

  it('reports transient (not silently dropped) when the REST call fails with a 5xx/network error', async () => {
    const { roles, guild, liveRole, warnings } = setup();
    const member = guild.addMember(A, 'فهد', { roles: [liveRole] });
    member.failNext = restError(503) as unknown as { code: number };
    await expect(roles.setLive(GUILD, A, false, 'انتهى البث')).resolves.toBe('transient');
    expect(member.roles.cache.has(LIVE_ROLE)).toBe(true);
    expect(warnings()).toHaveLength(0);
    // A retry once Discord recovers applies it.
    await expect(roles.setLive(GUILD, A, false, 'انتهى البث')).resolves.toBe('applied');
    expect(member.roles.cache.has(LIVE_ROLE)).toBe(false);
  });

  it('reports transient when the member lookup fails for another reason than Unknown Member', async () => {
    const { roles, guild } = setup();
    guild.addMember(A, 'فهد', { cached: false });
    const fetch = guild.members.fetch;
    guild.members.fetch = async (id?: string) => {
      if (id !== undefined) throw restError(502);
      return fetch(id);
    };
    await expect(roles.setLive(GUILD, A, true, 'x')).resolves.toBe('transient');
  });

  it('reports transient when the role lookup itself fails', async () => {
    const { roles, guild, repos } = setup();
    guild.addMember(A, 'فهد');
    repos.settings.update(GUILD, { liveRoleId: '799999999999999999' });
    guild.roles.fetch = async () => {
      throw restError(500);
    };
    await expect(roles.setLive(GUILD, A, true, 'x')).resolves.toBe('transient');
  });

  it('reports transient while the guild is unavailable (outage)', async () => {
    const { roles, guild } = setup();
    guild.addMember(A, 'فهد');
    guild.available = false;
    await expect(roles.setLive(GUILD, A, true, 'x')).resolves.toBe('transient');
  });

  it('reports config for problems an admin has to fix', async () => {
    const above = setup({ botPosition: 4 });
    above.guild.addMember(A, 'فهد');
    await expect(above.roles.setLive(GUILD, A, true, 'x')).resolves.toBe('config');

    const missing = setup();
    missing.guild.addMember(A, 'فهد');
    missing.repos.settings.update(GUILD, { liveRoleId: '799999999999999999' });
    await expect(missing.roles.setLive(GUILD, A, true, 'x')).resolves.toBe('config');

    const notInGuild = setup();
    notInGuild.repos.settings.update('999999999999999999', { liveRoleId: LIVE_ROLE });
    await expect(notInGuild.roles.setLive('999999999999999999', A, true, 'x')).resolves.toBe('config');

    const deletedMidway = setup();
    const member = deletedMidway.guild.addMember(A, 'فهد');
    member.failNext = { code: 10011 };
    await expect(deletedMidway.roles.setLive(GUILD, A, true, 'x')).resolves.toBe('config');
  });

  it('reports noop when the member is not in the guild', async () => {
    const { roles } = setup();
    await expect(roles.setLive(GUILD, B, false, 'x')).resolves.toBe('noop');
  });

  it('counts only applied changes in reconcile', async () => {
    const { roles, guild } = setup();
    const a = guild.addMember(A, 'a');
    a.failNext = restError(503) as unknown as { code: number };
    const result = await roles.reconcile(GUILD, new Set([A]), new Set());
    expect(result.added).toBe(0);
  });
});

describe('DiscordRoles.removeRoleFrom', () => {
  const OLD_ROLE = '700000000000000003';

  it('takes an old role back from the given members who hold it and skips the others', async () => {
    const { roles, guild, roleLog } = setup();
    const oldRole = guild.addRole(OLD_ROLE, 'Old Live', 4);
    const a = guild.addMember(A, 'a', { roles: [oldRole] });
    const b = guild.addMember(B, 'b');
    const x = guild.addMember(X, 'x', { roles: [oldRole], cached: false });
    const manual = guild.addMember(MANUAL, 'manual', { roles: [oldRole] });

    await expect(roles.removeRoleFrom(GUILD, OLD_ROLE, [A, B, X, A], 'تغيّرت رتبة البث المباشر')).resolves.toBeUndefined();
    expect(a.roles.cache.has(OLD_ROLE)).toBe(false);
    expect(x.roles.cache.has(OLD_ROLE)).toBe(false);
    expect(a.roleCalls).toEqual([{ op: 'remove', roleId: OLD_ROLE, reason: 'تغيّرت رتبة البث المباشر' }]);
    expect(b.roleCalls).toHaveLength(0);
    // Not in the list: untouched.
    expect(manual.roles.cache.has(OLD_ROLE)).toBe(true);
    expect(roleLog().filter((e) => e.action === 'role.remove')).toHaveLength(2);
  });

  it('runs on the guild queue, after role changes queued before it', async () => {
    const { roles, guild } = setup();
    const oldRole = guild.addRole(OLD_ROLE, 'Old Live', 4);
    const a = guild.addMember(A, 'a');
    // Give the old role through the queue first (simulates a change still in flight on the same guild).
    const pending = roles.setStreamer(GUILD, A, true, 'x');
    a.roles.cache.set(oldRole.id, oldRole);
    await Promise.all([pending, roles.removeRoleFrom(GUILD, OLD_ROLE, [A], 'cleanup')]);
    expect(a.roleCalls.map((c) => `${c.op}:${c.roleId}`)).toEqual([`add:${STREAMER_ROLE}`, `remove:${OLD_ROLE}`]);
  });

  it('never throws: deleted role, not ready, bot not in guild, Discord errors', async () => {
    const { roles, guild, client, warnings } = setup();
    const oldRole = guild.addRole(OLD_ROLE, 'Old Live', 4);
    const a = guild.addMember(A, 'a', { roles: [oldRole] });

    await expect(roles.removeRoleFrom(GUILD, '799999999999999999', [A], 'x')).resolves.toBeUndefined();
    await expect(roles.removeRoleFrom('999999999999999999', OLD_ROLE, [A], 'x')).resolves.toBeUndefined();
    await expect(roles.removeRoleFrom(GUILD, OLD_ROLE, [], 'x')).resolves.toBeUndefined();
    a.failNext = { code: 50013 };
    await expect(roles.removeRoleFrom(GUILD, OLD_ROLE, [A], 'x')).resolves.toBeUndefined();
    expect(warnings()).toHaveLength(1);
    client.ready = false;
    await expect(roles.removeRoleFrom(GUILD, OLD_ROLE, [A], 'x')).resolves.toBeUndefined();
    guild.members.fetch = async () => {
      throw new Error('boom');
    };
    client.ready = true;
    guild.members.cache.delete(A);
    await expect(roles.removeRoleFrom(GUILD, OLD_ROLE, [A], 'x')).resolves.toBeUndefined();
  });

  it('does not try to remove a role the bot cannot manage, and warns once', async () => {
    const { roles, guild, warnings } = setup({ botPosition: 4 });
    const oldRole = guild.addRole(OLD_ROLE, 'Old Live', 5);
    const a = guild.addMember(A, 'a', { roles: [oldRole] });
    await roles.removeRoleFrom(GUILD, OLD_ROLE, [A], 'x');
    expect(a.roleCalls).toHaveLength(0);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]!.message).toContain('Old Live');
  });
});

describe('DiscordRoles.removeRoleFrom (settings changed back)', () => {
  it('leaves a role alone that is configured again by the time the cleanup runs', async () => {
    const { roles, guild, liveRole, streamerRole } = setup();
    const a = guild.addMember(A, 'a', { roles: [liveRole, streamerRole] });
    await roles.removeRoleFrom(GUILD, LIVE_ROLE, [A], 'x');
    await roles.removeRoleFrom(GUILD, STREAMER_ROLE, [A], 'x');
    expect(a.roleCalls).toHaveLength(0);
  });
});
