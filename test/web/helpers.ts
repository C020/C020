/** Fake AppContext for web tests: real in-memory DB + event bus + audit, stub services. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type {
  AppContext,
  DiscordApi,
  MonitorApi,
  ProviderRegistryApi,
  ProviderRuntimeStatus,
  SessionServiceApi,
  StreamerServiceApi,
} from '../../src/app/context.js';
import type { AppConfig } from '../../src/config.js';
import { ValidationError } from '../../src/core/errors.js';
import { AppEvents } from '../../src/core/events.js';
import type { Platform, ResolvedChannel } from '../../src/core/types.js';
import { PLATFORMS } from '../../src/core/types.js';
import { openDatabase } from '../../src/db/database.js';
import type { StreamerWithAccounts, WebSessionGuild } from '../../src/db/models.js';
import { Repositories } from '../../src/db/repositories.js';
import type { PlatformProvider, WebhookAdapter } from '../../src/platforms/types.js';
import { AuditService } from '../../src/services/audit.js';
import type { DiscordGuildInfo, DiscordMemberInfo, MessageRef } from '../../src/services/ports.js';
import { csrfTokenFor, randomToken, sessionIdFromToken } from '../../src/web/csrf.js';
import { createWebServer, type WebServer } from '../../src/web/server.js';
import type { WebServerOptions } from '../../src/web/types.js';

export const SECRET = 'test-session-secret-0123456789abcdef';
export const GUILD = '111111111111111111';
export const OTHER_GUILD = '222222222222222222';
export const NO_BOT_GUILD = '333333333333333333';
export const USER = '444444444444444444';
export const ADMIN = '555555555555555555';
export const MEMBER = '666666666666666666';
export const ROLE_A = '777777777777777771';
export const ROLE_B = '777777777777777772';
export const CHANNEL_A = '888888888888888881';

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    NODE_ENV: 'test',
    DISCORD_TOKEN: 'token',
    DISCORD_CLIENT_ID: '999999999999999999',
    DISCORD_CLIENT_SECRET: 'client-secret',
    DISCORD_GUILD_ID: undefined,
    PORT: 0,
    HOST: '127.0.0.1',
    PUBLIC_URL: 'https://bot.example.com',
    SESSION_SECRET: SECRET,
    ADMIN_USER_IDS: [ADMIN],
    DATABASE_PATH: ':memory:',
    TWITCH_CLIENT_ID: undefined,
    TWITCH_CLIENT_SECRET: undefined,
    TWITCH_EVENTSUB_SECRET: undefined,
    KICK_CLIENT_ID: undefined,
    KICK_CLIENT_SECRET: undefined,
    KICK_UNOFFICIAL_CONTENT: false,
    YOUTUBE_API_KEY: undefined,
    YOUTUBE_WEBSUB_SECRET: undefined,
    TIKTOK_SIGN_API_KEY: undefined,
    RSSHUB_URL: undefined,
    POLL_TWITCH_LIVE: 60,
    POLL_KICK_LIVE: 60,
    POLL_YOUTUBE_LIVE: 120,
    POLL_TIKTOK_LIVE: 120,
    POLL_CONTENT: 300,
    POLL_TIKTOK_CONTENT: 900,
    OFFLINE_GRACE_SECONDS: 150,
    STALE_LIVE_MINUTES: 30,
    webhooksEnabled: true,
    dashboardEnabled: true,
    ...overrides,
  };
}

export class FakeDiscord implements DiscordApi {
  ready = true;
  readonly guildList: DiscordGuildInfo[] = [
    { id: GUILD, name: 'سيرفر الستريمرز', iconUrl: null, memberCount: 120 },
    { id: OTHER_GUILD, name: 'Other', iconUrl: null, memberCount: 5 },
  ];
  readonly members = new Map<string, DiscordMemberInfo>();
  roleList = [
    { id: ROLE_A, name: 'Streamer', color: 0, position: 2, managed: false, assignable: true },
    { id: ROLE_B, name: 'Live', color: 0, position: 3, managed: false, assignable: true },
  ];
  channelList = [{ id: CHANNEL_A, name: 'live', type: 'text' as const, parentName: null, botCanPost: true }];

  readonly sendTest = vi.fn(async (_guildId: string, _type: 'live' | 'summary' | 'content'): Promise<MessageRef | null> => ({
    channelId: CHANNEL_A,
    messageId: '123456789012345678',
  }));
  readonly preview = vi.fn(async () => ({ content: null, embeds: [{ title: 'معاينة' }], buttons: [] }));
  readonly fetchMember = vi.fn(async (guildId: string, userId: string) => this.members.get(`${guildId}:${userId}`) ?? null);

  addMember(guildId: string, id: string, displayName: string): void {
    this.members.set(`${guildId}:${id}`, {
      id,
      username: displayName.toLowerCase(),
      displayName,
      avatarUrl: `https://cdn.discordapp.com/avatars/${id}/a.png`,
      bot: false,
      roleIds: [],
    });
  }

  isReady() {
    return this.ready;
  }
  botUser() {
    return { id: '999999999999999999', username: 'StreamBot', avatarUrl: null };
  }
  guilds() {
    return this.guildList;
  }
  guild(guildId: string) {
    return this.guildList.find((g) => g.id === guildId) ?? null;
  }
  async roles() {
    return this.roleList;
  }
  async textChannels() {
    return this.channelList;
  }
  async diagnose(guildId: string) {
    return { guildId, botInGuild: true, botHasManageRoles: true, problems: [] };
  }
  async start() {}
  async stop() {}
  attachServices() {}
  messageUrl(guildId: string, ref: MessageRef) {
    return `https://discord.com/channels/${guildId}/${ref.channelId}/${ref.messageId}`;
  }
  inviteUrl() {
    return 'https://discord.com/oauth2/authorize?client_id=999999999999999999';
  }
  async postLive() {
    return null;
  }
  async updateLive() {
    return true;
  }
  async postSummary() {
    return null;
  }
  async postContent() {
    return null;
  }
  async log() {}
  async setLive() {}
  async setStreamer() {}
  async reconcile() {
    return { added: 0, removed: 0 };
  }
}

export class FakeMonitor implements MonitorApi {
  readonly handleHints = vi.fn();
  readonly channelsChanged = vi.fn();
  readonly checkNow = vi.fn();
  runtime: ProviderRuntimeStatus[] = [];
  start() {}
  async stop() {}
  status() {
    return this.runtime;
  }
}

/** Provider stub: configured flag + optional webhook adapter. */
export function fakeProvider(platform: Platform, opts: { configured?: boolean; webhook?: WebhookAdapter; notes?: string[] } = {}): PlatformProvider {
  return {
    platform,
    capabilities: { live: true, content: [], liveBatchSize: 100, push: !!opts.webhook },
    isConfigured: () => opts.configured ?? true,
    health: () => ({ configured: opts.configured ?? true, notes: opts.notes ?? [] }),
    resolveChannel: async () => {
      throw new Error('not used');
    },
    checkLive: async () => [],
    fetchRecentContent: async () => [],
    webhook: opts.webhook,
  };
}

export class FakeProviders implements ProviderRegistryApi {
  readonly map = new Map<Platform, PlatformProvider>();
  constructor(overrides: Partial<Record<Platform, PlatformProvider>> = {}) {
    for (const p of PLATFORMS) this.map.set(p, overrides[p] ?? fakeProvider(p));
  }
  get(platform: Platform) {
    return this.map.get(platform)!;
  }
  all() {
    return [...this.map.values()];
  }
  configured() {
    return this.all().filter((p) => p.isConfigured());
  }
  webhooks() {
    return this.configured()
      .filter((p) => p.webhook)
      .map((p) => ({ platform: p.platform, adapter: p.webhook! }));
  }
}

/** Streamer service stub backed by the real repositories so DTO mapping sees real rows. */
export function fakeStreamers(repos: Repositories) {
  const get = (guildId: string, id: number): StreamerWithAccounts => {
    const s = repos.streamerWithAccounts(id);
    if (!s || s.guildId !== guildId) throw new ValidationError('الستريمر غير موجود', 'streamerId');
    return s;
  };
  const service = {
    list: vi.fn((guildId: string) => repos.streamersWithAccounts(guildId)),
    get: vi.fn(get),
    create: vi.fn(async (guildId: string, req: { discordUserId: string; displayName?: string }) => {
      const s = repos.streamers.create({ guildId, discordUserId: req.discordUserId, displayName: req.displayName ?? 'Streamer' });
      return get(guildId, s.id);
    }),
    update: vi.fn(async (guildId: string, id: number, patch: { displayName?: string; enabled?: boolean }) => {
      repos.streamers.update(id, patch);
      return get(guildId, id);
    }),
    delete: vi.fn(async (_guildId: string, id: number) => repos.streamers.delete(id)),
    addAccount: vi.fn(async (guildId: string, id: number) => get(guildId, id)),
    updateAccount: vi.fn(async (guildId: string, id: number) => get(guildId, id)),
    removeAccount: vi.fn(async (guildId: string, id: number) => get(guildId, id)),
    resolve: vi.fn(
      async (platform: Platform, input: string): Promise<ResolvedChannel> => ({
        platform,
        platformId: `id-${input}`,
        handle: input,
        displayName: input.toUpperCase(),
        avatarUrl: null,
        url: `https://${platform}.example.com/${input}`,
        meta: { secret: 'not exposed' },
      }),
    ),
    checkNow: vi.fn(),
  };
  return service satisfies StreamerServiceApi;
}

export function fakeSessions() {
  const service = {
    onChannelLive: vi.fn(async () => {}),
    onChannelUpdate: vi.fn(async () => {}),
    onChannelOffline: vi.fn(async () => {}),
    start: vi.fn(),
    stop: vi.fn(),
    reconcile: vi.fn(async () => {}),
    syncRoles: vi.fn(async () => ({ added: 2, removed: 1 })),
    liveViews: vi.fn((): ReturnType<SessionServiceApi['liveViews']> => []),
    summaryOf: vi.fn((): ReturnType<SessionServiceApi['summaryOf']> => null),
    endStreamerSession: vi.fn(async () => {}),
  };
  return service satisfies SessionServiceApi;
}

export interface TestEnv {
  ctx: AppContext;
  repos: Repositories;
  events: AppEvents;
  discord: FakeDiscord;
  monitor: FakeMonitor;
  providers: FakeProviders;
  streamers: ReturnType<typeof fakeStreamers>;
  sessions: ReturnType<typeof fakeSessions>;
}

export function createEnv(config: Partial<AppConfig> = {}, providers = new FakeProviders()): TestEnv {
  const repos = new Repositories(openDatabase(':memory:'));
  const events = new AppEvents();
  const discord = new FakeDiscord();
  const monitor = new FakeMonitor();
  const streamers = fakeStreamers(repos);
  const sessions = fakeSessions();
  const ctx: AppContext = {
    config: makeConfig(config),
    version: '1.2.3',
    startedAt: Date.now() - 90_000,
    repos,
    events,
    audit: new AuditService(repos, events),
    providers,
    monitor,
    streamers,
    sessions,
    content: { onNewContent: async () => {} },
    discord,
  };
  return { ctx, repos, events, discord, monitor, providers, streamers, sessions };
}

/** A publicDir that does not contain a build (default for tests). */
export function emptyPublicDir(): string {
  return mkdtempSync(join(tmpdir(), 'sb-public-'));
}

export async function startServer(env: TestEnv, options: WebServerOptions = {}): Promise<WebServer> {
  const server = await createWebServer(env.ctx, { publicDir: emptyPublicDir(), ...options });
  await server.app.ready();
  return server;
}

export interface Login {
  token: string;
  sessionId: string;
  cookie: string;
  csrf: string;
  /** Headers for a mutating request. */
  headers: Record<string, string>;
}

export function manageable(id: string, opts: Partial<WebSessionGuild> = {}): WebSessionGuild {
  return { id, name: `guild ${id}`, icon: null, owner: false, permissions: String(0x20), ...opts };
}

/** Creates a dashboard session directly in the DB (bypassing OAuth). */
export function login(env: TestEnv, userId = USER, guilds: WebSessionGuild[] = [manageable(GUILD)], opts: { refreshedAt?: string } = {}): Login {
  const token = randomToken(32);
  const sessionId = sessionIdFromToken(token);
  env.repos.webSessions.create({
    id: sessionId,
    userId,
    username: 'tester',
    avatarUrl: null,
    guilds,
    guildsRefreshedAt: opts.refreshedAt ?? new Date().toISOString(),
    accessToken: 'discord-access-token',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const csrf = csrfTokenFor(SECRET, sessionId);
  const cookie = `sb_session=${token}`;
  return { token, sessionId, cookie, csrf, headers: { cookie, 'x-csrf-token': csrf } };
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
