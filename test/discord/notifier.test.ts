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

  it('treats a thrown transport error as a failed (transient) post', async () => {
    const { notifier, transport, deliveryWarnings } = setup();
    transport.throwNext = true;
    expect(await notifier.postLive(live())).toBeNull();
    expect(deliveryWarnings().map((w) => w.details.reason)).toEqual(['error']);
  });
});

describe('updateLive', () => {
  it('edits with the same ping and allowedMentions as the original post', async () => {
    const { notifier, transport } = setup();
    expect(await notifier.updateLive(REF, live({ pingMode: 'everyone' }))).toBe('ok');
    expect(transport.calls[0]).toMatchObject({ op: 'edit', channelId: LIVE_CHANNEL, messageId: REF.messageId });
    expect(transport.calls[0]!.message.content).toBe('@everyone');
    expect(transport.calls[0]!.message.allowedMentions.parse).toEqual(['everyone']);
  });

  it.each(['gone', 'channel_missing', 'wrong_guild', 'not_text'] as const)("reports 'gone' when the message no longer exists (%s)", async (reason) => {
    const { notifier, transport } = setup();
    transport.push({ ok: false, reason, detail: reason });
    expect(await notifier.updateLive(REF, live())).toBe('gone');
  });

  it("reports 'forbidden' (not 'gone') when access to the channel is lost, and warns the admins", async () => {
    const { notifier, transport, deliveryWarnings } = setup();
    transport.push({ ok: false, reason: 'forbidden', detail: 'Missing Access' });
    expect(await notifier.updateLive(REF, live())).toBe('forbidden');
    expect(deliveryWarnings().map((w) => w.details.reason)).toEqual(['forbidden']);
  });

  it.each(['error', 'not_ready'] as const)("reports 'transient' and keeps the message on transient failures (%s)", async (reason) => {
    const { notifier, transport } = setup();
    transport.push({ ok: false, reason, detail: reason });
    expect(await notifier.updateLive(REF, live())).toBe('transient');
    expect(transport.calls.map((c) => c.op)).toEqual(['edit']);
  });

  it('treats a refused payload as rendered (resending it cannot succeed) and reports it', async () => {
    const { notifier, transport, deliveryWarnings } = setup();
    transport.push({ ok: false, reason: 'invalid', detail: '50035' });
    expect(await notifier.updateLive(REF, live())).toBe('ok');
    expect(deliveryWarnings().map((w) => w.details.reason)).toEqual(['invalid']);
  });

  it("reports 'transient' when the transport throws", async () => {
    const { notifier, transport } = setup();
    transport.throwNext = true;
    expect(await notifier.updateLive(REF, live())).toBe('transient');
  });
});

describe('postSummary', () => {
  const summary = (patch: Parameters<typeof settings>[0] = {}, view: Partial<Parameters<typeof summaryView>[0]> = {}) =>
    summaryView({ settings: settings({ liveChannelId: LIVE_CHANNEL, pingMode: 'everyone', ...patch }), ...view });
  const disabled = { options: { ...settings().options, summaryEnabled: false } };

  it('edits the live message into the summary, without the ping', async () => {
    const { notifier, transport } = setup();
    expect(await notifier.postSummary(REF, summary())).toEqual({ status: 'done', ref: REF });
    expect(transport.calls).toHaveLength(1);
    const { message } = transport.calls[0]!;
    expect(message.content).toBe('');
    expect(message.allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(message.embeds[0]!.title).toBe('⚫ انتهى بث أبو فهد');
  });

  it('posts a new summary when the live message is gone', async () => {
    const { notifier, transport } = setup();
    transport.push({ ok: false, reason: 'gone', detail: 'Unknown Message' });
    expect(await notifier.postSummary(REF, summary())).toEqual({ status: 'done', ref: { channelId: LIVE_CHANNEL, messageId: 'm1' } });
    expect(transport.calls.map((c) => c.op)).toEqual(['edit', 'send']);
  });

  it.each(['error', 'not_ready'] as const)("never posts a duplicate on a transient failure and reports 'transient' (%s)", async (reason) => {
    const { notifier, transport } = setup();
    transport.push({ ok: false, reason, detail: '503' });
    expect(await notifier.postSummary(REF, summary())).toEqual({ status: 'transient', reason });
    expect(transport.calls.map((c) => c.op)).toEqual(['edit']);
  });

  it('warns the admins (in Arabic, once per hour) when a summary cannot be delivered because of a Discord error', async () => {
    const { notifier, transport, deliveryWarnings } = setup();
    transport.push({ ok: false, reason: 'error', detail: '503' }, { ok: false, reason: 'error', detail: '503' });
    await notifier.postSummary(REF, summary());
    await notifier.postSummary(REF, summary());
    expect(deliveryWarnings()).toHaveLength(1);
    expect(deliveryWarnings()[0]!.message).toContain('تعذّر إيصال رسالة إشعارات البث');
  });

  it("keeps the old message when access was lost ('transient', no duplicate in the same channel)", async () => {
    const { notifier, transport, deliveryWarnings } = setup();
    transport.push({ ok: false, reason: 'forbidden', detail: 'Missing Access' });
    expect(await notifier.postSummary(REF, summary())).toEqual({ status: 'transient', reason: 'forbidden' });
    expect(transport.calls.map((c) => c.op)).toEqual(['edit']);
    expect(deliveryWarnings().map((w) => w.details.reason)).toEqual(['forbidden']);
  });

  it('posts the summary in the new live channel when the old one became unreachable after the admin moved it', async () => {
    const { notifier, transport } = setup();
    const moved = '444444444444444444';
    transport.push({ ok: false, reason: 'forbidden', detail: 'Missing Access' });
    expect(await notifier.postSummary(REF, summary({ liveChannelId: moved }))).toEqual({ status: 'done', ref: { channelId: moved, messageId: 'm1' } });
    expect(transport.calls.map((c) => [c.op, c.channelId])).toEqual([
      ['edit', LIVE_CHANNEL],
      ['send', moved],
    ]);
  });

  it('falls back to the minimal ended card when Discord refuses the full summary, so the LIVE card never stays', async () => {
    const { notifier, transport } = setup();
    transport.push({ ok: false, reason: 'invalid', detail: '50035 embeds.0.image.url' });
    expect(await notifier.postSummary(REF, summary())).toEqual({ status: 'done', ref: REF });
    expect(transport.calls.map((c) => [c.op, c.message.embeds[0]!.title])).toEqual([
      ['edit', '⚫ انتهى بث أبو فهد'],
      ['edit', '⚫ انتهى البث'],
    ]);
  });

  it('posts a new summary when there was no live message', async () => {
    const { notifier, transport } = setup();
    expect(await notifier.postSummary(null, summary())).toEqual({ status: 'done', ref: { channelId: LIVE_CHANNEL, messageId: 'm1' } });
    expect(transport.calls[0]!.op).toBe('send');
  });

  it("reports 'transient' when posting a new summary fails transiently", async () => {
    const { notifier, transport } = setup();
    transport.push({ ok: false, reason: 'error', detail: 'timeout' });
    expect(await notifier.postSummary(null, summary())).toEqual({ status: 'transient', reason: 'error' });
  });

  it("with summaries disabled: edits to a minimal ended card and never posts a new message ('skipped')", async () => {
    const { notifier, transport } = setup();
    expect(await notifier.postSummary(REF, summary(disabled))).toEqual({ status: 'done', ref: REF });
    expect(transport.calls[0]!.message.embeds[0]!.title).toBe('⚫ انتهى البث');

    transport.push({ ok: false, reason: 'gone', detail: 'Unknown Message' });
    expect(await notifier.postSummary(REF, summary(disabled))).toEqual({ status: 'skipped' });
    expect(transport.calls.map((c) => c.op)).toEqual(['edit', 'edit']);
  });

  it("is 'skipped' without a ref and without a channel", async () => {
    const { notifier, transport } = setup();
    expect(await notifier.postSummary(null, summary({ liveChannelId: null }))).toEqual({ status: 'skipped' });
    expect(transport.calls).toHaveLength(0);
  });

  describe('expiring (TikTok) images', () => {
    const cover = 'https://p16-webcast.tiktokcdn.com/img/cover.webp?x-expires=1791000000&x-signature=abc';
    const image = () => vi.fn<ImageFetcher>(async () => ({ data: Buffer.from('img'), contentType: 'image/webp' }));

    it('uploads the image with the edit, so the permanent summary keeps it after the signed URL expires', async () => {
      const fetchImage = image();
      const { notifier, transport } = setup({ fetchImage });
      expect(await notifier.postSummary(REF, summary({}, { imageUrl: cover }))).toEqual({ status: 'done', ref: REF });
      expect(fetchImage).toHaveBeenCalledWith(cover);
      const { op, message } = transport.calls[0]!;
      expect(op).toBe('edit');
      expect(message.files).toEqual([{ name: 'image-0.webp', data: Buffer.from('img') }]);
      expect(message.embeds[0]!.image).toEqual({ url: 'attachment://image-0.webp' });
    });

    it('uploads the image with a newly posted summary too', async () => {
      const { notifier, transport } = setup({ fetchImage: image() });
      transport.push({ ok: false, reason: 'gone', detail: 'Unknown Message' });
      await notifier.postSummary(REF, summary({}, { imageUrl: cover }));
      expect(transport.calls.map((c) => [c.op, c.message.files?.length ?? 0])).toEqual([
        ['edit', 1],
        ['send', 1],
      ]);
    });

    it('edits with the linked image when the bot may not upload files', async () => {
      const { notifier, transport, deliveryWarnings } = setup({ fetchImage: image() });
      transport.push({ ok: false, reason: 'forbidden', detail: 'missing AttachFiles', missing: ['AttachFiles'] });
      expect(await notifier.postSummary(REF, summary({}, { imageUrl: cover }))).toEqual({ status: 'done', ref: REF });
      expect(transport.calls[1]!.message.files).toBeUndefined();
      expect(transport.calls[1]!.message.embeds[0]!.image).toEqual({ url: cover });
      expect(deliveryWarnings()[0]!.message).toContain('إرفاق الملفات (Attach Files)');
    });
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

  it('falls back to the linked image when Discord refuses the upload (no Attach Files), and says so', async () => {
    const fetchImage = vi.fn<ImageFetcher>(async () => ({ data: Buffer.from('img'), contentType: 'image/webp' }));
    const { notifier, transport, deliveryWarnings, advance } = setup({ fetchImage });
    const cover = 'https://p16-sign-va.tiktokcdn.com/obj/cover.webp?x-expires=1791000000&x-signature=abc';
    const view = contentView(
      {
        settings: settings({ contentChannelId: CONTENT_CHANNEL }),
        channel: { id: 21, platform: 'tiktok', displayName: 'Abu Fahad', handle: 'abufahad', url: 'https://www.tiktok.com/@abufahad', avatarUrl: null },
      },
      { platform: 'tiktok', platformId: 'abufahad', contentId: '7300000000000000000', url: 'https://www.tiktok.com/@abufahad/video/7300000000000000000', thumbnailUrl: cover },
    );
    // Discord's own 50013 (no pre-check detail) and the transport pre-check both fall back.
    transport.push({ ok: false, reason: 'forbidden', detail: '50013 Missing Permissions' });
    expect(await notifier.postContent(view)).toEqual({ channelId: CONTENT_CHANNEL, messageId: 'm2' });
    const [upload, plain] = transport.calls;
    expect(upload!.message.files).toHaveLength(1);
    expect(plain!.message.files).toBeUndefined();
    expect(plain!.message.embeds[0]!.image).toEqual({ url: cover });
    const warnings = deliveryWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('إرفاق الملفات (Attach Files)');
    expect(warnings[0]!.message).not.toContain('Embed Links');

    advance(60 * 60_000);
    transport.push({ ok: false, reason: 'forbidden', detail: 'missing AttachFiles', missing: ['AttachFiles'] });
    expect(await notifier.postContent(view)).not.toBeNull();
    expect(deliveryWarnings()).toHaveLength(2);
  });

  it('does not resend without files when other posting permissions are missing too', async () => {
    const fetchImage = vi.fn<ImageFetcher>(async () => ({ data: Buffer.from('img'), contentType: 'image/webp' }));
    const { notifier, transport } = setup({ fetchImage });
    const cover = 'https://p16-sign-va.tiktokcdn.com/obj/cover.webp?x-expires=1791000000&x-signature=abc';
    const view = contentView({ settings: settings({ contentChannelId: CONTENT_CHANNEL }) }, { thumbnailUrl: cover });
    transport.push({ ok: false, reason: 'forbidden', detail: 'missing', missing: ['SendMessages', 'AttachFiles'] });
    expect(await notifier.postContent(view)).toBeNull();
    expect(transport.calls).toHaveLength(1);
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

  it('keeps the custom emojis when the unicode retry is refused too (the 400 had nothing to do with emojis)', async () => {
    const emojis = resolvePlatformEmojis([{ id: '123456789012345678', name: 'twitch' }]);
    const { notifier, transport, rejected } = setup({ emojis });
    const invalid = { ok: false as const, reason: 'invalid' as const, detail: '50035 embeds.0.image.url: Not a well formed URL' };
    transport.push(invalid, invalid);
    expect(await notifier.postLive(live())).toBeNull();
    expect(transport.calls).toHaveLength(2);
    expect(rejected).not.toHaveBeenCalled();
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

  it('explains configuration and Discord delivery failures in Arabic, but not a client that is still connecting', () => {
    expect(failureMessageAr({ ok: false, reason: 'channel_missing', detail: '' }, 'content', CONTENT_CHANNEL)).toContain('روم إشعارات المقاطع');
    expect(failureMessageAr({ ok: false, reason: 'wrong_guild', detail: '' }, 'live', LIVE_CHANNEL)).toContain('سيرفر ثاني');
    expect(failureMessageAr({ ok: false, reason: 'error', detail: '', channelName: 'live' }, 'live', LIVE_CHANNEL)).toBe(
      'تعذّر إيصال رسالة إشعارات البث (#live) لديسكورد — غالباً خلل مؤقت في ديسكورد أو الشبكة',
    );
    expect(failureMessageAr({ ok: false, reason: 'not_ready', detail: '' }, 'live', LIVE_CHANNEL)).toBeNull();
  });
});
