/** DiscordNotifier v2: #4 routing (+ fallback), #10 silent sends, #1 notify-role pings, #6 digest, #15 presence. */
import { describe, expect, it, vi } from 'vitest';
import { configuredLiveChannels, summaryPrimaryPlatform } from '../../src/discord/notifier.js';
import { resolvePlatformEmojis } from '../../src/discord/emojis.js';
import type { GuildFeaturesPatch } from '../../src/db/features.js';
import {
  CONTENT_CHANNEL,
  contentView,
  digestView,
  LIVE_CHANNEL,
  liveView,
  makeNotifier,
  platformView,
  presenceView,
  ROLE,
  settings,
  streamer,
  summaryView,
  withFeatures,
} from './helpers.js';

const KICK_CHANNEL = '700000000000000001';
const TWITCH_CHANNEL = '700000000000000002';
const CLIP_CHANNEL = '700000000000000003';
const YT_CHANNEL = '700000000000000004';
const DIGEST_CHANNEL = '700000000000000005';
const NOTIFY = '777777777777777777';

const forbidden = { ok: false as const, reason: 'forbidden' as const, detail: 'Missing Access' };
const missing = { ok: false as const, reason: 'channel_missing' as const, detail: 'Unknown Channel' };

const liveSettings = (features: GuildFeaturesPatch = {}, patch: Parameters<typeof settings>[0] = {}) =>
  withFeatures({ routing: { liveByPlatform: { kick: KICK_CHANNEL }, contentByPlatform: {}, contentByKind: {} }, ...features }, { liveChannelId: LIVE_CHANNEL, ...patch });

describe('#4 live routing', () => {
  it('posts in the channel of the primary platform and returns that ref', async () => {
    const { notifier, transport } = makeNotifier();
    const view = liveView([platformView('kick', { viewers: 500 }), platformView('twitch', { viewers: 100 })], { settings: liveSettings() });
    expect(await notifier.postLive(view)).toEqual({ channelId: KICK_CHANNEL, messageId: 'm1' });
    expect(transport.calls.map((c) => [c.op, c.channelId])).toEqual([['send', KICK_CHANNEL]]);
  });

  it('uses the default live channel for platforms without a route', async () => {
    const { notifier, transport } = makeNotifier();
    await notifier.postLive(liveView([platformView('twitch')], { settings: liveSettings() }));
    expect(transport.calls[0]!.channelId).toBe(LIVE_CHANNEL);
  });

  it('works with a route but no default channel, and skips quietly when nothing resolves', async () => {
    const { notifier, transport, warnings } = makeNotifier();
    const noDefault = liveSettings({}, { liveChannelId: null });
    expect(await notifier.postLive(liveView([platformView('kick')], { settings: noDefault }))).toEqual({ channelId: KICK_CHANNEL, messageId: 'm1' });
    expect(await notifier.postLive(liveView([platformView('twitch')], { settings: noDefault }))).toBeNull();
    expect(await notifier.postLive(liveView([], { settings: noDefault }))).toBeNull();
    expect(transport.calls).toHaveLength(1);
    expect(warnings()).toHaveLength(0);
  });

  it.each([forbidden, missing, { ok: false as const, reason: 'wrong_guild' as const, detail: '' }, { ok: false as const, reason: 'not_text' as const, detail: '' }])(
    'falls back once to the default channel when the routed one is unusable ($reason) and warns (throttled)',
    async (failure) => {
      const { notifier, transport, warnings, advance } = makeNotifier();
      const view = liveView([platformView('kick')], { settings: liveSettings() });
      transport.push(failure);
      expect(await notifier.postLive(view)).toEqual({ channelId: LIVE_CHANNEL, messageId: 'm2' });
      expect(transport.calls.map((c) => c.channelId)).toEqual([KICK_CHANNEL, LIVE_CHANNEL]);
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]!.message).toMatch(/^توجيه Kick: .+ أرسلنا الإشعار في الروم الافتراضي \(333333333333333333\) بدلاً منه$/);
      expect(warnings()[0]!.details).toMatchObject({ channelId: KICK_CHANNEL, fallbackChannelId: LIVE_CHANNEL, routed: true, reason: failure.reason });

      transport.push(failure);
      await notifier.postLive(view);
      expect(warnings()).toHaveLength(1);
      advance(60 * 60_000);
      transport.push(failure);
      await notifier.postLive(view);
      expect(warnings()).toHaveLength(2);
    },
  );

  it('warns in English for English guilds', async () => {
    const { notifier, transport, warnings } = makeNotifier();
    transport.push(missing);
    await notifier.postLive(liveView([platformView('kick')], { settings: liveSettings({ language: 'en' }) }));
    expect(warnings()[0]!.message).toMatch(/^Routing for Kick: The selected live notifications channel \(700000000000000001\).+sent to the default channel \(333333333333333333\) instead$/);
  });

  it('never falls back on transient errors (a duplicate could appear) and reports them', async () => {
    const { notifier, transport, warnings } = makeNotifier();
    transport.push({ ok: false, reason: 'error', detail: '503' });
    expect(await notifier.postLive(liveView([platformView('kick')], { settings: liveSettings() }))).toBeNull();
    expect(transport.calls).toHaveLength(1);
    expect(warnings().map((w) => w.details.reason)).toEqual(['error']);
  });

  it('reports the default channel too when the fallback also fails', async () => {
    const { notifier, transport, warnings } = makeNotifier();
    transport.push(forbidden, missing);
    expect(await notifier.postLive(liveView([platformView('kick')], { settings: liveSettings() }))).toBeNull();
    expect(transport.calls.map((c) => c.channelId)).toEqual([KICK_CHANNEL, LIVE_CHANNEL]);
    expect(warnings().map((w) => [w.details.channelId, w.details.reason]).sort()).toEqual([
      [LIVE_CHANNEL, 'channel_missing'],
      [KICK_CHANNEL, 'forbidden'],
    ]);
  });

  it('does not fall back when the routed channel is the default one', async () => {
    const { notifier, transport } = makeNotifier();
    transport.push(forbidden);
    await notifier.postLive(liveView([platformView('kick')], { settings: liveSettings({ routing: { liveByPlatform: { kick: LIVE_CHANNEL } } }) }));
    expect(transport.calls).toHaveLength(1);
  });

  it('edits stay where the message is, whatever the routing says now', async () => {
    const { notifier, transport } = makeNotifier();
    const ref = { channelId: '700000000000000099', messageId: '900000000000000001' };
    expect(await notifier.updateLive(ref, liveView([platformView('kick')], { settings: liveSettings() }))).toBe('ok');
    expect(transport.calls.map((c) => [c.op, c.channelId])).toEqual([['edit', '700000000000000099']]);
  });

  it('survives malformed routing settings by using the default channel', async () => {
    const { notifier, transport } = makeNotifier();
    const broken = { ...settings({ liveChannelId: LIVE_CHANNEL }), features: {} } as unknown as ReturnType<typeof settings>;
    expect(await notifier.postLive(liveView([platformView('kick')], { settings: broken }))).toEqual({ channelId: LIVE_CHANNEL, messageId: 'm1' });
    expect(transport.calls).toHaveLength(1);
  });
});

describe('#4 summary routing', () => {
  const routedSummary = (patch: Parameters<typeof summaryView>[0] = {}, features: GuildFeaturesPatch = {}) =>
    summaryView({ settings: liveSettings({ routing: { liveByPlatform: { kick: KICK_CHANNEL, twitch: TWITCH_CHANNEL } }, ...features }), ...patch });

  it('picks the platform with the highest peak for a new summary', () => {
    expect(summaryPrimaryPlatform(summaryView())).toBe('twitch');
    expect(summaryPrimaryPlatform({ segments: [] })).toBeNull();
  });

  it('reposts in the session channel when only the message was deleted (never moves)', async () => {
    const { notifier, transport } = makeNotifier();
    transport.push({ ok: false, reason: 'gone', detail: 'Unknown Message' });
    const ref = { channelId: KICK_CHANNEL, messageId: '900000000000000001' };
    expect(await notifier.postSummary(ref, routedSummary())).toEqual({ status: 'done', ref: { channelId: KICK_CHANNEL, messageId: 'm1' } });
    expect(transport.calls.map((c) => [c.op, c.channelId])).toEqual([
      ['edit', KICK_CHANNEL],
      ['send', KICK_CHANNEL],
    ]);
  });

  it('posts a summary without a live message in the route of its primary platform', async () => {
    const { notifier, transport } = makeNotifier();
    expect(await notifier.postSummary(null, routedSummary())).toEqual({ status: 'done', ref: { channelId: TWITCH_CHANNEL, messageId: 'm1' } });
    expect(transport.calls[0]!.channelId).toBe(TWITCH_CHANNEL);
  });

  it('keeps the old message when access to a still-configured routed channel was lost', async () => {
    const { notifier, transport } = makeNotifier();
    transport.push(forbidden);
    const ref = { channelId: KICK_CHANNEL, messageId: '900000000000000001' };
    expect(await notifier.postSummary(ref, routedSummary())).toEqual({ status: 'transient', reason: 'forbidden' });
    expect(transport.calls).toHaveLength(1);
  });

  it('posts in the current route when the old channel is no longer configured and unreachable', async () => {
    const { notifier, transport } = makeNotifier();
    transport.push(forbidden);
    const ref = { channelId: '700000000000000098', messageId: '900000000000000001' };
    expect(await notifier.postSummary(ref, routedSummary())).toEqual({ status: 'done', ref: { channelId: TWITCH_CHANNEL, messageId: 'm1' } });
  });

  it('falls back to the default live channel when the summary route is unusable', async () => {
    const { notifier, transport, warnings } = makeNotifier();
    transport.push(missing);
    expect(await notifier.postSummary(null, routedSummary())).toEqual({ status: 'done', ref: { channelId: LIVE_CHANNEL, messageId: 'm2' } });
    expect(warnings()[0]!.details).toMatchObject({ routed: true, channelId: TWITCH_CHANNEL });
  });

  it('lists every configured live channel', () => {
    expect([...configuredLiveChannels(liveSettings({ routing: { liveByPlatform: { kick: KICK_CHANNEL, twitch: ' ' } } }))].sort()).toEqual([LIVE_CHANNEL, KICK_CHANNEL].sort());
  });
});

describe('#4 content routing', () => {
  const routing = { contentByKind: { clip: CLIP_CHANNEL }, contentByPlatform: { youtube: YT_CHANNEL }, liveByPlatform: {} };
  const routed = (features: GuildFeaturesPatch = {}) => withFeatures({ routing, ...features }, { contentChannelId: CONTENT_CHANNEL });

  it('kind route > platform route > default channel', async () => {
    const { notifier, transport } = makeNotifier();
    await notifier.postContent(contentView({ settings: routed() }, { kind: 'clip' }));
    await notifier.postContent(contentView({ settings: routed() }, { kind: 'video' }));
    await notifier.postContent(
      contentView({ settings: routed(), channel: { id: 21, platform: 'kick', displayName: 'k', handle: 'k', url: 'https://kick.com/k', avatarUrl: null } }, { kind: 'vod' }),
    );
    expect(transport.calls.map((c) => c.channelId)).toEqual([CLIP_CHANNEL, YT_CHANNEL, CONTENT_CHANNEL]);
  });

  it('skips quietly when no channel resolves', async () => {
    const { notifier, transport } = makeNotifier();
    const kick = { id: 21, platform: 'kick' as const, displayName: 'k', handle: 'k', url: 'https://kick.com/k', avatarUrl: null };
    expect(await notifier.postContent(contentView({ settings: withFeatures({ routing }), channel: kick }, { kind: 'short' }))).toBeNull();
    expect(transport.calls).toHaveLength(0);
  });

  it('falls back to the default content channel and names the content kind in the warning', async () => {
    const { notifier, transport, warnings } = makeNotifier();
    transport.push(forbidden);
    expect(await notifier.postContent(contentView({ settings: routed() }, { kind: 'clip' }))).toEqual({ channelId: CONTENT_CHANNEL, messageId: 'm2' });
    expect(warnings()[0]!.message.startsWith('توجيه كليب: ')).toBe(true);
  });
});

describe('#10 silent notifications', () => {
  it('sends new live and content posts silently when enabled, and edits never carry the flag', async () => {
    const { notifier, transport } = makeNotifier();
    const silent = withFeatures({ silent: { live: true, content: true } }, { liveChannelId: LIVE_CHANNEL, contentChannelId: CONTENT_CHANNEL });
    const view = liveView([platformView('twitch')], { settings: silent });
    await notifier.postLive(view);
    await notifier.updateLive({ channelId: LIVE_CHANNEL, messageId: '900000000000000001' }, view);
    await notifier.postContent(contentView({ settings: silent }));
    expect(transport.calls.map((c) => [c.op, c.message.silent ?? false])).toEqual([
      ['send', true],
      ['edit', false],
      ['send', true],
    ]);
  });

  it('is off by default and per kind', async () => {
    const { notifier, transport } = makeNotifier();
    const liveOnly = withFeatures({ silent: { live: true, content: false } }, { liveChannelId: LIVE_CHANNEL, contentChannelId: CONTENT_CHANNEL });
    await notifier.postContent(contentView({ settings: liveOnly }));
    await notifier.postLive(liveView([platformView('twitch')], { settings: settings({ liveChannelId: LIVE_CHANNEL }) }));
    expect(transport.calls.map((c) => c.message.silent)).toEqual([undefined, undefined]);
  });

  it('keeps the flag through fallbacks, emoji retries and image re-hosting', async () => {
    const emojis = resolvePlatformEmojis([{ id: '123456789012345678', name: 'kick' }]);
    const { notifier, transport } = makeNotifier({ emojis });
    transport.push(forbidden, { ok: false, reason: 'invalid', detail: 'emoji' });
    await notifier.postLive(liveView([platformView('kick')], { settings: liveSettings({ silent: { live: true, content: false } }) }));
    expect(transport.calls.map((c) => [c.channelId, c.message.silent])).toEqual([
      [KICK_CHANNEL, true],
      [LIVE_CHANNEL, true],
      [LIVE_CHANNEL, true],
    ]);
  });

  it('sends a newly posted summary silently but edits the live message without flags', async () => {
    const { notifier, transport } = makeNotifier();
    const s = withFeatures({ silent: { live: true, content: false } }, { liveChannelId: LIVE_CHANNEL });
    transport.push({ ok: false, reason: 'gone', detail: 'Unknown Message' });
    await notifier.postSummary({ channelId: LIVE_CHANNEL, messageId: '900000000000000001' }, summaryView({ settings: s }));
    expect(transport.calls.map((c) => [c.op, c.message.silent ?? false])).toEqual([
      ['edit', false],
      ['send', true],
    ]);
  });
});

describe('#1 notify role pings in the notifier', () => {
  it('pings the notify role on live posts (and keeps it on edits) but not on content by default', async () => {
    const { notifier, transport } = makeNotifier();
    const s = withFeatures({ notifyRole: { roleId: NOTIFY } }, { liveChannelId: LIVE_CHANNEL, contentChannelId: CONTENT_CHANNEL });
    const view = liveView([platformView('twitch')], { settings: s });
    await notifier.postLive(view);
    await notifier.updateLive({ channelId: LIVE_CHANNEL, messageId: '900000000000000001' }, view);
    await notifier.postContent(contentView({ settings: s }));
    expect(transport.calls.map((c) => [c.message.content, c.message.allowedMentions])).toEqual([
      [`<@&${NOTIFY}>`, { parse: [], roles: [NOTIFY], repliedUser: false }],
      [`<@&${NOTIFY}>`, { parse: [], roles: [NOTIFY], repliedUser: false }],
      ['', { parse: [], repliedUser: false }],
    ]);
  });

  it('pings on content posts with pingOnContent, combined with the classic ping', async () => {
    const { notifier, transport } = makeNotifier();
    const s = withFeatures({ notifyRole: { roleId: NOTIFY, pingOnContent: true } }, { contentChannelId: CONTENT_CHANNEL, pingMode: 'role', pingRoleId: ROLE });
    await notifier.postContent(contentView({ settings: s }));
    expect(transport.calls[0]!.message.content).toBe(`<@&${ROLE}> <@&${NOTIFY}>`);
    expect(transport.calls[0]!.message.allowedMentions).toEqual({ parse: [], roles: [ROLE, NOTIFY], repliedUser: false });
  });

  it('never pings in summaries', async () => {
    const { notifier, transport } = makeNotifier();
    const s = withFeatures({ notifyRole: { roleId: NOTIFY } }, { liveChannelId: LIVE_CHANNEL });
    await notifier.postSummary(null, summaryView({ settings: s }));
    expect(transport.calls[0]!.message.allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(transport.calls[0]!.message.content).toBe('');
  });
});

describe('#6 postDigest', () => {
  it('returns null without entries or without a channel', async () => {
    const { notifier, transport } = makeNotifier();
    expect(await notifier.postDigest(digestView(0))).toBeNull();
    expect(await notifier.postDigest(digestView(2, { settings: settings() }))).toBeNull();
    expect(transport.calls).toHaveLength(0);
  });

  it('posts in the content channel without pings, silent when content is silent', async () => {
    const { notifier, transport } = makeNotifier();
    const s = withFeatures({ silent: { live: false, content: true }, notifyRole: { roleId: NOTIFY, pingOnContent: true } }, { contentChannelId: CONTENT_CHANNEL, pingMode: 'everyone' });
    expect(await notifier.postDigest(digestView(3, { settings: s }))).toEqual({ channelId: CONTENT_CHANNEL, messageId: 'm1' });
    const { message } = transport.calls[0]!;
    expect(message.content).toBe('');
    expect(message.allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(message.silent).toBe(true);
    expect(message.embeds[0]!.title).toContain('أفضل كليبات اليوم');
  });

  it('uses the digest channel, then the clip route, and falls back to the default content channel', async () => {
    const { notifier, transport, warnings } = makeNotifier();
    const clipRoute = withFeatures({ routing: { contentByKind: { clip: CLIP_CHANNEL } } }, { contentChannelId: CONTENT_CHANNEL });
    await notifier.postDigest(digestView(1, { settings: clipRoute }));
    const digest = withFeatures({ clips: { digestChannelId: DIGEST_CHANNEL } }, { contentChannelId: CONTENT_CHANNEL });
    transport.push(missing);
    expect(await notifier.postDigest(digestView(1, { settings: digest }))).toEqual({ channelId: CONTENT_CHANNEL, messageId: 'm3' });
    expect(transport.calls.map((c) => c.channelId)).toEqual([CLIP_CHANNEL, DIGEST_CHANNEL, CONTENT_CHANNEL]);
    expect(warnings()[0]!.message.startsWith('توجيه ملخص الكليبات: ')).toBe(true);
  });

  it('never throws, even when the transport does', async () => {
    const { notifier, transport } = makeNotifier();
    transport.throwNext = true;
    expect(await notifier.postDigest(digestView(1))).toBeNull();
  });
});

describe('#15 presence notifications', () => {
  it('posts in the live route of the presence platform, silently when configured', async () => {
    const { notifier, transport } = makeNotifier();
    const s = withFeatures({ routing: { liveByPlatform: { twitch: TWITCH_CHANNEL } }, silent: { live: true, content: false } }, { liveChannelId: LIVE_CHANNEL });
    expect(await notifier.postPresenceLive(presenceView({ settings: s }))).toEqual({ channelId: TWITCH_CHANNEL, messageId: 'm1' });
    expect(transport.calls[0]!.message.silent).toBe(true);
    expect(await notifier.postPresenceLive(presenceView({ settings: s, platform: null }))).toEqual({ channelId: LIVE_CHANNEL, messageId: 'm2' });
  });

  it('pings only for registered streamers', async () => {
    const { notifier, transport } = makeNotifier();
    const s = withFeatures({ notifyRole: { roleId: NOTIFY } }, { liveChannelId: LIVE_CHANNEL, pingMode: 'everyone' });
    await notifier.postPresenceLive(presenceView({ settings: s }));
    await notifier.postPresenceLive(presenceView({ settings: s, streamer: streamer() }));
    expect(transport.calls.map((c) => [c.message.content, c.message.allowedMentions.parse])).toEqual([
      ['', []],
      [`@everyone <@&${NOTIFY}>`, ['everyone']],
    ]);
  });

  it('returns null without a channel and when posting fails', async () => {
    const { notifier, transport } = makeNotifier();
    expect(await notifier.postPresenceLive(presenceView({ settings: settings() }))).toBeNull();
    transport.push({ ok: false, reason: 'error', detail: '503' });
    expect(await notifier.postPresenceLive(presenceView())).toBeNull();
  });

  it('edits the card into "ended" without flags or pings', async () => {
    const { notifier, transport } = makeNotifier();
    const s = withFeatures({ silent: { live: true, content: true } }, { liveChannelId: LIVE_CHANNEL, pingMode: 'everyone' });
    const ref = { channelId: LIVE_CHANNEL, messageId: '900000000000000001' };
    expect(await notifier.endPresenceLive(ref, presenceView({ settings: s, endedAt: new Date().toISOString() }))).toBe(true);
    const call = transport.calls[0]!;
    expect(call).toMatchObject({ op: 'edit', channelId: LIVE_CHANNEL, messageId: ref.messageId });
    expect(call.message.silent).toBeUndefined();
    expect(call.message.content).toBe('');
    expect(call.message.allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(call.message.embeds[0]!.title).toBe('⚫ انتهى البث');
  });

  it("returns false only when the message is gone; other failures keep it (true) and access problems are reported", async () => {
    const { notifier, transport, warnings } = makeNotifier();
    const ref = { channelId: LIVE_CHANNEL, messageId: '900000000000000001' };
    transport.push({ ok: false, reason: 'gone', detail: 'Unknown Message' });
    expect(await notifier.endPresenceLive(ref, presenceView())).toBe(false);
    transport.push(missing);
    expect(await notifier.endPresenceLive(ref, presenceView())).toBe(false);
    transport.push(forbidden);
    expect(await notifier.endPresenceLive(ref, presenceView())).toBe(true);
    expect(warnings().map((w) => w.details.reason)).toEqual(['forbidden']);
    transport.push({ ok: false, reason: 'error', detail: '503' });
    expect(await notifier.endPresenceLive(ref, presenceView())).toBe(true);
    transport.throwNext = true;
    expect(await notifier.endPresenceLive(ref, presenceView())).toBe(true);
  });
});

describe('robustness', () => {
  it('never throws when recording a warning fails', async () => {
    const { notifier, transport, audit } = makeNotifier();
    vi.spyOn(audit, 'record').mockImplementation(() => {
      throw new Error('database is locked');
    });
    transport.push(forbidden, forbidden);
    await expect(notifier.postLive(liveView([platformView('kick')], { settings: liveSettings() }))).resolves.toBeNull();
  });
});
