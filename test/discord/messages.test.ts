import { ButtonStyle, ComponentType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { PLATFORM_COLORS } from '../../src/core/types.js';
import { resolvePlatformEmojis } from '../../src/discord/emojis.js';
import {
  buildContentMessage,
  buildEndedMessage,
  buildLiveMessage,
  buildSummaryMessage,
  ENDED_COLOR,
  fitEmbed,
  kickVideosUrl,
  linkButtonRows,
  toPreview,
} from '../../src/discord/messages.js';
import { contentView, liveView, platformView, session, settings, streamer, summaryView, T0 } from './helpers.js';

const fieldsOf = (m: { embeds: Array<{ fields?: Array<{ name: string; value: string }> }> }) => m.embeds[0]?.fields ?? [];
const buttonsOf = (m: { components: Array<{ components: Array<{ label?: string; url: string; emoji?: { name?: string; id?: string } }> }> }) =>
  m.components.flatMap((r) => r.components);

describe('buildLiveMessage', () => {
  it('renders a single-platform live notification', () => {
    const view = liveView([platformView('twitch', { viewers: 1234 })]);
    const msg = buildLiveMessage(view, { now: T0, avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png' });
    const embed = msg.embeds[0]!;

    expect(msg.content).toBe('');
    expect(embed.title).toBe('🔴 أبو فهد يبث الحين!');
    expect(embed.url).toBe('https://www.twitch.tv/abufahad');
    expect(embed.description).toBe('**رانكد فالورانت**\n🎮 Valorant');
    expect(embed.author).toEqual({ name: 'أبو فهد', icon_url: 'https://cdn.discordapp.com/avatars/1/a.png', url: 'https://www.twitch.tv/abufahad' });
    expect(embed.color).toBe(PLATFORM_COLORS.twitch);
    expect(embed.image?.url).toBe('https://img.example.com/twitch.jpg?t=1');
    expect(embed.thumbnail?.url).toBe('https://static-cdn.jtvnw.net/ttv-boxart/516575-285x380.jpg');
    expect(embed.footer?.text).toBe('تتحدث تلقائياً');
    expect(embed.timestamp).toBe(new Date(T0).toISOString());

    const fields = fieldsOf(msg);
    expect(fields.map((f) => f.name)).toEqual(['💜 Twitch', '⏱️ بدأ']);
    expect(fields[0]!.value).toContain('👀 1,234 مشاهد • 🎮 Valorant');
    expect(fields[1]!.value).toBe(`<t:${Math.floor((T0 - 30 * 60_000) / 1000)}:R>`);

    const buttons = buttonsOf(msg);
    expect(msg.components).toHaveLength(1);
    expect(buttons).toEqual([
      { type: ComponentType.Button, style: ButtonStyle.Link, label: 'شاهد على Twitch', url: 'https://www.twitch.tv/abufahad', emoji: { name: '💜' } },
    ]);
  });

  it('combines several platforms into one message with one button each and a total', () => {
    const view = liveView([
      platformView('kick', { viewers: 900 }, {}, 2),
      platformView('twitch', { viewers: 300, title: 'عنوان مختلف', category: 'Just Chatting' }, {}, 1),
      platformView('tiktok', { viewers: null, category: null, title: null }, {}, 3),
    ]);
    const msg = buildLiveMessage(view, { now: T0 });
    const embed = msg.embeds[0]!;

    // Primary platform = first (most viewers): its color, URL and title lead the message.
    expect(embed.color).toBe(PLATFORM_COLORS.kick);
    expect(embed.url).toBe('https://kick.com/abufahad');
    const fields = fieldsOf(msg);
    expect(fields.map((f) => f.name)).toEqual(['💚 Kick', '💜 Twitch', '🎵 TikTok', '👥 المجموع', '⏱️ بدأ']);
    expect(fields[1]!.value).toContain('📝 عنوان مختلف');
    expect(fields[1]!.value).toContain('🎮 Just Chatting');
    expect(fields[2]!.value).toContain('🔴 مباشر الحين');
    expect(fields[3]!.value).toBe('1,200 مشاهد');

    expect(buttonsOf(msg).map((b) => b.label)).toEqual(['شاهد على Kick', 'شاهد على Twitch', 'شاهد على TikTok']);
  });

  it('shows the channel name only when it differs from the streamer name', () => {
    const same = buildLiveMessage(liveView([platformView('twitch', {}, { displayName: 'أبو فهد' })]));
    expect(fieldsOf(same)[0]!.value).not.toContain('[');
    const different = buildLiveMessage(liveView([platformView('twitch', {}, { displayName: 'AbuFahad_TV' })]));
    expect(fieldsOf(different)[0]!.value).toContain('[AbuFahad\\_TV](https://www.twitch.tv/abufahad)');
  });

  it('labels buttons with the channel when a streamer is live on two channels of one platform', () => {
    const view = liveView([
      platformView('twitch', {}, { displayName: 'Main', url: 'https://www.twitch.tv/main' }, 1),
      platformView('twitch', { url: 'https://www.twitch.tv/alt' }, { displayName: 'Alt', url: 'https://www.twitch.tv/alt' }, 2),
    ]);
    view.platforms[0]!.snapshot.url = 'https://www.twitch.tv/main';
    expect(buttonsOf(buildLiveMessage(view)).map((b) => b.label)).toEqual(['شاهد على Twitch (Main)', 'شاهد على Twitch (Alt)']);
  });

  it('escapes untrusted titles and never lets them mass-mention', () => {
    const view = liveView([platformView('twitch', { title: '**hacked** [click](https://evil.example) @everyone', category: '_cat_' })]);
    const embed = buildLiveMessage(view).embeds[0]!;
    expect(embed.description).toBe('**\\*\\*hacked\\*\\* \\[click\\](https://evil.example) @\u200beveryone**\n🎮 \\_cat\\_');
  });

  it('drops invalid URLs instead of letting Discord reject the message', () => {
    const view = liveView([platformView('twitch', { thumbnailUrl: 'javascript:alert(1)', categoryImageUrl: null, url: 'not a url' }, { url: 'also bad', avatarUrl: null })]);
    const msg = buildLiveMessage(view);
    const embed = msg.embeds[0]!;
    expect(embed.image).toBeUndefined();
    expect(embed.url).toBeUndefined();
    expect(embed.thumbnail).toBeUndefined();
    expect(msg.components).toEqual([]);
  });

  it('falls back to the channel page when the live URL is invalid', () => {
    const msg = buildLiveMessage(liveView([platformView('kick', { url: 'kick://broken' })]));
    expect(buttonsOf(msg)[0]!.url).toBe('https://kick.com/abufahad');
    expect(msg.embeds[0]!.url).toBe('https://kick.com/abufahad');
  });

  it('uses the template color, then the streamer color, then the platform color', () => {
    const base = [platformView('youtube')];
    expect(buildLiveMessage(liveView(base)).embeds[0]!.color).toBe(PLATFORM_COLORS.youtube);
    expect(buildLiveMessage(liveView(base, { streamer: streamer({ color: 0x00ff00 }) })).embeds[0]!.color).toBe(0x00ff00);
    const templated = liveView(base, { streamer: streamer({ color: 0x00ff00 }), settings: settings({ templates: { live: { color: 0x0000ff } } }) });
    expect(buildLiveMessage(templated).embeds[0]!.color).toBe(0x0000ff);
  });

  it('applies saved templates and a preview override', () => {
    const view = liveView([platformView('twitch', { viewers: 50 })], {
      settings: settings({ templates: { live: { title: '{name} على {platforms}', description: '{viewers} مشاهد', footer: '', content: 'تعالوا {url}' } } }),
    });
    const msg = buildLiveMessage(view);
    expect(msg.embeds[0]!.title).toBe('أبو فهد على Twitch');
    expect(msg.embeds[0]!.description).toBe('50 مشاهد');
    expect(msg.embeds[0]!.footer).toBeUndefined();
    expect(msg.content).toBe('تعالوا https://www.twitch.tv/abufahad');
    expect(buildLiveMessage(view, { template: { title: 'معاينة' } }).embeds[0]!.title).toBe('معاينة');
  });

  it('uses custom platform emojis in fields and buttons when available', () => {
    const emojis = resolvePlatformEmojis([{ id: '123456789012345678', name: 'twitch' }]);
    const msg = buildLiveMessage(liveView([platformView('twitch')]), { emojis });
    expect(fieldsOf(msg)[0]!.name).toBe('<:twitch:123456789012345678> Twitch');
    expect(buttonsOf(msg)[0]!.emoji).toEqual({ id: '123456789012345678', name: 'twitch' });
  });

  it('falls back to the channel avatar for the author icon', () => {
    const embed = buildLiveMessage(liveView([platformView('kick')])).embeds[0]!;
    expect(embed.author?.icon_url).toBe('https://img.example.com/kick-avatar.png');
  });

  it('survives a session with no live platforms', () => {
    const msg = buildLiveMessage(liveView([]));
    expect(msg.embeds[0]!.title).toBe('🔴 أبو فهد يبث الحين!');
    expect(msg.components).toEqual([]);
  });
});

describe('buildSummaryMessage', () => {
  it('renders duration, viewers, games, platforms and VOD buttons', () => {
    const msg = buildSummaryMessage(summaryView(), { now: T0 });
    const embed = msg.embeds[0]!;
    expect(embed.title).toBe('⚫ انتهى بث أبو فهد');
    expect(embed.description).toBe('**رانكد فالورانت**');
    expect(embed.color).toBe(ENDED_COLOR);
    expect(embed.image?.url).toBe('https://img.example.com/last.jpg');
    expect(embed.timestamp).toBe(new Date(T0).toISOString());

    const fields = Object.fromEntries(fieldsOf(msg).map((f) => [f.name, f.value]));
    expect(fields['⏱️ المدة']).toBe('2س 15د');
    expect(fields['📈 أعلى مشاهدين']).toBe('1,580');
    expect(fields['📊 متوسط المشاهدين']).toBe('1,120');
    expect(fields['🎮 الألعاب']).toBe('• Valorant — 1س 50د\n• Just Chatting — 25د');
    // Two Twitch segments (reconnect) collapse into one channel line with the best peak.
    expect(fields['📡 المنصات']).toBe('💜 Twitch: [AbuFahad](https://www.twitch.tv/abufahad) — أعلى 1,300\n💚 Kick: [abufahad](https://kick.com/abufahad) — أعلى 300');
    expect(fields['🕒 الوقت']).toMatch(/^من <t:\d+:f> إلى <t:\d+:t>$/);

    expect(buttonsOf(msg).map((b) => [b.label, b.url])).toEqual([
      ['الإعادة على Twitch', 'https://www.twitch.tv/videos/123'],
      ['إعادات Kick', 'https://kick.com/abufahad/videos'],
      ['قناة Twitch', 'https://www.twitch.tv/abufahad'],
      ['قناة Kick', 'https://kick.com/abufahad'],
    ]);
  });

  it("links Kick's videos page while a Kick recording is not known yet (never instead of a real VOD)", () => {
    const base = summaryView();
    const kickOnly = base.segments.filter((seg) => seg.platform === 'kick');
    const labels = (view: typeof base) => buttonsOf(buildSummaryMessage(view)).map((b) => [b.label, b.url]);

    expect(labels({ ...base, segments: kickOnly })).toEqual([
      ['إعادات Kick', 'https://kick.com/abufahad/videos'],
      ['قناة Kick', 'https://kick.com/abufahad'],
    ]);
    const withVod = kickOnly.map((seg) => ({ ...seg, vodUrl: 'https://kick.com/abufahad/videos/abc-123' }));
    expect(labels({ ...base, segments: withVod })).toEqual([
      ['الإعادة على Kick', 'https://kick.com/abufahad/videos/abc-123'],
      ['قناة Kick', 'https://kick.com/abufahad'],
    ]);
    // Falls back to the handle when the channel URL is not a kick.com page.
    expect(kickVideosUrl({ url: 'not a url', handle: 'abu_fahad' })).toBe('https://kick.com/abu_fahad/videos');
    expect(kickVideosUrl({ url: '', handle: 'bad handle!' })).toBeNull();
    // The minimal "ended" card stays minimal.
    expect(buttonsOf(buildEndedMessage({ ...base, segments: kickOnly })).map((b) => b.label)).toEqual(['قناة Kick']);
  });

  it('handles missing stats gracefully', () => {
    const msg = buildSummaryMessage(summaryView({ peakViewers: 0, avgViewers: null, categories: [], titles: [], imageUrl: null, durationSec: 30 }));
    const fields = Object.fromEntries(fieldsOf(msg).map((f) => [f.name, f.value]));
    expect(fields['📈 أعلى مشاهدين']).toBe('—');
    expect(fields['📊 متوسط المشاهدين']).toBe('—');
    expect(fields['⏱️ المدة']).toBe('أقل من دقيقة');
    expect(fields['🎮 الألعاب']).toBeUndefined();
    expect(msg.embeds[0]!.description).toBeUndefined();
    expect(msg.embeds[0]!.image).toBeUndefined();
  });

  it('lists at most 8 games and summarizes the rest', () => {
    const categories = Array.from({ length: 11 }, (_, i) => ({ name: `Game ${i}`, imageUrl: null, firstSeenAt: '', seconds: 600 }));
    const value = fieldsOf(buildSummaryMessage(summaryView({ categories }))).find((f) => f.name === '🎮 الألعاب')!.value;
    expect(value.split('\n')).toHaveLength(9);
    expect(value.endsWith('و 3 غيرها')).toBe(true);
  });

  it('renders a minimal ended card when summaries are disabled', () => {
    const msg = buildEndedMessage(summaryView());
    expect(msg.embeds[0]!.title).toBe('⚫ انتهى البث');
    expect(msg.embeds[0]!.description).toBe('⏱️ المدة: 2س 15د');
    expect(msg.embeds[0]!.fields).toBeUndefined();
    expect(msg.content).toBe('');
    expect(buttonsOf(msg).map((b) => b.label)).toEqual(['قناة Twitch', 'قناة Kick']);
  });
});

describe('buildContentMessage', () => {
  it('renders a new video notification', () => {
    const msg = buildContentMessage(contentView());
    const embed = msg.embeds[0]!;
    expect(embed.title).toBe('أقوى لقطات الأسبوع');
    expect(embed.url).toBe('https://www.youtube.com/watch?v=vid1');
    expect(embed.description).toBe('🎬 **أبو فهد** نزّل فيديو جديد على YouTube!');
    expect(embed.author).toEqual({ name: 'Abu Fahad', icon_url: 'https://img.example.com/yt.png', url: 'https://www.youtube.com/@abufahad' });
    expect(embed.color).toBe(PLATFORM_COLORS.youtube);
    expect(embed.image?.url).toBe('https://i.ytimg.com/vi/vid1/hqdefault.jpg');
    expect(embed.footer?.text).toBe('YouTube • فيديو');
    expect(fieldsOf(msg).map((f) => [f.name, f.value])).toEqual([
      ['⏱️ المدة', '12:34'],
      ['👁️ المشاهدات', '12,500'],
      ['📅 نُشر', `<t:${Math.floor((T0 - 5 * 60_000) / 1000)}:R>`],
    ]);
    expect(buttonsOf(msg).map((b) => [b.label, b.emoji?.name])).toEqual([
      ['شاهد', '▶️'],
      ['القناة', '📺'],
    ]);
  });

  it('uses the content kind label and works with stored items lacking stats', () => {
    const view = contentView(
      { channel: { id: 21, platform: 'twitch', displayName: 'AbuFahad', handle: 'abufahad', url: 'https://www.twitch.tv/abufahad', avatarUrl: null } },
      { kind: 'clip', platform: 'twitch', url: 'https://clips.twitch.tv/x' },
    );
    delete (view.item as { durationSec?: unknown }).durationSec;
    delete (view.item as { viewCount?: unknown }).viewCount;
    const msg = buildContentMessage(view);
    expect(msg.embeds[0]!.description).toBe('🎬 **أبو فهد** نزّل كليب جديد على Twitch!');
    expect(fieldsOf(msg).map((f) => f.name)).toEqual(['📅 نُشر']);
    expect(msg.embeds[0]!.color).toBe(PLATFORM_COLORS.twitch);
  });
});

describe('linkButtonRows', () => {
  it('dedupes by URL, skips invalid URLs and chunks 5 per row (max 25)', () => {
    const specs = Array.from({ length: 30 }, (_, i) => ({ label: `زر ${i}`, url: `https://example.com/${i % 28}` }));
    specs.push({ label: 'bad', url: 'nope' });
    const rows = linkButtonRows(specs);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.components.length === 5)).toBe(true);
    expect(new Set(rows.flatMap((r) => r.components.map((b) => b.url))).size).toBe(25);
  });

  it('truncates long labels to 80 characters', () => {
    const [row] = linkButtonRows([{ label: 'ا'.repeat(200), url: 'https://example.com' }]);
    expect(row!.components[0]!.label!.length).toBe(80);
  });

  it('makes 3 rows for 12 accounts', () => {
    const rows = linkButtonRows(Array.from({ length: 12 }, (_, i) => ({ label: `${i}`, url: `https://example.com/${i}` })));
    expect(rows.map((r) => r.components.length)).toEqual([5, 5, 2]);
  });
});

describe('fitEmbed', () => {
  it('keeps the total under 6000 characters by trimming the description then fields', () => {
    const fields = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}`, value: 'x'.repeat(1000) }));
    const embed = fitEmbed({ title: 't', description: 'd'.repeat(4000), fields });
    const total = (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
    expect(embed.description).toBeUndefined();
    expect(embed.fields!.length).toBeLessThan(10);
  });

  it('leaves small embeds untouched', () => {
    const embed = { title: 'a', description: 'b', fields: [{ name: 'c', value: 'd' }] };
    expect(fitEmbed(embed)).toEqual(embed);
  });
});

describe('toPreview', () => {
  it('converts a payload into the dashboard preview shape', () => {
    const emojis = resolvePlatformEmojis([{ id: '123456789012345678', name: 'kick' }]);
    const preview = toPreview(buildLiveMessage(liveView([platformView('kick'), platformView('twitch', { viewers: 10 }, {}, 2)], { session: session() }), { emojis, now: T0 }));
    expect(preview.content).toBeNull();
    expect(preview.embeds).toHaveLength(1);
    expect(preview.embeds[0]!.title).toBe('🔴 أبو فهد يبث الحين!');
    expect(preview.embeds[0]!.fields?.[0]).toEqual({ name: '<:kick:123456789012345678> Kick', value: expect.any(String), inline: true });
    expect(preview.buttons).toEqual([
      { label: 'شاهد على Kick', url: 'https://kick.com/abufahad', emoji: '<:kick:123456789012345678>' },
      { label: 'شاهد على Twitch', url: 'https://www.twitch.tv/abufahad', emoji: '💜' },
    ]);
  });

  it('keeps content text when present', () => {
    expect(toPreview({ content: '@here', embeds: [], components: [] }).content).toBe('@here');
  });
});
