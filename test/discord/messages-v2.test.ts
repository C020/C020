/** Builders for #5 (per-streamer templates & color), #6 (clip digest), #15 (presence cards) and the preview helper. */
import { describe, expect, it } from 'vitest';
import { PLATFORM_COLORS } from '../../src/core/types.js';
import { resolvePlatformEmojis } from '../../src/discord/emojis.js';
import {
  buildContentMessage,
  buildDigestMessage,
  buildLiveMessage,
  buildPresenceEndedMessage,
  buildPresenceLiveMessage,
  buildPreviewMessage,
  buildSummaryMessage,
  ENDED_COLOR,
  STREAMING_COLOR,
} from '../../src/discord/messages.js';
import { sampleDigestView, samplePresenceView } from '../../src/discord/samples.js';
import { DISCORD_LIMITS } from '../../src/discord/templates.js';
import {
  contentView,
  digestView,
  liveView,
  MIN,
  platformView,
  presenceView,
  ROLE,
  settings,
  streamer,
  summaryView,
  T0,
  USER,
  withFeatures,
} from './helpers.js';

const buttonsOf = (m: { components: Array<{ components: Array<{ label?: string; url: string; emoji?: { name?: string; id?: string } }> }> }) =>
  m.components.flatMap((r) => r.components);

describe('#5 per-streamer templates and color', () => {
  it('layers the streamer template over the guild template, field by field', () => {
    const view = liveView([platformView('twitch')], {
      settings: settings({ templates: { live: { title: 'guild {name}', footer: 'guild footer' } } }),
      streamer: streamer({ templates: { live: { title: 'personal {name}', description: '' } } }),
    });
    const embed = buildLiveMessage(view).embeds[0]!;
    expect(embed.title).toBe('personal أبو فهد');
    expect(embed.description).toBeUndefined(); // '' = intentionally empty
    expect(embed.footer?.text).toBe('guild footer');
  });

  it('applies to summaries and content posts too', () => {
    const personal = streamer({ templates: { summary: { title: 'summary of {name}' }, content: { description: 'new {kind} by {name}' } } });
    expect(buildSummaryMessage(summaryView({ streamer: personal })).embeds[0]!.title).toBe('summary of أبو فهد');
    expect(buildContentMessage(contentView({ streamer: personal })).embeds[0]!.description).toBe('new فيديو by أبو فهد');
  });

  it('a preview override still wins over the streamer template', () => {
    const view = liveView([platformView('twitch')], { streamer: streamer({ templates: { live: { title: 'personal' } } }) });
    expect(buildLiveMessage(view, { template: { title: 'preview' } }).embeds[0]!.title).toBe('preview');
  });

  it('color: streamer template color > guild template color > streamer color > platform color', () => {
    const base = [platformView('kick')];
    expect(buildLiveMessage(liveView(base)).embeds[0]!.color).toBe(PLATFORM_COLORS.kick);
    expect(buildLiveMessage(liveView(base, { streamer: streamer({ color: 0x00ff00 }) })).embeds[0]!.color).toBe(0x00ff00);
    const guildColor = settings({ templates: { live: { color: 0x0000ff } } });
    expect(buildLiveMessage(liveView(base, { settings: guildColor, streamer: streamer({ color: 0x00ff00 }) })).embeds[0]!.color).toBe(0x0000ff);
    const personal = streamer({ color: 0x00ff00, templates: { live: { color: 0xabcdef } } });
    expect(buildLiveMessage(liveView(base, { settings: guildColor, streamer: personal })).embeds[0]!.color).toBe(0xabcdef);
    expect(buildContentMessage(contentView({ streamer: personal })).embeds[0]!.color).toBe(0x00ff00);
  });

  it('works with streamer objects that have no templates (older rows)', () => {
    const legacy = { ...streamer(), templates: undefined } as unknown as ReturnType<typeof streamer>;
    expect(buildLiveMessage(liveView([platformView('twitch')], { streamer: legacy })).embeds[0]!.title).toBe('🔴 أبو فهد يبث الحين!');
  });
});

describe('#6 buildDigestMessage', () => {
  it('lists clips best first with links, streamer and views, plus the top image and buttons', () => {
    const msg = buildDigestMessage(digestView(3), { now: T0 });
    const embed = msg.embeds[0]!;
    expect(msg.content).toBe('');
    expect(embed.title).toBe('🎬 أفضل كليبات اليوم • 2026-10-03');
    expect(embed.description!.split('\n')).toEqual([
      '**1.** 💜 [لقطة رقم 1](https://clips.twitch.tv/Clip1) — ستريمر 1 • 👀 5,000',
      '**2.** 💜 [لقطة رقم 2](https://clips.twitch.tv/Clip2) — ستريمر 2 • 👀 4,000',
      '**3.** 💜 [لقطة رقم 3](https://clips.twitch.tv/Clip3) — ستريمر 3 • 👀 3,000',
    ]);
    expect(embed.image?.url).toBe('https://clips-media-assets2.twitch.tv/clip1-preview-480x272.jpg');
    expect(embed.color).toBe(PLATFORM_COLORS.twitch);
    expect(embed.footer?.text).toBe('3 كليب');
    expect(embed.timestamp).toBe(new Date(T0).toISOString());
    expect(buttonsOf(msg).map((b) => [b.label, b.url])).toEqual([
      ['1. لقطة رقم 1', 'https://clips.twitch.tv/Clip1'],
      ['2. لقطة رقم 2', 'https://clips.twitch.tv/Clip2'],
      ['3. لقطة رقم 3', 'https://clips.twitch.tv/Clip3'],
    ]);
  });

  it('is in English for English guilds and says when the list was capped', () => {
    const view = digestView(2, { total: 7, settings: withFeatures({ language: 'en' }) });
    const embed = buildDigestMessage(view).embeds[0]!;
    expect(embed.title).toBe("🎬 Today's top clips • 2026-10-03");
    expect(embed.footer?.text).toBe('Top 2 of 7 clips');
    expect(buildDigestMessage(digestView(1, { settings: withFeatures({ language: 'en' }) })).embeds[0]!.footer?.text).toBe('1 clip');
  });

  it('caps link buttons at 5 and never exceeds the embed limits', () => {
    const view = digestView(25);
    for (const e of view.entries) e.item.title = `${'عنوان طويل جداً '.repeat(30)}${e.item.contentId}`;
    const msg = buildDigestMessage(view);
    const embed = msg.embeds[0]!;
    expect(buttonsOf(msg)).toHaveLength(5);
    expect(buttonsOf(msg).every((b) => (b.label ?? '').length <= DISCORD_LIMITS.buttonLabel)).toBe(true);
    expect(embed.description!.length).toBeLessThanOrEqual(DISCORD_LIMITS.description);
    const lines = embed.description!.split('\n');
    expect(lines.length).toBeLessThan(26);
    expect(lines[lines.length - 1]).toMatch(/^… و \d+ كليب ثاني$/);
  });

  it('escapes untrusted titles/names and survives missing data', () => {
    const view = digestView(2);
    view.entries[0]!.item.title = '[x](https://evil.example) @everyone **b**';
    view.entries[0]!.item.viewCount = null;
    view.entries[0]!.streamer = null;
    view.entries[1]!.item.title = '';
    view.entries[1]!.item.url = 'not a url';
    view.entries[1]!.item.thumbnailUrl = null;
    const msg = buildDigestMessage(view);
    const [first, second] = msg.embeds[0]!.description!.split('\n');
    expect(first).toBe('**1.** 💜 [\\[x\\](https://evil.example) @​everyone \\*\\*b\\*\\*](https://clips.twitch.tv/Clip1) — Streamer1');
    expect(second).toBe('**2.** 💜 كليب — ستريمر 2 • 👀 4,000');
    // The invalid URL gets no button.
    expect(buttonsOf(msg).map((b) => b.url)).toEqual(['https://clips.twitch.tv/Clip1']);
  });

  it('uses custom platform emojis when available', () => {
    const emojis = resolvePlatformEmojis([{ id: '123456789012345678', name: 'twitch' }]);
    const msg = buildDigestMessage(digestView(1), { emojis });
    expect(msg.embeds[0]!.description).toContain('<:twitch:123456789012345678>');
    expect(buttonsOf(msg)[0]!.emoji).toEqual({ id: '123456789012345678', name: 'twitch' });
  });
});

describe('#15 presence cards', () => {
  it('renders a simple live card from the live template with presence data', () => {
    const msg = buildPresenceLiveMessage(presenceView(), { now: T0 });
    const embed = msg.embeds[0]!;
    expect(embed.title).toBe('🔴 Member Name يبث الحين!');
    expect(embed.description).toBe('**Chill stream**\n🎮 Minecraft');
    expect(embed.url).toBe('https://www.twitch.tv/membername');
    expect(embed.author).toEqual({ name: 'Member Name', icon_url: 'https://cdn.discordapp.com/avatars/2/member.png', url: 'https://www.twitch.tv/membername' });
    expect(embed.color).toBe(PLATFORM_COLORS.twitch);
    expect(embed.footer?.text).toBe('📡 من حالة ديسكورد');
    expect(embed.fields!.map((f) => [f.name, f.value])).toEqual([
      ['📡 المنصة', '💜 Twitch'],
      ['🎮 اللعبة', 'Minecraft'],
      ['⏱️ بدأ', `<t:${Math.floor((T0 - 10 * MIN) / 1000)}:R>`],
    ]);
    expect(embed.timestamp).toBe(new Date(T0 - 10 * MIN).toISOString());
    expect(buttonsOf(msg).map((b) => [b.label, b.url])).toEqual([['شاهد على Twitch', 'https://www.twitch.tv/membername']]);
    expect(msg.content).toBe('');
  });

  it('uses the registered streamer name, templates and color', () => {
    const personal = streamer({ color: 0x123456, templates: { live: { title: '{name} live ({platform})', footer: 'custom footer' } } });
    const embed = buildPresenceLiveMessage(presenceView({ streamer: personal })).embeds[0]!;
    expect(embed.title).toBe('أبو فهد live (Twitch)');
    expect(embed.footer?.text).toBe('custom footer');
    expect(embed.color).toBe(0x123456);
  });

  it('handles unknown platforms, missing URLs and English', () => {
    const view = presenceView({ platform: null, url: null, title: null, game: null, settings: withFeatures({ language: 'en' }) });
    const msg = buildPresenceLiveMessage(view);
    const embed = msg.embeds[0]!;
    expect(embed.title).toBe('🔴 Member Name is live now!');
    expect(embed.description).toBeUndefined();
    expect(embed.color).toBe(STREAMING_COLOR);
    expect(embed.footer?.text).toBe('📡 From Discord status');
    expect(embed.fields!.map((f) => f.name)).toEqual(['⏱️ Started']);
    expect(msg.components).toEqual([]);
    const withUrl = buildPresenceLiveMessage({ ...view, url: 'https://example.com/live' });
    expect(buttonsOf(withUrl).map((b) => b.label)).toEqual(['Watch the stream']);
  });

  it('renders the ended card with duration and a channel button', () => {
    const msg = buildPresenceEndedMessage(presenceView({ endedAt: new Date(T0 + 80 * MIN).toISOString() }));
    const embed = msg.embeds[0]!;
    expect(embed.title).toBe('⚫ انتهى البث');
    expect(embed.description).toBe('**Chill stream**\n⏱️ المدة: 1س 30د');
    expect(embed.color).toBe(ENDED_COLOR);
    expect(embed.timestamp).toBe(new Date(T0 + 80 * MIN).toISOString());
    expect(msg.content).toBe('');
    expect(buttonsOf(msg).map((b) => [b.label, b.url])).toEqual([['قناة Twitch', 'https://www.twitch.tv/membername']]);
  });

  it('uses now when the end is unknown and survives invalid dates', () => {
    const now = T0 + 5 * MIN;
    expect(buildPresenceEndedMessage(presenceView({ settings: withFeatures({ language: 'en' }) }), { now }).embeds[0]!.description).toBe('**Chill stream**\n⏱️ Duration: 15m');
    const broken = buildPresenceEndedMessage(presenceView({ startedAt: 'nope', endedAt: 'nope', title: null }), { now });
    expect(broken.embeds[0]!.description).toBeUndefined();
    expect(broken.embeds[0]!.timestamp).toBe(new Date(now).toISOString());
  });
});

describe('buildPreviewMessage', () => {
  it('previews the guild template with an override and the live ping', () => {
    const s = withFeatures({ notifyRole: { roleId: ROLE } }, { templates: { live: { title: 'saved' } } });
    const preview = buildPreviewMessage(s, 'live', { template: { description: 'edited' }, now: T0 });
    expect(preview.embeds[0]!.title).toBe('saved');
    expect(preview.embeds[0]!.description).toBe('edited');
    expect(preview.embeds[0]!.author?.name).toBe('ستريمر تجريبي');
    expect(preview.content).toBe(`<@&${ROLE}>`);
  });

  it('never shows a ping on summaries and uses the content ping for content', () => {
    const s = withFeatures({ notifyRole: { roleId: ROLE, pingOnContent: true } }, { pingMode: 'here' });
    expect(buildPreviewMessage(s, 'summary', { now: T0 }).content).toBeNull();
    expect(buildPreviewMessage(s, 'content', { now: T0 }).content).toBe(`@here <@&${ROLE}>`);
    expect(buildPreviewMessage(withFeatures({ notifyRole: { roleId: ROLE } }), 'content', { now: T0 }).content).toBeNull();
  });

  it("previews as a streamer: name, mention, color and saved overrides; the edited template replaces the streamer's", () => {
    const s = settings({ templates: { live: { title: 'guild {name}', footer: 'guild footer' } } });
    const personal = streamer({ color: 0x00ff00, templates: { live: { title: 'saved personal', footer: 'personal footer', content: '{mention}' } } });
    const saved = buildPreviewMessage(s, 'live', { streamer: personal, now: T0, avatarUrl: 'https://cdn.discordapp.com/avatars/2/a.png' });
    expect(saved.embeds[0]!.title).toBe('saved personal');
    expect(saved.embeds[0]!.footer?.text).toBe('personal footer');
    expect(saved.embeds[0]!.author).toMatchObject({ name: 'أبو فهد', icon_url: 'https://cdn.discordapp.com/avatars/2/a.png' });
    expect(saved.embeds[0]!.color).toBe(0x00ff00);
    expect(saved.content).toBe(`<@${USER}>`);

    // Editing: fields left out of the edited template inherit the guild template (like after saving).
    const editing = buildPreviewMessage(s, 'live', { streamer: personal, template: { title: 'editing {name}', color: 0xabcdef }, now: T0 });
    expect(editing.embeds[0]!.title).toBe('editing أبو فهد');
    expect(editing.embeds[0]!.footer?.text).toBe('guild footer');
    expect(editing.embeds[0]!.color).toBe(0xabcdef);
    expect(editing.content).toBeNull();
  });

  it('follows the guild language and unicode emojis by default', () => {
    const preview = buildPreviewMessage(withFeatures({ language: 'en' }), 'live', { now: T0 });
    expect(preview.embeds[0]!.title).toBe('🔴 Sample streamer is live now!');
    expect(preview.buttons[0]!.label).toBe('Watch on Twitch');
    expect(preview.buttons[0]!.emoji).toBe('💜');
  });
});

describe('sample digest / presence views', () => {
  it('render through the builders in the guild language', () => {
    const digest = buildDigestMessage(sampleDigestView(withFeatures({ language: 'en' }), T0), { now: T0 });
    expect(digest.embeds[0]!.title).toBe("🎬 Today's top clips • 2026-10-03");
    expect(digest.embeds[0]!.description!.split('\n')[0]).toBe('**1.** 💜 [Insane ace 🔥](https://clips.twitch.tv/SampleClip1) — Sample streamer • 👀 4,210');
    expect(buttonsOf(digest)).toHaveLength(3);

    const presence = buildPresenceLiveMessage(samplePresenceView(settings(), T0, { displayName: 'بوت', discordUserId: USER, avatarUrl: null }));
    expect(presence.embeds[0]!.title).toBe('🔴 بوت يبث الحين!');
    expect(presence.embeds[0]!.description).toContain('VALORANT');
  });
});
