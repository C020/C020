/**
 * A channel that goes from untracked to tracked again (kept in the DB for session history, or its streamer
 * re-enabled) must be baselined silently again instead of announcing what it uploaded while nobody tracked it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/logger.js', async () => {
  const { pino } = await import('pino');
  const logger = pino({ level: 'silent' });
  return { logger, childLogger: () => logger };
});

import type { SessionServiceApi } from '../../src/app/context.js';
import type { Platform, ResolvedChannel } from '../../src/core/types.js';
import type { Repositories } from '../../src/db/repositories.js';
import type { DiscordGateway, MonitorControl, RoleChangeOutcome, RoleManager } from '../../src/services/ports.js';
import { StreamerService } from '../../src/services/streamerService.js';
import { createHarness, FakeProvider, item, type Harness } from '../monitor/helpers.js';

const GUILD_A = '100000000000000001';
const GUILD_B = '100000000000000002';
const USER_A = '200000000000000001';
const USER_B = '200000000000000002';
const DAY = 86_400_000;
/** Same format as `seedKey` in src/monitor/monitor.ts. */
const seedKey = (channelId: number) => `monitor:content-seed:${channelId}`;

const rc = (platformId: string, handle = platformId): ResolvedChannel => ({
  platform: 'twitch',
  platformId,
  handle,
  displayName: handle.toUpperCase(),
  avatarUrl: null,
  url: `https://twitch.tv/${handle}`,
  meta: {},
});

/** Monitor test provider that can also resolve the accounts the dashboard registers. */
class ResolvingProvider extends FakeProvider {
  constructor(private readonly known: Map<string, ResolvedChannel>) {
    super('twitch');
  }
  override async resolveChannel(input?: string): Promise<ResolvedChannel> {
    const found = this.known.get(String(input).toLowerCase());
    if (!found) throw new Error(`unknown ${input}`);
    return found;
  }
}

class StubRoles implements RoleManager {
  async setLive(): Promise<RoleChangeOutcome> {
    return 'noop';
  }
  async setStreamer(): Promise<RoleChangeOutcome> {
    return 'noop';
  }
  async removeRoleFrom(): Promise<void> {}
  async reconcile() {
    return { added: 0, removed: 0 };
  }
}

class StubMonitor implements MonitorControl {
  readonly checks: number[] = [];
  channelsChanged(): void {}
  checkNow(channelId: number): void {
    this.checks.push(channelId);
  }
}

const offlineGateway = { isReady: () => false } as unknown as DiscordGateway;

function stubSessions(): SessionServiceApi {
  return {
    onChannelLive: async () => {},
    onChannelUpdate: async () => {},
    onChannelOffline: async () => {},
    start: () => {},
    stop: () => {},
    reconcile: async () => {},
    syncRoles: async () => ({ added: 0, removed: 0 }),
    liveViews: () => [],
    summaryOf: () => null,
    endStreamerSession: async () => {},
    reconcileLiveRoles: async () => {},
    setExtraLiveUsers: () => {},
  };
}

describe('StreamerService re-baselines content of channels that become tracked again', () => {
  let h: Harness;
  let twitch: ResolvingProvider;
  let svc: StreamerService;
  const channels = new Map<string, ResolvedChannel>();

  beforeEach(() => {
    twitch = new ResolvingProvider(channels);
    h = createHarness({ providers: [twitch] });
    channels.set('abu', rc('42', 'abu'));
    channels.set('other', rc('43', 'other'));
    channels.set('keep', rc('44', 'keep'));
    svc = new StreamerService({
      repos: h.repos,
      audit: h.audit,
      providers: h.registry,
      discord: offlineGateway,
      roles: new StubRoles(),
      sessions: stubSessions(),
      monitor: new StubMonitor(),
    });
  });

  afterEach(async () => {
    await h.monitor.stop();
  });

  const account = (input: string, platform: Platform = 'twitch') => ({ platform, input });

  /** Registers, seeds and gives the channel some live history, then removes the account (channel row kept). */
  async function trackedThenForgotten(input = 'abu'): Promise<number> {
    const created = await svc.create(GUILD_A, { discordUserId: USER_A, accounts: [account(input), account('keep')] }, 'user:1');
    const tracked = created.accounts.find((a) => a.channel.handle === input)!;
    const channelId = tracked.channelId;
    twitch.content.set(channels.get(input)!.platformId, [item('old', { publishedAt: new Date(Date.now() - 20 * DAY).toISOString() })]);
    await h.monitor.checkContent(channelId);
    expect(h.repos.channels.get(channelId)!.contentSeeded).toBe(true);
    addHistory(h.repos, created.id, channelId);
    await svc.removeAccount(GUILD_A, created.id, tracked.id, 'user:1');
    const kept = h.repos.channels.get(channelId);
    expect(kept?.contentSeeded).toBe(true);
    expect(h.repos.kv.get(seedKey(channelId))).toBeDefined();
    return channelId;
  }

  function uploadWhileUntracked(platformId = '42'): void {
    twitch.content.set(platformId, [
      item('old', { publishedAt: new Date(Date.now() - 20 * DAY).toISOString() }),
      item('u1', { publishedAt: new Date(Date.now() - 30 * 60_000).toISOString() }),
      item('u2', { publishedAt: new Date(Date.now() - 10 * 60_000).toISOString() }),
    ]);
  }

  it('create: a channel kept for session history is seeded silently again (no flood of old uploads)', async () => {
    const channelId = await trackedThenForgotten();
    uploadWhileUntracked();

    const b = await svc.create(GUILD_B, { discordUserId: USER_B, accounts: [account('abu')] }, 'user:2');
    expect(b.accounts[0]!.channelId).toBe(channelId);
    expect(h.repos.channels.get(channelId)!.contentSeeded).toBe(false);
    expect(h.repos.kv.get(seedKey(channelId))).toBeUndefined();

    await h.monitor.checkContent(channelId);
    expect(h.content.ids()).toEqual([]);
    expect(h.repos.channels.get(channelId)!.contentSeeded).toBe(true);

    // Later uploads are announced normally.
    twitch.content.set('42', [...(twitch.content.get('42') ?? []), item('u3')]);
    await h.monitor.checkContent(channelId);
    expect(h.content.ids()).toEqual(['u3']);
  });

  it('create/addAccount: a channel another enabled streamer still tracks keeps its baseline', async () => {
    const a = await svc.create(GUILD_A, { discordUserId: USER_A, accounts: [account('abu')] }, 'user:1');
    const channelId = a.accounts[0]!.channelId;
    twitch.content.set('42', [item('old')]);
    await h.monitor.checkContent(channelId);

    await svc.create(GUILD_B, { discordUserId: USER_B, accounts: [account('abu')] }, 'user:2');
    expect(h.repos.channels.get(channelId)!.contentSeeded).toBe(true);
    expect(h.repos.kv.get(seedKey(channelId))).toBeDefined();

    // A new upload is still announced (the baseline was not thrown away).
    twitch.content.set('42', [item('old'), item('fresh')]);
    await h.monitor.checkContent(channelId);
    expect(h.content.ids()).toEqual(['fresh']);
  });

  it('addAccount: re-adding a forgotten channel to an enabled streamer re-baselines it', async () => {
    const channelId = await trackedThenForgotten();
    uploadWhileUntracked();
    const b = await svc.create(GUILD_B, { discordUserId: USER_B, accounts: [account('other')] }, 'user:2');

    await svc.addAccount(GUILD_B, b.id, account('abu'), 'user:2');
    expect(h.repos.channels.get(channelId)!.contentSeeded).toBe(false);
    expect(h.repos.kv.get(seedKey(channelId))).toBeUndefined();
    await h.monitor.checkContent(channelId);
    expect(h.content.ids()).toEqual([]);
  });

  it('update: re-enabling a streamer re-baselines channels nobody else tracked meanwhile', async () => {
    const a = await svc.create(GUILD_A, { discordUserId: USER_A, accounts: [account('abu'), account('other')] }, 'user:1');
    const [abu, other] = a.accounts.map((acc) => acc.channelId) as [number, number];
    twitch.content.set('42', [item('old')]);
    twitch.content.set('43', [item('old43')]);
    await h.monitor.checkContent(abu);
    await h.monitor.checkContent(other);
    // Someone else keeps tracking "other" while A is disabled.
    await svc.create(GUILD_B, { discordUserId: USER_B, accounts: [account('other')] }, 'user:2');

    await svc.update(GUILD_A, a.id, { enabled: false }, 'user:1');
    expect(h.repos.channels.get(abu)!.contentSeeded).toBe(true);
    uploadWhileUntracked('42');

    await svc.update(GUILD_A, a.id, { enabled: true }, 'user:1');
    expect(h.repos.channels.get(abu)!.contentSeeded).toBe(false);
    expect(h.repos.kv.get(seedKey(abu))).toBeUndefined();
    expect(h.repos.channels.get(other)!.contentSeeded).toBe(true);
    expect(h.repos.kv.get(seedKey(other))).toBeDefined();

    await h.monitor.checkContent(abu);
    expect(h.content.ids()).toEqual([]);
  });

  it('addAccount on a disabled streamer does not re-baseline yet (the channel stays untracked)', async () => {
    const channelId = await trackedThenForgotten();
    const b = await svc.create(GUILD_B, { discordUserId: USER_B, accounts: [account('other')] }, 'user:2');
    await svc.update(GUILD_B, b.id, { enabled: false }, 'user:2');

    await svc.addAccount(GUILD_B, b.id, account('abu'), 'user:2');
    expect(h.repos.channels.get(channelId)!.contentSeeded).toBe(true);
    await svc.update(GUILD_B, b.id, { enabled: true }, 'user:2');
    expect(h.repos.channels.get(channelId)!.contentSeeded).toBe(false);
  });
});

function addHistory(repos: Repositories, streamerId: number, channelId: number): void {
  const streamer = repos.streamers.get(streamerId)!;
  const startedAt = new Date(Date.now() - 15 * DAY).toISOString();
  const session = repos.sessions.create({ guildId: streamer.guildId, streamerId, startedAt });
  const segment = repos.sessions.addSegment({ sessionId: session.id, channelId, platform: 'twitch', streamId: 's', startedAt, viewers: 5 });
  repos.sessions.saveSegment({ ...segment, endedAt: new Date(Date.now() - 14 * DAY).toISOString() });
  repos.sessions.save({ ...session, status: 'ended', endedAt: new Date(Date.now() - 14 * DAY).toISOString() });
}
