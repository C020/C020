/**
 * Role settings safety rails: only users with Manage Roles (or owner/Administrator/ADMIN_USER_IDS) may pick the roles
 * the bot hands out, roles with moderation/admin permissions are rejected, and the previous "Streaming Now" role is
 * taken back from streamers when it changes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscordRoleInfo } from '../../src/services/ports.js';
import { canManageGuild, canManageRoles, PERMISSION_MANAGE_ROLES } from '../../src/web/permissions.js';
import type { WebServer } from '../../src/web/server.js';
import { ADMIN, createEnv, GUILD, login, manageable, MEMBER, ROLE_A, ROLE_B, startServer, type TestEnv } from './helpers.js';

const ROLE_MOD = '777777777777777773';
const ROLE_C = '777777777777777774';
const MANAGE_GUILD = 0x20n;
const ADMINISTRATOR = 0x8n;
const base = `/api/guilds/${GUILD}`;

let server: WebServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const role = (id: string, name: string, extra: Partial<DiscordRoleInfo> = {}): DiscordRoleInfo => ({
  id,
  name,
  color: 0,
  position: 2,
  managed: false,
  assignable: true,
  permissions: '0',
  elevated: false,
  ...extra,
});

function env(): { env: TestEnv; removeRoleFrom: ReturnType<typeof vi.fn> } {
  const e = createEnv();
  const roles: DiscordRoleInfo[] = [
    role(ROLE_A, 'Streamer'),
    role(ROLE_B, 'Live'),
    role(ROLE_C, 'Live 2'),
    role(ROLE_MOD, 'Moderator', { permissions: String(1n << 2n), elevated: true }),
  ];
  e.discord.roleList = roles;
  const removeRoleFrom = vi.fn(async (_guildId: string, _roleId: string, _userIds: string[], _reason: string) => {});
  Object.assign(e.discord, { removeRoleFrom });
  return { env: e, removeRoleFrom };
}

const perms = (bits: bigint) => String(bits);
/** Passes the dashboard's Manage Server gate, but has no Manage Roles. */
const manageServerOnly = (e: TestEnv) => login(e, undefined, [manageable(GUILD, { owner: false, permissions: perms(MANAGE_GUILD) })]);

async function put(e: TestEnv, headers: Record<string, string>, payload: object) {
  server ??= await startServer(e);
  return server.app.inject({ method: 'PUT', url: `${base}/settings`, headers, payload });
}

describe('permissions helpers', () => {
  it('canManageRoles: owner, Administrator or Manage Roles; Manage Server alone is not enough', () => {
    expect(canManageRoles({ owner: true, permissions: '0' })).toBe(true);
    expect(canManageRoles({ owner: false, permissions: perms(ADMINISTRATOR) })).toBe(true);
    expect(canManageRoles({ owner: false, permissions: perms(PERMISSION_MANAGE_ROLES) })).toBe(true);
    expect(canManageRoles({ owner: false, permissions: perms(MANAGE_GUILD) })).toBe(false);
    expect(canManageGuild({ owner: false, permissions: perms(MANAGE_GUILD) })).toBe(true);
    expect(PERMISSION_MANAGE_ROLES).toBe(0x10000000n);
  });
});

describe('PUT /settings role fields need Manage Roles', () => {
  it('rejects a Manage Server-only user changing the live or streamer role (403, Arabic, nothing saved or synced)', async () => {
    const { env: e, removeRoleFrom } = env();
    const auth = manageServerOnly(e);
    for (const [field, value] of [
      ['liveRoleId', ROLE_B],
      ['streamerRoleId', ROLE_A],
    ] as const) {
      const res = await put(e, auth.headers, { [field]: value });
      expect(res.statusCode, field).toBe(403);
      expect(res.json()).toMatchObject({ error: 'forbidden', field });
      expect(res.json().message).toContain('Manage Roles');
      expect(res.json().message).toMatch(/[؀-ۿ]/);
    }
    e.repos.settings.update(GUILD, { liveRoleId: ROLE_B });
    const clear = await put(e, auth.headers, { liveRoleId: null });
    expect(clear.statusCode).toBe(403);

    expect(e.repos.settings.get(GUILD)).toMatchObject({ liveRoleId: ROLE_B, streamerRoleId: null });
    expect(e.sessions.syncRoles).not.toHaveBeenCalled();
    expect(removeRoleFrom).not.toHaveBeenCalled();
    expect(e.repos.audit.list({ guildId: GUILD, actionPrefix: 'settings.' })).toHaveLength(0);
  });

  it('still lets a Manage Server-only user change everything else (and resend the same role ids)', async () => {
    const { env: e } = env();
    e.repos.settings.update(GUILD, { liveRoleId: ROLE_B });
    const auth = manageServerOnly(e);
    const res = await put(e, auth.headers, { liveRoleId: ROLE_B, pingMode: 'everyone', options: { summaryEnabled: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ liveRoleId: ROLE_B, pingMode: 'everyone' });
  });

  it.each([
    ['Manage Roles', manageable(GUILD, { permissions: perms(MANAGE_GUILD | PERMISSION_MANAGE_ROLES) })],
    ['Administrator', manageable(GUILD, { permissions: perms(ADMINISTRATOR) })],
    ['the owner', manageable(GUILD, { owner: true, permissions: '0' })],
  ])('allows %s', async (_label, guild) => {
    const { env: e } = env();
    const auth = login(e, MEMBER, [guild]);
    const res = await put(e, auth.headers, { liveRoleId: ROLE_B, streamerRoleId: ROLE_A });
    expect(res.statusCode).toBe(200);
    expect(e.sessions.syncRoles).toHaveBeenCalledTimes(1);
  });

  it('allows ADMIN_USER_IDS without any guild permission', async () => {
    const { env: e } = env();
    const auth = login(e, ADMIN, []);
    const res = await put(e, auth.headers, { liveRoleId: ROLE_B });
    expect(res.statusCode).toBe(200);
  });
});

describe('PUT /settings rejects roles with moderation/admin permissions', () => {
  const owner = (e: TestEnv) => login(e, MEMBER, [manageable(GUILD, { owner: true })]);

  it.each(['liveRoleId', 'streamerRoleId'] as const)('rejects an elevated role as %s with an Arabic explanation', async (field) => {
    const { env: e } = env();
    const res = await put(e, owner(e).headers, { [field]: ROLE_MOD });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation', field });
    expect(res.json().message).toContain('Moderator');
    expect(res.json().message).toContain('صلاحيات إدارية');
    expect(e.repos.settings.get(GUILD)[field]).toBeNull();
  });

  it('accepts an elevated role as the ping role (the bot only mentions it)', async () => {
    const { env: e } = env();
    const res = await put(e, owner(e).headers, { pingMode: 'role', pingRoleId: ROLE_MOD });
    expect(res.statusCode).toBe(200);
  });
});

describe('PUT /settings takes the previous live role back', () => {
  const owner = (e: TestEnv) => login(e, MEMBER, [manageable(GUILD, { owner: true })]);
  const S1 = '600000000000000001';
  const S2 = '600000000000000002';

  function withStreamers(e: TestEnv): void {
    e.repos.settings.update(GUILD, { liveRoleId: ROLE_B, streamerRoleId: ROLE_A });
    e.repos.streamers.create({ guildId: GUILD, discordUserId: S1, displayName: 'one' });
    e.repos.streamers.create({ guildId: GUILD, discordUserId: S2, displayName: 'two', enabled: false });
    e.repos.streamers.create({ guildId: '999999999999999999', discordUserId: '600000000000000003', displayName: 'other guild' });
  }

  it('when the live role changes', async () => {
    const { env: e, removeRoleFrom } = env();
    withStreamers(e);
    const res = await put(e, owner(e).headers, { liveRoleId: ROLE_C });
    expect(res.statusCode).toBe(200);
    expect(removeRoleFrom).toHaveBeenCalledTimes(1);
    const [guildId, roleId, userIds, reason] = removeRoleFrom.mock.calls[0]!;
    expect(guildId).toBe(GUILD);
    expect(roleId).toBe(ROLE_B);
    expect([...userIds].sort()).toEqual([S1, S2]);
    expect(reason).toMatch(/[؀-ۿ]/);
    expect(e.sessions.syncRoles).toHaveBeenCalledTimes(1);
  });

  it('when the live role is cleared (even with no role left to sync)', async () => {
    const { env: e, removeRoleFrom } = env();
    withStreamers(e);
    e.repos.settings.update(GUILD, { streamerRoleId: null });
    const res = await put(e, owner(e).headers, { liveRoleId: null });
    expect(res.statusCode).toBe(200);
    expect(removeRoleFrom).toHaveBeenCalledWith(GUILD, ROLE_B, expect.arrayContaining([S1, S2]), expect.any(String));
    expect(e.sessions.syncRoles).not.toHaveBeenCalled();
  });

  it('not when the old live role becomes the streamer role, nor when the live role is unchanged', async () => {
    const { env: e, removeRoleFrom } = env();
    withStreamers(e);
    const swap = await put(e, owner(e).headers, { liveRoleId: ROLE_C, streamerRoleId: ROLE_B });
    expect(swap.statusCode).toBe(200);
    const same = await put(e, owner(e).headers, { pingMode: 'everyone' });
    expect(same.statusCode).toBe(200);
    expect(removeRoleFrom).not.toHaveBeenCalled();
  });

  it('a failing cleanup never fails the request', async () => {
    const { env: e, removeRoleFrom } = env();
    withStreamers(e);
    removeRoleFrom.mockRejectedValueOnce(new Error('discord down'));
    const res = await put(e, owner(e).headers, { liveRoleId: ROLE_C });
    expect(res.statusCode).toBe(200);
    expect(e.repos.settings.get(GUILD).liveRoleId).toBe(ROLE_C);
  });
});
