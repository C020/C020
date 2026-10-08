import { ButtonStyle, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { buildLinkReply } from '../../src/discord/commands/link.js';
import { buildPostReply } from '../../src/discord/commands/post.js';
import { commandDefinitions, dispatchCommand } from '../../src/discord/commands/index.js';
import { commandContext, embedText, fakeLinks, fakeManualPosts, FakeCommandInteraction, GUILD, setFeatures, USER } from './interactionHelpers.js';

const run = (i: FakeCommandInteraction, env: Parameters<typeof dispatchCommand>[1]) => dispatchCommand(i as unknown as ChatInputCommandInteraction, env);

describe('v2 command definitions', () => {
  const defs = Object.fromEntries(commandDefinitions().map((d) => [d.name, d]));

  it('lets everyone use /link and /unlink, and restricts /post to Manage Server', () => {
    expect(defs.link!.default_member_permissions ?? null).toBeNull();
    expect(defs.unlink!.default_member_permissions ?? null).toBeNull();
    expect(defs.post!.default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
    const platform = (defs.link!.options as Array<{ name: string; choices: Array<{ value: string }> }>)[0]!;
    expect(platform.choices.map((c) => c.value)).toEqual(['twitch', 'tiktok']);
  });

  it('offers /bot panel with notify/apply and English localizations', () => {
    const panel = (defs.bot!.options as Array<{ name: string; options?: Array<{ choices?: Array<{ value: string; name_localizations?: Record<string, string> }> }> }>).find(
      (o) => o.name === 'panel',
    )!;
    expect(panel.options![0]!.choices!.map((c) => c.value)).toEqual(['notify', 'apply']);
    expect(panel.options![0]!.choices![0]!.name_localizations?.['en-US']).toBe('Notification role button');
    expect(defs.bot!.description_localizations?.['en-US']).toBe('Bot status and tools');
  });
});

describe('/link and /unlink (#11)', () => {
  it('explains when linking is off or the service is missing', async () => {
    const ctx = commandContext({ links: fakeLinks() });
    const off = new FakeCommandInteraction('link', { strings: { platform: 'twitch' } });
    await run(off, ctx.env);
    expect(off.calls[0]).toEqual({ op: 'deferReply', payload: { flags: MessageFlags.Ephemeral } });
    expect(off.lastEmbed().description).toBe('ربط الحسابات الرسمي مو مفعّل في هذا السيرفر');

    const missing = commandContext();
    setFeatures(missing.repos, { linking: { enabled: true } });
    const i = new FakeCommandInteraction('link', { strings: { platform: 'twitch' } });
    await run(i, missing.env);
    expect(i.lastEmbed().description).toContain('مو جاهزة');
  });

  it('explains when the platform is not configured by the bot owner (English guild)', async () => {
    const ctx = commandContext({ links: fakeLinks({ isAvailable: (p) => p === 'twitch' }) });
    setFeatures(ctx.repos, { linking: { enabled: true }, language: 'en' });
    const i = new FakeCommandInteraction('link', { strings: { platform: 'tiktok' } });
    await run(i, ctx.env);
    expect(i.lastEmbed().description).toBe('TikTok linking is not available — the bot owner has not configured it');
  });

  it('replies with a personal link button and the current link', async () => {
    const links = fakeLinks({
      linksFor: () => [
        {
          id: 1,
          discordUserId: USER,
          platform: 'twitch',
          platformUserId: '123',
          platformLogin: 'abufahad',
          displayName: 'AbuFahad',
          accessTokenEnc: null,
          refreshTokenEnc: null,
          scopes: [],
          accessExpiresAt: null,
          refreshExpiresAt: null,
          createdAt: '',
          updatedAt: '',
        },
      ],
    });
    const ctx = commandContext({ links });
    setFeatures(ctx.repos, { linking: { enabled: true } });
    const i = new FakeCommandInteraction('link', { strings: { platform: 'twitch' } });
    await run(i, ctx.env);
    const reply = i.last();
    expect(reply.components![0]!.components[0]).toMatchObject({ style: ButtonStyle.Link, url: `https://bot.example.com/link/start?t=${GUILD}.${USER}.twitch`, label: 'ربط Twitch' });
    expect(embedText(reply.embeds![0]!)).toContain('abufahad');
    expect(embedText(reply.embeds![0]!)).toContain('ينتهي بعد 15 دقيقة');
  });

  it('builds the link reply purely (escaping the current login)', () => {
    const reply = buildLinkReply('tiktok', 'https://x.example/start', 'en', '*evil*');
    expect(reply.embeds[0]!.title).toBe('🔗 Link your TikTok account');
    expect(reply.embeds[0]!.description).toContain('\\*evil\\*');
    expect(buildLinkReply('twitch', 'https://x.example/start', 'ar', null).embeds[0]!.description).not.toContain('المربوط حالياً');
  });

  it('unlinks (even after the feature was turned off) and says when nothing was linked', async () => {
    const links = fakeLinks();
    const ctx = commandContext({ links });
    const i = new FakeCommandInteraction('unlink', { strings: { platform: 'tiktok' } });
    await run(i, ctx.env);
    expect(links.unlinkCalls).toEqual([[USER, 'tiktok', `user:${USER}`]]);
    expect(i.lastEmbed().title).toBe('✅ تم فك ربط حسابك في TikTok');

    const none = commandContext({ links: fakeLinks({ unlink: async () => false }) });
    const j = new FakeCommandInteraction('unlink', { strings: { platform: 'twitch' } });
    await run(j, none.env);
    expect(j.lastEmbed().description).toBe('ما عندك حساب Twitch مربوط');
  });

  it('rejects unknown platforms', async () => {
    const ctx = commandContext({ links: fakeLinks() });
    const i = new FakeCommandInteraction('unlink', { strings: { platform: 'kick' } });
    await run(i, ctx.env);
    expect(i.lastEmbed().description).toBe('المنصة غير معروفة');
  });
});

describe('/post (#14)', () => {
  const url = 'https://kick.com/abufahad/clips/clip_01';

  it('is gated by the feature switch and the service', async () => {
    const ctx = commandContext({ manualPosts: fakeManualPosts() });
    const i = new FakeCommandInteraction('post', { strings: { url } });
    await run(i, ctx.env);
    expect(i.lastEmbed().description).toBe('النشر اليدوي مو مفعّل — فعّله من لوحة التحكم');

    const noService = commandContext();
    setFeatures(noService.repos, { manualPosts: { enabled: true } });
    const j = new FakeCommandInteraction('post', { strings: { url } });
    await run(j, noService.env);
    expect(j.lastEmbed().description).toContain('مو جاهزة');
  });

  it('posts with the optional title and registered streamer, then links the message', async () => {
    const manual = fakeManualPosts();
    const ctx = commandContext({ manualPosts: manual });
    setFeatures(ctx.repos, { manualPosts: { enabled: true } });
    const streamer = ctx.repos.streamers.create({ guildId: GUILD, discordUserId: USER, displayName: 'أبو فهد' });
    const i = new FakeCommandInteraction('post', { strings: { url: `  ${url} `, title: ' أقوى لقطة ' }, users: { streamer: { id: USER } } });
    await run(i, ctx.env);
    expect(manual.posts).toEqual([{ url, title: 'أقوى لقطة', streamerId: streamer.id }]);
    const text = embedText(i.lastEmbed());
    expect(text).toContain('✅ تم نشر المقطع');
    expect(text).toContain('💚 **Kick** • كليب • أبو فهد');
    expect(text).toContain(`(https://discord.com/channels/${GUILD}/300000000000000020/970000000000000001)`);
  });

  it('refuses unregistered streamers, duplicates and unsupported URLs', async () => {
    const ctx = commandContext({
      manualPosts: fakeManualPosts({
        inspect: async (_g, u) => {
          if (u.includes('example.com')) throw new ValidationError('الرابط غير مدعوم');
          return { platform: 'twitch', kind: 'clip', contentId: 'x', url: u, title: null, thumbnailUrl: null, streamer: null, channelId: null, alreadyPosted: true };
        },
      }),
    });
    setFeatures(ctx.repos, { manualPosts: { enabled: true } });
    const stranger = new FakeCommandInteraction('post', { strings: { url }, users: { streamer: { id: '200000000000000555' } } });
    await run(stranger, ctx.env);
    expect(stranger.lastEmbed().description).toBe('<@200000000000000555> مو مسجّل كستريمر');

    const dup = new FakeCommandInteraction('post', { strings: { url } });
    await run(dup, ctx.env);
    expect(dup.lastEmbed().description).toBe('هذا المقطع انتشر في السيرفر من قبل');

    const bad = new FakeCommandInteraction('post', { strings: { url: 'https://example.com/x' } });
    await run(bad, ctx.env);
    expect(bad.lastEmbed().description).toBe('الرابط غير مدعوم');
  });

  it('says when the message could not be posted', () => {
    const reply = buildPostReply({ platform: 'youtube', kind: 'short', title: null, url: 'https://youtu.be/x', streamerName: null }, null, null, 'en');
    expect(reply.embeds![0]!.description).toContain('Saved, but the message was not posted');
    const ok = buildPostReply({ platform: 'youtube', kind: 'short', title: 'Hi *there*', url: 'https://youtu.be/x', streamerName: null }, { channelId: '1', messageId: '2' }, 'https://discord.com/channels/1/1/2', 'en');
    expect(ok.embeds![0]!.description).toContain('▶️ **YouTube** • Short');
    expect(ok.embeds![0]!.description).toContain('Hi \\*there\\*');
    expect(ok.embeds![0]!.description).toContain('[Open the message](https://discord.com/channels/1/1/2)');
  });
});

describe('/bot panel', () => {
  it('posts the panel, audits it and links the message', async () => {
    const ctx = commandContext();
    const i = new FakeCommandInteraction('bot', { subcommand: 'panel', strings: { type: 'notify' } });
    await run(i, ctx.env);
    expect(ctx.postPanel).toHaveBeenCalledWith(GUILD, 'notify');
    expect(i.lastEmbed().title).toBe('✅ تم نشر رسالة زر الإشعارات');
    expect(i.lastEmbed().description).toContain('https://discord.com/channels/');
    expect(ctx.audits('panel.')[0]).toMatchObject({ action: 'panel.posted', actor: `user:${USER}` });
  });

  it('shows the panel validation error in the guild language', async () => {
    const ctx = commandContext();
    setFeatures(ctx.repos, { language: 'en' });
    ctx.postPanel.mockRejectedValueOnce(new ValidationError('Enable streamer applications in the settings first'));
    const i = new FakeCommandInteraction('bot', { subcommand: 'panel', strings: { type: 'apply' } });
    await run(i, ctx.env);
    expect(i.lastEmbed()).toMatchObject({ title: '⚠️ That did not work', description: 'Enable streamer applications in the settings first' });
  });

  it('rejects unknown panel kinds', async () => {
    const ctx = commandContext();
    const i = new FakeCommandInteraction('bot', { subcommand: 'panel', strings: { type: 'other' } });
    await run(i, ctx.env);
    expect(ctx.postPanel).not.toHaveBeenCalled();
    expect(i.lastEmbed().description).toBe('نوع الرسالة غير معروف');
  });
});

describe('command dispatcher language', () => {
  it('answers "still starting" in the guild language and refuses DMs', async () => {
    const dm = new FakeCommandInteraction('live', { guildId: null });
    await run(dm, null);
    expect(dm.last().content).toBe('أوامر البوت تشتغل داخل السيرفر بس');

    const early = new FakeCommandInteraction('live');
    await run(early, null);
    expect(early.lastEmbed().title).toBe('⏳ البوت لسا يجهز');
  });

  it('renders /live in English for English guilds', async () => {
    const ctx = commandContext();
    setFeatures(ctx.repos, { language: 'en' });
    const i = new FakeCommandInteraction('live');
    await run(i, ctx.env);
    expect(i.lastEmbed().title).toBe('😴 Nobody is live right now');
  });
});
