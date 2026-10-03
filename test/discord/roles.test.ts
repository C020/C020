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
    await expect(roles.setLive(GUILD, B, true, 'x')).resolves.toBeUndefined();
    repos.settings.update(GUILD, { liveRoleId: null });
    await expect(roles.setLive(GUILD, B, true, 'x')).resolves.toBeUndefined();
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
    await expect(roles.setLive(GUILD, A, true, 'x')).resolves.toBeUndefined();
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
  it('makes roles match: live role exactly, streamer role add-only except known disabled streamers', async () => {
    const { roles, guild, repos, liveRole, streamerRole, membersFetch } = setup();
    repos.streamers.create({ guildId: GUILD, discordUserId: DISABLED, displayName: 'موقوف', enabled: false });
    const a = guild.addMember(A, 'a', { roles: [liveRole] });
    const b = guild.addMember(B, 'b', { cached: false });
    const x = guild.addMember(X, 'x', { roles: [liveRole] });
    const manual = guild.addMember(MANUAL, 'manual', { roles: [streamerRole] });
    const disabled = guild.addMember(DISABLED, 'disabled', { roles: [streamerRole] });

    const result = await roles.reconcile(GUILD, new Set([A, B]), new Set([A, B]));
    expect(a.roles.cache.has(LIVE_ROLE)).toBe(true);
    expect(b.roles.cache.has(LIVE_ROLE)).toBe(true);
    expect(x.roles.cache.has(LIVE_ROLE)).toBe(false);
    expect(a.roles.cache.has(STREAMER_ROLE)).toBe(true);
    expect(b.roles.cache.has(STREAMER_ROLE)).toBe(true);
    expect(manual.roles.cache.has(STREAMER_ROLE)).toBe(true);
    expect(disabled.roles.cache.has(STREAMER_ROLE)).toBe(false);
    // live: +b −x, streamer: +a +b −disabled
    expect(result).toEqual({ added: 3, removed: 2 });
    expect(membersFetch).toEqual([true]);
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
