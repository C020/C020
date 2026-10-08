import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { StreamerApplication } from '../../src/db/models.js';
import { rateLimitRetryAfterMs, shouldRejectRateLimit } from '../../src/discord/apiErrors.js';
import { cleanChannelName, DiscordActionsImpl } from '../../src/discord/interactions/actions.js';
import { DiscordInteractiveMessenger, type DeleteOutcome, type InteractiveMessenger } from '../../src/discord/interactions/messenger.js';
import { PresenceTracker } from '../../src/discord/interactions/presence.js';
import type { InteractiveMessage } from '../../src/discord/interactions/types.js';
import type { TransportResult } from '../../src/discord/transport.js';
import type { MessageRef } from '../../src/services/ports.js';
import { FakeClient, FakeGuild } from './fakeDiscord.js';
import { db, GUILD } from './helpers.js';

const BOT_ROLE = '700000000000000009';
const COUNTER = '300000000000000080';
const REVIEW = '300000000000000081';
const USER_ID = '200000000000000001';

class FakeMessenger implements InteractiveMessenger {
  readonly calls: Array<{ op: string; channelId: string; messageId?: string; message?: InteractiveMessage }> = [];
  sendResults: TransportResult[] = [];
  editResults: TransportResult[] = [];
  private seq = 0;

  async send(_g: string, channelId: string, message: InteractiveMessage): Promise<TransportResult> {
    this.calls.push({ op: 'send', channelId, message });
    await new Promise((r) => setTimeout(r, 1));
    return this.sendResults.shift() ?? { ok: true, ref: { channelId, messageId: `99000000000000000${++this.seq}` } };
  }

  async edit(_g: string, ref: MessageRef, message: InteractiveMessage): Promise<TransportResult> {
    this.calls.push({ op: 'edit', channelId: ref.channelId, messageId: ref.messageId, message });
    return this.editResults.shift() ?? { ok: true, ref };
  }

  async delete(): Promise<DeleteOutcome> {
    return 'ok';
  }
}

function setup(opts: { perms?: bigint[]; presenceIntent?: boolean } = {}) {
  const { repos, audit } = db();
  const client = new FakeClient();
  const guild = client.addGuild(new FakeGuild(GUILD));
  const botRole = guild.addRole(BOT_ROLE, 'StreamBot', 10);
  guild.addBot('800000000000000000', [botRole], opts.perms ?? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect]);
  const messenger = new FakeMessenger();
  const presences = new PresenceTracker();
  const actions = new DiscordActionsImpl({
    getClient: () => client.asClient(),
    repos,
    audit,
    messenger,
    presences,
    presenceIntent: () => opts.presenceIntent ?? true,
  });
  return { repos, client, guild, messenger, presences, actions };
}

describe('rate-limit helpers', () => {
  it('only rejects (instead of queueing) channel edits', () => {
    expect(shouldRejectRateLimit({ route: '/channels/:id', method: 'PATCH' })).toBe(true);
    expect(shouldRejectRateLimit({ route: '/channels/:id', method: 'patch' })).toBe(true);
    expect(shouldRejectRateLimit({ route: '/channels/:id/messages/:id', method: 'PATCH' })).toBe(false);
    expect(shouldRejectRateLimit({ route: '/channels/:id', method: 'GET' })).toBe(false);
    expect(shouldRejectRateLimit({ route: '/guilds/:id/members/:id/roles/:id', method: 'PUT' })).toBe(false);
  });

  it('reads the wait time from a RateLimitError', () => {
    const err = Object.assign(new Error(), { retryAfter: 120_000, timeToReset: 5_000, sublimitTimeout: 300_000 });
    Object.defineProperty(err, 'name', { get: () => 'RateLimitError[/channels/:id]' });
    expect(rateLimitRetryAfterMs(err)).toBe(300_000);
    expect(rateLimitRetryAfterMs(Object.assign(new Error('x'), { code: 50013 }))).toBeNull();
    expect(rateLimitRetryAfterMs(null)).toBeNull();
  });
});

describe('renameChannel (#8)', () => {
  it('renames a voice channel and reports unchanged names', async () => {
    const { guild, actions } = setup();
    const channel = guild.addChannel(COUNTER, '🔴 يبثون الحين: 0', ChannelType.GuildVoice);
    await expect(actions.renameChannel(GUILD, COUNTER, '  🔴 يبثون الحين: 3 ')).resolves.toEqual({ outcome: 'ok' });
    expect(channel.renames).toEqual([{ name: '🔴 يبثون الحين: 3', reason: 'Live counter' }]);
    await expect(actions.renameChannel(GUILD, COUNTER, '🔴 يبثون الحين: 3')).resolves.toEqual({ outcome: 'unchanged' });
    expect(channel.renames).toHaveLength(1);
  });

  it('treats Discord’s text-channel normalization as unchanged', async () => {
    const { guild, actions } = setup();
    guild.addChannel(COUNTER, 'live-now-3', ChannelType.GuildText);
    await expect(actions.renameChannel(GUILD, COUNTER, 'Live Now 3')).resolves.toEqual({ outcome: 'unchanged' });
  });

  it('needs View Channel + Manage Channel (+ Connect for voice) before calling Discord', async () => {
    const { guild, actions } = setup({ perms: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels] });
    const voice = guild.addChannel(COUNTER, 'old', ChannelType.GuildVoice);
    await expect(actions.renameChannel(GUILD, COUNTER, 'new')).resolves.toEqual({ outcome: 'forbidden' });
    expect(voice.renames).toEqual([]);
    const text = guild.addChannel('300000000000000082', 'old', ChannelType.GuildText);
    await expect(actions.renameChannel(GUILD, text.id, 'new')).resolves.toEqual({ outcome: 'ok' });
  });

  it('maps Discord failures to outcomes, with the retry delay when rate limited', async () => {
    const { guild, actions } = setup();
    const channel = guild.addChannel(COUNTER, 'old', ChannelType.GuildVoice);
    const rateLimited = Object.assign(new Error(), { retryAfter: 290_000, timeToReset: 0, sublimitTimeout: 290_000 });
    Object.defineProperty(rateLimited, 'name', { get: () => 'RateLimitError[/channels/:id]' });
    channel.renameError = rateLimited;
    await expect(actions.renameChannel(GUILD, COUNTER, 'new')).resolves.toEqual({ outcome: 'rate_limited', retryAfterMs: 290_000 });
    channel.renameError = Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 });
    await expect(actions.renameChannel(GUILD, COUNTER, 'new')).resolves.toEqual({ outcome: 'forbidden' });
    channel.renameError = Object.assign(new Error('Unknown Channel'), { code: 10003, status: 404 });
    await expect(actions.renameChannel(GUILD, COUNTER, 'new')).resolves.toEqual({ outcome: 'missing' });
    channel.renameError = Object.assign(new Error('Internal'), { status: 500 });
    await expect(actions.renameChannel(GUILD, COUNTER, 'new')).resolves.toEqual({ outcome: 'error' });
  });

  it('handles missing channels, foreign guilds, empty names and an offline client', async () => {
    const { client, actions } = setup();
    await expect(actions.renameChannel(GUILD, COUNTER, 'x')).resolves.toEqual({ outcome: 'missing' });
    await expect(actions.renameChannel(GUILD, 'nope', 'x')).resolves.toEqual({ outcome: 'missing' });
    await expect(actions.renameChannel('999999999999999999', COUNTER, 'x')).resolves.toEqual({ outcome: 'missing' });
    await expect(actions.renameChannel(GUILD, COUNTER, '   ')).resolves.toEqual({ outcome: 'error' });
    client.ready = false;
    await expect(actions.renameChannel(GUILD, COUNTER, 'x')).resolves.toEqual({ outcome: 'error' });
  });

  it('cuts names to 100 characters without splitting emojis', () => {
    expect(cleanChannelName('a'.repeat(150))).toHaveLength(100);
    const emojiName = `${'a'.repeat(99)}🔴`;
    expect(cleanChannelName(emojiName)).toBe('a'.repeat(99));
  });
});

describe('sendDirectMessage', () => {
  it('sends content and an optional embed without pings', async () => {
    const { client, actions } = setup();
    await expect(actions.sendDirectMessage(USER_ID, { content: 'مرحبا', embedTitle: 'تم قبولك', embedDescription: 'أهلاً', color: 0x57f287 })).resolves.toBe(true);
    expect(client.dms.get(USER_ID)!.sent).toEqual([
      { content: 'مرحبا', embeds: [{ color: 0x57f287, title: 'تم قبولك', description: 'أهلاً' }], allowedMentions: { parse: [], repliedUser: false } },
    ]);
  });

  it('returns false when DMs are closed, the user is invalid or Discord is offline', async () => {
    const { client, actions } = setup();
    client.createDmError = Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
    await expect(actions.sendDirectMessage(USER_ID, { content: 'x' })).resolves.toBe(false);
    client.createDmError = null;
    await expect(actions.sendDirectMessage('bad', { content: 'x' })).resolves.toBe(false);
    await expect(actions.sendDirectMessage(USER_ID, { content: '' })).resolves.toBe(false);
    client.ready = false;
    await expect(actions.sendDirectMessage(USER_ID, { content: 'x' })).resolves.toBe(false);
  });
});

describe('upsertApplicationReview (#9)', () => {
  function createApp(repos: ReturnType<typeof db>['repos']): StreamerApplication {
    return repos.applications.create({ guildId: GUILD, userId: USER_ID, username: 'فهد', accounts: [{ platform: 'kick', input: 'abufahad' }], note: null });
  }

  it('posts once for a pending application and stores the ref, then edits it', async () => {
    const { repos, messenger, actions } = setup();
    const settings = repos.settings.update(GUILD, { features: { applications: { enabled: true, reviewChannelId: REVIEW } } });
    const app = createApp(repos);
    const ref = await actions.upsertApplicationReview(app, settings);
    expect(ref).toEqual({ channelId: REVIEW, messageId: expect.any(String) });
    expect(repos.applications.get(app.id)).toMatchObject({ reviewChannelId: REVIEW, reviewMessageId: ref!.messageId });
    expect(messenger.calls[0]!.message!.components).toHaveLength(1);

    // A stale application object (no ref) still edits the stored message instead of posting a duplicate.
    const decided = repos.applications.update(app.id, { status: 'approved', reviewerId: '200000000000000777', decidedAt: new Date().toISOString() })!;
    await expect(actions.upsertApplicationReview({ ...decided, reviewChannelId: null, reviewMessageId: null }, settings)).resolves.toEqual(ref);
    expect(messenger.calls.map((c) => c.op)).toEqual(['send', 'edit']);
    expect(messenger.calls[1]!.message!.components).toEqual([]);
  });

  it('never posts two messages for concurrent calls', async () => {
    const { repos, messenger, actions } = setup();
    const settings = repos.settings.update(GUILD, { features: { applications: { enabled: true, reviewChannelId: REVIEW } } });
    const app = createApp(repos);
    const [a, b] = await Promise.all([actions.upsertApplicationReview(app, settings), actions.upsertApplicationReview(app, settings)]);
    expect(a).toEqual(b);
    expect(messenger.calls.map((c) => c.op)).toEqual(['send', 'edit']);
  });

  it('reposts a deleted message only while pending, and keeps the ref on transient failures', async () => {
    const { repos, messenger, actions } = setup();
    const settings = repos.settings.update(GUILD, { features: { applications: { enabled: true, reviewChannelId: REVIEW } } });
    const app = createApp(repos);
    const first = await actions.upsertApplicationReview(app, settings);

    messenger.editResults.push({ ok: false, reason: 'error', detail: '500' });
    await expect(actions.upsertApplicationReview(app, settings)).resolves.toEqual(first);
    expect(repos.audit.list({ guildId: GUILD, actionPrefix: 'discord.delivery' })).toHaveLength(1);

    messenger.editResults.push({ ok: false, reason: 'gone', detail: '10008' });
    const second = await actions.upsertApplicationReview(app, settings);
    expect(second!.messageId).not.toBe(first!.messageId);

    repos.applications.update(app.id, { status: 'rejected' });
    messenger.editResults.push({ ok: false, reason: 'gone', detail: '10008' });
    await expect(actions.upsertApplicationReview(app, settings)).resolves.toBeNull();
    expect(repos.applications.get(app.id)!.reviewMessageId).toBeNull();
  });

  it('does nothing without a review channel or for decided applications without a message', async () => {
    const { repos, messenger, actions } = setup();
    const app = createApp(repos);
    await expect(actions.upsertApplicationReview(app, repos.settings.get(GUILD))).resolves.toBeNull();
    const settings = repos.settings.update(GUILD, { features: { applications: { reviewChannelId: REVIEW } } });
    repos.applications.update(app.id, { status: 'approved' });
    await expect(actions.upsertApplicationReview(repos.applications.get(app.id)!, settings)).resolves.toBeNull();
    expect(messenger.calls).toEqual([]);
  });

  it('audits (throttled) when the review channel is not postable', async () => {
    const { repos, messenger, actions } = setup();
    const settings = repos.settings.update(GUILD, { features: { applications: { reviewChannelId: REVIEW } } });
    const app = createApp(repos);
    messenger.sendResults.push(
      { ok: false, reason: 'forbidden', detail: 'missing', missing: ['SendMessages'], channelName: 'reviews' },
      { ok: false, reason: 'forbidden', detail: 'missing', missing: ['SendMessages'], channelName: 'reviews' },
    );
    await expect(actions.upsertApplicationReview(app, settings)).resolves.toBeNull();
    await expect(actions.upsertApplicationReview(app, settings)).resolves.toBeNull();
    const audits = repos.audit.list({ guildId: GUILD, actionPrefix: 'discord.delivery' });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.message).toContain('#reviews');
    expect(audits[0]!.message).toContain('إرسال الرسائل (Send Messages)');
  });
});

describe('streamingPresences (#15)', () => {
  it('is null without the intent, while offline or before the snapshot', async () => {
    const without = setup({ presenceIntent: false });
    without.presences.snapshot(GUILD, []);
    await expect(without.actions.streamingPresences(GUILD)).resolves.toBeNull();

    const { client, presences, actions } = setup();
    await expect(actions.streamingPresences(GUILD)).resolves.toBeNull();
    presences.snapshot(GUILD, []);
    await expect(actions.streamingPresences(GUILD)).resolves.toEqual(new Map());
    await expect(actions.streamingPresences('999999999999999999')).resolves.toBeNull();
    client.ready = false;
    await expect(actions.streamingPresences(GUILD)).resolves.toBeNull();
  });

  it('lists streaming members (bots excluded)', async () => {
    const { client, presences, actions } = setup();
    client.users.cache.set('200000000000000099', { displayAvatarURL: () => '', bot: true });
    presences.snapshot(GUILD, [
      { user: { id: USER_ID }, status: 'online', activities: [{ type: 1, url: 'https://www.twitch.tv/a', details: 't', state: 'g' }] },
      { user: { id: '200000000000000099' }, status: 'online', activities: [{ type: 1, url: 'https://www.twitch.tv/bot' }] },
    ]);
    const map = await actions.streamingPresences(GUILD);
    expect([...map!.entries()]).toEqual([[USER_ID, { url: 'https://www.twitch.tv/a', platform: 'twitch', title: 't', game: 'g' }]]);
  });
});

describe('DiscordInteractiveMessenger', () => {
  it('sends interactive rows through the transport without pings and deletes old messages', async () => {
    const client = new FakeClient();
    const guild = client.addGuild(new FakeGuild(GUILD));
    guild.addBot('800000000000000000', [], [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
    const channel = guild.addChannel(REVIEW, 'panels');
    const messenger = new DiscordInteractiveMessenger(() => client.asClient());
    const row = { type: 1, components: [{ type: 2, style: 1, custom_id: 'sb:notify:toggle', label: 'x' }] } as unknown as InteractiveMessage['components'][number];
    const sent = await messenger.send(GUILD, REVIEW, { content: '', embeds: [{ title: 't' }], components: [row] });
    expect(sent.ok).toBe(true);
    expect(channel.sent[0]).toMatchObject({ components: [row], allowedMentions: { parse: [], repliedUser: false } });

    await expect(messenger.delete(GUILD, { channelId: REVIEW, messageId: '990000000000000001' })).resolves.toBe('ok');
    expect(channel.deleted).toEqual(['990000000000000001']);
    channel.deleteError = Object.assign(new Error('Unknown Message'), { code: 10008 });
    await expect(messenger.delete(GUILD, { channelId: REVIEW, messageId: '990000000000000002' })).resolves.toBe('gone');
    channel.deleteError = Object.assign(new Error('boom'), { status: 500 });
    await expect(messenger.delete(GUILD, { channelId: REVIEW, messageId: '990000000000000003' })).resolves.toBe('failed');
    await expect(messenger.delete('999999999999999999', { channelId: REVIEW, messageId: '990000000000000003' })).resolves.toBe('gone');
    client.ready = false;
    await expect(messenger.delete(GUILD, { channelId: REVIEW, messageId: '990000000000000003' })).resolves.toBe('failed');
  });
});
