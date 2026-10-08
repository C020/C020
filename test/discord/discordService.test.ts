import { type Client, Events, GatewayIntentBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import { ValidationError } from '../../src/core/errors.js';
import { AppEvents } from '../../src/core/events.js';
import { CustomIds } from '../../src/discord/interactions/ids.js';
import { DiscordService, startupError } from '../../src/discord/discordService.js';
import { sampleContentView, sampleLiveView, sampleSummaryView } from '../../src/discord/samples.js';
import { buildContentMessage, buildLiveMessage, buildSummaryMessage } from '../../src/discord/messages.js';
import { TimeoutError } from '../../src/discord/util.js';
import { db, GUILD, LIVE_CHANNEL, settings, T0 } from './helpers.js';
import { FakeInteraction } from './interactionHelpers.js';

const config = { DISCORD_TOKEN: 'token', DISCORD_CLIENT_ID: '123456789012345678' } as AppConfig;

function service() {
  const deps = db();
  return { ...deps, discord: new DiscordService({ config, ...deps }) };
}

describe('DiscordService (no gateway)', () => {
  it('is not ready before start and exposes nothing', () => {
    const { discord } = service();
    expect(discord.isReady()).toBe(false);
    expect(discord.botUser()).toBeNull();
    expect(discord.guilds()).toEqual([]);
    expect(discord.guild(GUILD)).toBeNull();
  });

  it('builds message and invite URLs', () => {
    const { discord } = service();
    expect(discord.messageUrl(GUILD, { channelId: '2', messageId: '3' })).toBe(`https://discord.com/channels/${GUILD}/2/3`);
    expect(discord.inviteUrl()).toContain('client_id=123456789012345678&scope=bot%20applications.commands&permissions=');
  });

  it('previews live messages with the guild ping and summaries without it', async () => {
    const { discord, repos } = service();
    repos.settings.update(GUILD, { pingMode: 'here' });
    const live = await discord.preview(GUILD, 'live');
    expect(live.content).toBe('@here');
    expect(live.embeds[0]!.title).toBe('🔴 ستريمر تجريبي يبث الحين!');
    expect(live.buttons.length).toBeGreaterThan(0);
    const summary = await discord.preview(GUILD, 'summary');
    expect(summary.content).toBeNull();
    expect(summary.embeds[0]!.title).toBe('⚫ انتهى بث ستريمر تجريبي');
  });

  it('applies a template override in the preview', async () => {
    const { discord } = service();
    const preview = await discord.preview(GUILD, 'content', { title: 'جديد: {title}', color: 0x112233 });
    expect(preview.embeds[0]!.title).toMatch(/^جديد: /);
    expect(preview.embeds[0]!.color).toBe(0x112233);
  });

  it('refuses test messages without a channel or a gateway connection', async () => {
    const { discord, repos } = service();
    await expect(discord.sendTest(GUILD, 'live')).rejects.toThrow(ValidationError);
    await expect(discord.sendTest(GUILD, 'content')).rejects.toThrow('روم إشعارات المقاطع');
    repos.settings.update(GUILD, { liveChannelId: LIVE_CHANNEL });
    await expect(discord.sendTest(GUILD, 'live')).rejects.toThrow('غير متصل');
  });

  it('never throws from role changes or log() while offline', async () => {
    const { discord, repos } = service();
    repos.settings.update(GUILD, { liveRoleId: '666666666666666666', logChannelId: LIVE_CHANNEL });
    // Offline is a transient failure: the caller retries (reconcile) instead of losing the change.
    await expect(discord.setLive(GUILD, '222222222222222222', true, 'test')).resolves.toBe('transient');
    await expect(discord.setStreamer(GUILD, '222222222222222222', true, 'test')).resolves.toBe('transient');
    await expect(discord.removeRoleFrom(GUILD, '666666666666666666', ['222222222222222222'], 'test')).resolves.toBeUndefined();
    await expect(discord.log(GUILD, 'warn', 'x')).resolves.toBeUndefined();
    await expect(discord.reconcile(GUILD, new Set(), new Set())).rejects.toThrow('غير متصل');
    await discord.stop();
  });

  it('reports a clear offline diagnosis', async () => {
    const { discord } = service();
    const result = await discord.diagnose(GUILD, settings());
    expect(result.problems.map((p) => p.code)).toEqual(['discord_not_ready']);
  });

  it('notifies gateway recovery listeners once per resume/re-identify burst, never for the first READY', async () => {
    vi.useFakeTimers();
    const { discord } = service();
    const listener = vi.fn();
    discord.onGatewayRecovered(listener);
    const internals = discord as unknown as { createClient(): Client; initialReady: boolean };
    const client = internals.createClient();
    try {
      client.emit(Events.ShardReady, 0, undefined); // initial login
      await vi.advanceTimersByTimeAsync(10_000);
      expect(listener).not.toHaveBeenCalled();

      internals.initialReady = true; // ClientReady arrived
      client.emit(Events.ShardResume, 0, 12);
      client.emit(Events.ShardReady, 0, undefined);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(listener).toHaveBeenCalledTimes(1);

      client.emit(Events.ShardResume, 0, 3);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      await client.destroy();
      await discord.stop();
      vi.useRealTimers();
    }
  });

  it('reports transient outcomes from the notifier while offline instead of throwing', async () => {
    const { discord } = service();
    const s = settings({ liveChannelId: LIVE_CHANNEL });
    const view = sampleLiveView(s, T0);
    const ref = { channelId: LIVE_CHANNEL, messageId: '999999999999999999' };
    await expect(discord.postLive(view)).resolves.toBeNull();
    await expect(discord.updateLive(ref, view)).resolves.toBe('transient');
    await expect(discord.postSummary(ref, sampleSummaryView(s, T0))).resolves.toEqual({ status: 'transient', reason: 'not_ready' });
  });
});

describe('startupError', () => {
  it('explains the common login failures', () => {
    expect(startupError(Object.assign(new Error('An invalid token was provided.'), { code: 'TokenInvalid' }), 60_000).message).toContain('DISCORD_TOKEN is invalid');
    expect(startupError(Object.assign(new Error('Used disallowed intents'), { code: 'DisallowedIntents' }), 60_000).message).toContain('SERVER MEMBERS INTENT');
    expect(startupError(new TimeoutError('x'), 60_000).message).toContain('within 60s');
    expect(startupError(new Error('ECONNRESET'), 60_000).message).toBe('Discord login failed: ECONNRESET');
  });

  it('marks configuration errors as permanent and network errors as retryable', () => {
    expect(startupError(Object.assign(new Error('An invalid token was provided.'), { code: 'TokenInvalid' }), 60_000).permanent).toBe(true);
    expect(startupError(Object.assign(new Error('Used disallowed intents'), { code: 'DisallowedIntents' }), 60_000).permanent).toBe(true);
    expect(startupError(new TimeoutError('x'), 60_000).permanent).toBe(false);
    expect(startupError(new Error('ECONNRESET'), 60_000).permanent).toBe(false);
  });
});

describe('samples', () => {
  it('follow the enabled platforms and build valid messages', () => {
    const s = settings({ platformsEnabled: ['youtube', 'tiktok'] });
    const live = sampleLiveView(s, T0);
    expect(live.platforms.map((p) => p.platform).sort()).toEqual(['tiktok', 'youtube']);
    expect(live.totalViewers).toBe(870 + 410);
    expect(buildLiveMessage(live).components[0]!.components).toHaveLength(2);

    const summary = sampleSummaryView(s, T0);
    expect(summary.segments.map((x) => x.platform)).toEqual(['youtube', 'tiktok']);
    expect(buildSummaryMessage(summary).embeds[0]!.fields!.length).toBeGreaterThan(3);

    const content = sampleContentView(settings({ platformsEnabled: ['kick'], contentKinds: ['clip'] }), T0);
    expect(content.channel.platform).toBe('kick');
    expect(content.item.kind).toBe('clip');
    expect(buildContentMessage(content).embeds[0]!.description).toContain('كليب');
  });
});

describe('DiscordService v2', () => {
  function withServices(configPatch: Partial<AppConfig> = {}) {
    const deps = db();
    const discord = new DiscordService({ config: { ...config, ...configPatch } as AppConfig, ...deps });
    const presenceCalls: Array<[string, string, unknown]> = [];
    discord.attachServices({
      streamers: {} as never,
      sessions: { liveViews: () => [] } as never,
      repos: deps.repos,
      audit: deps.audit,
      presence: {
        start() {},
        stop() {},
        async onPresence(guildId, userId, activity) {
          presenceCalls.push([guildId, userId, activity]);
        },
        liveUserIds: () => new Set(),
        async reconcile() {},
      },
    });
    return { ...deps, discord, presenceCalls };
  }

  it('requests the privileged Presence intent only when configured', async () => {
    const plain = service().discord;
    expect(plain.presenceIntentEnabled()).toBe(false);
    const plainClient = (plain as unknown as { createClient(): Client }).createClient();
    expect(plainClient.options.intents.has(GatewayIntentBits.GuildPresences)).toBe(false);
    expect(plainClient.options.intents.has(GatewayIntentBits.GuildMembers)).toBe(true);
    await plainClient.destroy();

    const { discord } = withServices({ DISCORD_PRESENCE_INTENT: true });
    expect(discord.presenceIntentEnabled()).toBe(true);
    const client = (discord as unknown as { createClient(): Client }).createClient();
    expect(client.options.intents.has(GatewayIntentBits.GuildPresences)).toBe(true);
    // Channel renames are rejected (not queued for minutes) when rate limited.
    const reject = client.options.rest?.rejectOnRateLimit as (data: { route: string; method: string }) => boolean;
    expect(reject({ route: '/channels/:id', method: 'PATCH' })).toBe(true);
    expect(reject({ route: '/channels/:id/messages/:id', method: 'PATCH' })).toBe(false);
    await client.destroy();
  });

  it('forwards Streaming presence changes from raw gateway packets, in order and only when they change', async () => {
    const { discord, presenceCalls } = withServices({ DISCORD_PRESENCE_INTENT: true });
    const raw = (packet: unknown) => (discord as unknown as { onRawPacket(p: unknown): void }).onRawPacket(packet);
    const streamingActivity = { type: 1, url: 'https://www.twitch.tv/abufahad', details: 'رانكد', state: 'VALORANT' };
    raw({ t: 'GUILD_CREATE', d: { id: GUILD, presences: [] } });
    raw({ t: 'PRESENCE_UPDATE', d: { guild_id: GUILD, user: { id: '222222222222222222' }, status: 'online', activities: [streamingActivity] } });
    raw({ t: 'PRESENCE_UPDATE', d: { guild_id: GUILD, user: { id: '222222222222222222' }, status: 'idle', activities: [streamingActivity] } });
    raw({ t: 'PRESENCE_UPDATE', d: { guild_id: GUILD, user: { id: '222222222222222222' }, status: 'online', activities: [] } });
    raw({ t: 'GUILD_MEMBER_REMOVE', d: { guild_id: GUILD, user: { id: '333333333333333339' } } });
    raw({ t: 'PRESENCE_UPDATE', d: null });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Ordered per member (members are independent of each other).
    expect(presenceCalls.filter((c) => c[1] === '222222222222222222')).toEqual([
      [GUILD, '222222222222222222', { url: 'https://www.twitch.tv/abufahad', platform: 'twitch', title: 'رانكد', game: 'VALORANT' }],
      [GUILD, '222222222222222222', null],
    ]);
    expect(presenceCalls.filter((c) => c[1] === '333333333333333339')).toEqual([[GUILD, '333333333333333339', null]]);
    expect(presenceCalls).toHaveLength(3);
    // Without a ready client the presence map is unknown.
    await expect(discord.streamingPresences(GUILD)).resolves.toBeNull();
    await discord.stop();
  });

  it('reports no presences without the intent', async () => {
    const { discord } = service();
    await expect(discord.streamingPresences(GUILD)).resolves.toBeNull();
  });

  it('previews as a registered streamer and refuses streamers of other guilds', async () => {
    const { discord, repos } = withServices();
    const streamer = repos.streamers.create({ guildId: GUILD, discordUserId: '222222222222222222', displayName: 'نورة' });
    const preview = await discord.preview(GUILD, 'live', undefined, streamer.id);
    expect(preview.embeds[0]!.title).toContain('نورة');
    await expect(discord.preview(GUILD, 'live', undefined, 9999)).rejects.toThrow('الستريمر غير موجود');
    const other = repos.streamers.create({ guildId: '999999999999999999', discordUserId: '222222222222222223', displayName: 'x' });
    await expect(discord.preview(GUILD, 'live', undefined, other.id)).rejects.toThrow(ValidationError);
    repos.settings.update(GUILD, { features: { language: 'en' } });
    expect((await discord.preview(GUILD, 'live')).embeds[0]!.title).toContain('Sample streamer');
  });

  it('explains panel and test problems in the guild language', async () => {
    const { discord, repos } = withServices();
    await expect(discord.postPanel(GUILD, 'notify')).rejects.toThrow('حدد رتبة الإشعارات');
    repos.settings.update(GUILD, { features: { applications: { enabled: true, panelChannelId: LIVE_CHANNEL } } });
    await expect(discord.postPanel(GUILD, 'apply')).rejects.toThrow('غير متصل');
    repos.settings.update(GUILD, { features: { language: 'en' } });
    await expect(discord.sendTest(GUILD, 'live')).rejects.toThrow('Set the live notification channel in the settings first');
    // A routed live channel counts as configured for the sample's primary platform.
    repos.settings.update(GUILD, { features: { routing: { liveByPlatform: { twitch: LIVE_CHANNEL, kick: LIVE_CHANNEL } } } });
    await expect(discord.sendTest(GUILD, 'live')).rejects.toThrow('not connected to Discord');
  });

  it('answers buttons before services are attached and routes them afterwards', async () => {
    const { repos, audit } = db();
    const discord = new DiscordService({ config, repos, audit, events: new AppEvents() });
    const onInteraction = (i: unknown) => (discord as unknown as { onInteraction(i: unknown): Promise<void> }).onInteraction(i);
    const button = () => Object.assign(new FakeInteraction(CustomIds.notifyToggle, 'button'), { isChatInputCommand: () => false, type: 3 });
    const early = button();
    await onInteraction(early);
    expect(early.lastEmbed().title).toBe('⏳ البوت لسا يجهز');

    discord.attachServices({ streamers: {} as never, sessions: {} as never, repos, audit });
    const ready = button();
    await onInteraction(ready);
    expect(ready.lastEmbed().description).toContain('رتبة الإشعارات مو مفعّلة');

    const foreign = Object.assign(new FakeInteraction('other:thing', 'button'), { isChatInputCommand: () => false, type: 3 });
    await onInteraction(foreign);
    expect(foreign.calls).toEqual([]);
  });

  it('never throws from the v2 actions while offline', async () => {
    const { discord, repos } = withServices();
    await expect(discord.renameChannel(GUILD, LIVE_CHANNEL, 'x')).resolves.toEqual({ outcome: 'error' });
    await expect(discord.sendDirectMessage('222222222222222222', { content: 'x' })).resolves.toBe(false);
    const app = repos.applications.create({ guildId: GUILD, userId: '222222222222222222', username: 'x', accounts: [{ platform: 'kick', input: 'x' }], note: null });
    const settingsWithReview = repos.settings.update(GUILD, { features: { applications: { reviewChannelId: LIVE_CHANNEL } } });
    await expect(discord.upsertApplicationReview(app, settingsWithReview)).resolves.toBeNull();
  });
});

describe('startupError (presence intent)', () => {
  it('names the Presence intent when it was requested', () => {
    const err = startupError(Object.assign(new Error('Used disallowed intents'), { code: 'DisallowedIntents' }), 60_000, true);
    expect(err.message).toContain('SERVER MEMBERS INTENT and PRESENCE INTENT');
    expect(err.message).toContain('DISCORD_PRESENCE_INTENT=false');
    expect(err.permanent).toBe(true);
  });
});
