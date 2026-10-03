import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImageFetcher } from '../../src/discord/attachments.js';
import { resolvePlatformEmojis } from '../../src/discord/emojis.js';
import { asTestMessage, buildLogMessages, DiscordNotifier, failureMessageAr } from '../../src/discord/notifier.js';
import { WarnThrottle } from '../../src/discord/util.js';
import {
  CONTENT_CHANNEL,
  contentView,
  db,
  FakeTransport,
  GUILD,
  LIVE_CHANNEL,
  liveView,
  LOG_CHANNEL,
  platformView,
  ROLE,
  settings,
  summaryView,
  T0,
} from './helpers.js';

const REF = { channelId: LIVE_CHANNEL, messageId: '999999999999999999' };

function setup(opts: { emojis?: ReturnType<typeof resolvePlatformEmojis>; now?: () => number; fetchImage?: ImageFetcher } = {}) {
  const { repos, audit } = db();
  const transport = new FakeTransport();
  let emojis = opts.emojis;
  const rejected = vi.fn(() => {
    emojis = undefined;
  });
  let now = T0;
  const clock = opts.now ?? (() => now);
  const notifier = new DiscordNotifier({
    transport,
    repos,
    audit,
    emojis: emojis ? () => emojis ?? resolvePlatformEmojis([]) : undefined,
    onCustomEmojisRejected: rejected,
    avatarFor: () => 'https://cdn.discordapp.com/avatars/2/x.png',
    clock,
    warnThrottle: new WarnThrottle(60 * 60_000, clock),
    logBatchDelayMs: 50,
    fetchImage: opts.fetchImage ?? (async () => null),
  });
  const deliveryWarnings = () => repos.audit.list({ guildId: GUILD }).filter((e) => e.action === 'discord.delivery');
  return { repos, audit, transport, notifier, rejected, deliveryWarnings, advance: (ms: number) => (now += ms) };
}

const live = (patch: Parameters<typeof settings>[0] = {}) => liveView([platformView('twitch')], { settings: settings({ liveChannelId: LIVE_CHANNEL, ...patch }) });

afterEach(() => {
  vi.useRealTimers();
});

describe('postLive', () => {
  it('returns null without a configured channel', async () => {
    const { notifier, transport } = setup();
    expect(await notifier.postLive(liveView([platformView('twitch')]))).toBeNull();
    expect(transport.calls).toHaveLength(0);
  });

  it('posts silently by default and uses the cached Discord avatar', async () => {
    const { notifier, transport } = setup();
    const ref = await notifier.postLive(live());
    expect(ref).toEqual({ channelId: LIVE_CHANNEL, messageId: 'm1' });
    const call = transport.calls[0]!;
    expect(call).toMatchObject({ op: 'send', guildId: GUILD, channelId: LIVE_CHANNEL });
    expect(call.message.content).toBe('');
    expect(call.message.allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(call.message.embeds[0]!.author?.icon_url).toBe('https://cdn.discordapp.com/avatars/2/x.png');
  });

  it('adds the configured ping with matching allowedMentions', async () => {
    const { notifier, transport } = setup();
    await notifier.postLive(live({ pingMode: 'role', pingRoleId: ROLE }));
    expect(transport.calls[0]!.message.content).toBe(`<@&${ROLE}>`);
    expect(transport.calls[0]!.message.allowedMentions).toEqual({ parse: [], roles: [ROLE], repliedUser: false });
  });

  it('returns null and warns once per hour on a permission problem', async () => {
    const { notifier, transport, deliveryWarnings, advance } = setup();
    const forbidden = { ok: false as const, reason: 'forbidden' as const, detail: 'missing', missing: ['EmbedLinks' as const], channelName: 'live' };
    transport.push(forbidden, forbidden, forbidden);
    expect(await notifier.postLive(live())).toBeNull();
    expect(await notifier.postLive(live())).toBeNull();
    expect(deliveryWarnings()).toHaveLength(1);
    expect(deliveryWarnings()[0]!.message).toContain('تضمين الروابط (Embed Links)');
    expect(deliveryWarnings()[0]!.level).toBe('warn');
    advance(60 * 60_000);
    await notifier.postLive(live());
    expect(deliveryWarnings()).toHaveLength(2);
  });

  it('treats a thrown transport error as a failed post', async () => {
    const { notifier, transport, deliveryWarnings } = setup();
    transport.throwNext = true;
    expect(await notifier.postLive(live())).toBeNull();
    expect(deliveryWarnings()).toHaveLength(0);
  });
});

describe('updateLive', () => {
  it('edits with the same ping and allowedMentions as the original post', async () => {
    const { notifier, transport } = setup();
    expect(await notifier.updateLive(REF, live({ pingMode: 'everyone' }))).toBe(true);
    expect(transport.calls[0]).toMatchObject({ op: 'edit', channelId: LIVE_CHANNEL, messageId: REF.messageId });
    expect(transport.calls[0]!.message.content).toBe('@everyone');
    expect(transport.calls[0]!.message.allowedMentions.parse).toEqual(['everyone']);
  });

  it.each(['gone', 'channel_missing', 'wrong_guild', 'not_text', 'forbidden'] as const)('returns false when the message cannot be edited (%s)', async (reason) => {
    const { notifier, transport } = setup();
    transport.push({ ok: false, reason, detail: reason });
    expect(await notifier.updateLive(REF, live())).toBe(false);
  });

  it.each(['error', 'not_ready', 'invalid'] as const)('keeps the message on transient failures (%s)', async (reason) => {
    const { notifier, transport } = setup();
    transport.push({ ok: false, reason, detail: reason });
    expect(await notifier.updateLive(REF, live())).toBe(true);
  });

  it('keeps the message when the transport throws', async () => {
    const { notifier, transport } = setup();
    transport.throwNext = true;
    expect(await notifier.updateLive(REF, live())).toBe(true);
  });
});

describe('postSummary', () => {
  const summary = (patch: Parameters<typeof settings>[0] = {}) => summaryView({ settings: settings({ liveChannelId: LIVE_CHANNEL, pingMode: 'everyone', ...patch }) });

  it('edits the live message into the summary, without the ping', async () => {
    const { notifier, transport } = setup();
    expect(await notifier.postSummary(REF, summary())).toEqual(REF);
    expect(transport.calls).toHaveLength(1);
    const { message } = transport.calls[0]!;
    expect(message.content).toBe('');
    expect(message.allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(message.embeds[0]!.title).toBe('⚫ انتهى بث أبو فهد');
  });

  it('posts a new summary when the live message is gone', async () => {
    const { notifier, transport } = setup();
    transport.push({ ok: false, reason: 'gone', detail: 'Unknown Message' });
    expect(await notifier.postSummary(REF, summary())).toEqual({ channelId: LIVE_CHANNEL, messageId: 'm1' });
    expect(transport.calls.map((c) => c.op)).toEqual(['edit', 'send']);
  });

  it('never posts a duplicate on a transient failure', async () => {
    const { notifier, transport } = setup();
    transport.push({ ok: false, reason: 'error', detail: '500' });
    expect(await notifier.postSummary(REF, summary())).toBeNull();
    expect(transport.calls.map((c) => c.op)).toEqual(['edit']);
  });

  it('posts a new summary when there was no live message', async () => {
    const { notifier, transport } = setup();
    expect(await notifier.postSummary(null, summary())).toEqual({ channelId: LIVE_CHANNEL, messageId: 'm1' });
    expect(transport.calls[0]!.op).toBe('send');
  });

  it('with summaries disabled: edits to a minimal ended card and never posts a new message', async () => {
    const { notifier, transport } = setup();
    expect(await notifier.postSummary(REF, summary({ options: { ...settings().options, summaryEnabled: false } }))).toEqual(REF);
    expect(transport.calls[0]!.message.embeds[0]!.title).toBe('⚫ انتهى البث');

    transport.push({ ok: false, reason: 'gone', detail: 'Unknown Message' });
    expect(await notifier.postSummary(REF, summary({ options: { ...settings().options, summaryEnabled: false } }))).toBeNull();
    expect(transport.calls.map((c) => c.op)).toEqual(['edit', 'edit']);
  });

  it('returns null without a ref and without a channel', async () => {
    const { notifier, transport } = setup();
    expect(await notifier.postSummary(null, summary({ liveChannelId: null }))).toBeNull();
    expect(transport.calls).toHaveLength(0);
  });
});

describe('postContent', () => {
  it('posts to the content channel with the configured ping', async () => {
    const { notifier, transport } = setup();
    const view = contentView({ settings: settings({ contentChannelId: CONTENT_CHANNEL, pingMode: 'here' }) });
    expect(await notifier.postContent(view)).toEqual({ channelId: CONTENT_CHANNEL, messageId: 'm1' });
    expect(transport.calls[0]!.message.content).toBe('@here');
    expect(transport.calls[0]!.message.allowedMentions.parse).toEqual(['everyone']);
  });

  it('returns null without a content channel', async () => {
    const { notifier, transport } = setup();
    expect(await notifier.postContent(contentView())).toBeNull();
    expect(transport.calls).toHaveLength(0);
  });

  it('uploads expiring TikTok thumbnails as attachments instead of linking them', async () => {
    const fetchImage = vi.fn<ImageFetcher>(async () => ({ data: Buffer.from('img'), contentType: 'image/webp' }));
    const { notifier, transport } = setup({ fetchImage });
    const cover = 'https://p16-sign-va.tiktokcdn.com/obj/cover.webp?x-expires=1791000000&x-signature=abc';
    const view = contentView(
      {
        settings: settings({ contentChannelId: CONTENT_CHANNEL }),
        channel: { id: 21, platform: 'tiktok', displayName: 'Abu Fahad', handle: 'abufahad', url: 'https://www.tiktok.com/@abufahad', avatarUrl: null },
      },
      { platform: 'tiktok', platformId: 'abufahad', contentId: '7300000000000000000', url: 'https://www.tiktok.com/@abufahad/video/7300000000000000000', thumbnailUrl: cover },
    );
    expect(await notifier.postContent(view)).not.toBeNull();
    expect(fetchImage).toHaveBeenCalledWith(cover);
    const sent = transport.calls[0]!.message;
    expect(sent.files).toEqual([{ name: 'image-0.webp', data: Buffer.from('img') }]);
    expect(sent.embeds[0]!.image).toEqual({ url: 'attachment://image-0.webp' });
  });

  it('keeps the linked image when the download fails, and never downloads stable CDN images', async () => {
    const fetchImage = vi.fn<ImageFetcher>(async () => null);
    const { notifier, transport } = setup({ fetchImage });
    await notifier.postContent(contentView({ settings: settings({ contentChannelId: CONTENT_CHANNEL }) }));
    expect(fetchImage).not.toHaveBeenCalled();
    expect(transport.calls[0]!.message.files).toBeUndefined();
  });
});

describe('custom emoji fallback', () => {
  it('retries once with unicode emojis when Discord rejects the payload', async () => {
    const emojis = resolvePlatformEmojis([{ id: '123456789012345678', name: 'twitch' }]);
    const { notifier, transport, rejected } = setup({ emojis });
    transport.push({ ok: false, reason: 'invalid', detail: 'Invalid emoji' });
    expect(await notifier.postLive(live())).toEqual({ channelId: LIVE_CHANNEL, messageId: 'm2' });
    expect(rejected).toHaveBeenCalledTimes(1);
    const [first, second] = transport.calls;
    expect(first!.message.components[0]!.components[0]!.emoji).toEqual({ id: '123456789012345678', name: 'twitch' });
    expect(second!.message.components[0]!.components[0]!.emoji).toEqual({ name: '💜' });
  });

  it('does not retry an invalid payload when only unicode emojis were used', async () => {
    const { notifier, transport, rejected } = setup();
    transport.push({ ok: false, reason: 'invalid', detail: 'bad' });
    expect(await notifier.postLive(live())).toBeNull();
    expect(transport.calls).toHaveLength(1);
    expect(rejected).not.toHaveBeenCalled();
  });
});

describe('log channel', () => {
  it('does nothing without a log channel', async () => {
    const { notifier, transport } = setup();
    await notifier.log(GUILD, 'info', 'hello');
    await notifier.close();
    expect(transport.calls).toHaveLength(0);
  });

  it('batches lines into one message', async () => {
    vi.useFakeTimers();
    const { notifier, transport, repos } = setup();
    repos.settings.update(GUILD, { logChannelId: LOG_CHANNEL });
    await notifier.log(GUILD, 'info', 'بدأ البث');
    await notifier.log(GUILD, 'warn', 'تحذير **مهم**');
    await notifier.log(GUILD, 'error', 'خطأ');
    expect(transport.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60);
    expect(transport.calls).toHaveLength(1);
    const { message, channelId } = transport.calls[0]!;
    expect(channelId).toBe(LOG_CHANNEL);
    expect(message.embeds[0]!.description).toBe('🔹 بدأ البث\n⚠️ تحذير \\*\\*مهم\\*\\*\n⛔ خطأ');
    expect(message.embeds[0]!.color).toBe(0xed4245);
    expect(message.allowedMentions).toEqual({ parse: [], repliedUser: false });
  });

  it('never loops when both the live and the log channel are broken', async () => {
    const { notifier, transport, repos, audit, deliveryWarnings } = setup();
    audit.attachNotifier(notifier);
    repos.settings.update(GUILD, { logChannelId: LOG_CHANNEL });
    const forbidden = { ok: false as const, reason: 'forbidden' as const, detail: '403' };
    transport.push(forbidden, forbidden, forbidden, forbidden);
    await notifier.postLive(live());
    await notifier.close();
    expect(transport.calls.map((c) => c.channelId)).toEqual([LIVE_CHANNEL, LOG_CHANNEL]);
    const warnings = deliveryWarnings();
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.details.purpose).sort()).toEqual(['live', 'log']);
  });

  it('splits very long batches into several messages', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ level: 'info' as const, message: `${i} ${'x'.repeat(900)}`, at: T0 }));
    const messages = buildLogMessages(entries);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((m) => (m.embeds[0]!.description ?? '').length <= 4096)).toBe(true);
    expect(messages.flatMap((m) => (m.embeds[0]!.description ?? '').split('\n'))).toHaveLength(10);
  });
});

describe('helpers', () => {
  it('marks test messages and keeps them silent', () => {
    const message = asTestMessage({ content: '@everyone', embeds: [], components: [] });
    expect(message.content.startsWith('🧪 **رسالة تجريبية**')).toBe(true);
    expect(message.allowedMentions).toEqual({ parse: [], repliedUser: false });
  });

  it('explains configuration failures in Arabic and ignores transient ones', () => {
    expect(failureMessageAr({ ok: false, reason: 'channel_missing', detail: '' }, 'content', CONTENT_CHANNEL)).toContain('روم إشعارات المقاطع');
    expect(failureMessageAr({ ok: false, reason: 'wrong_guild', detail: '' }, 'live', LIVE_CHANNEL)).toContain('سيرفر ثاني');
    expect(failureMessageAr({ ok: false, reason: 'error', detail: '' }, 'live', LIVE_CHANNEL)).toBeNull();
    expect(failureMessageAr({ ok: false, reason: 'not_ready', detail: '' }, 'live', LIVE_CHANNEL)).toBeNull();
  });
});
