/** #16 — bot message language: English defaults, labels, fields, buttons, kind names and durations. */
import { describe, expect, it } from 'vitest';
import { defineMessages } from '../../src/discord/i18n/index.js';
import { contentKindLabel, joinList, langOf, NOTIFICATION_MESSAGES, permissionNameEn, tm, viewersText } from '../../src/discord/i18n/messages.js';
import { buildContentMessage, buildEndedMessage, buildLiveMessage, buildSummaryMessage } from '../../src/discord/messages.js';
import { asTestMessage, buildLogMessages, failureMessage, failureMessageAr, permissionList } from '../../src/discord/notifier.js';
import { sampleIdentityFor, sampleLiveView, sampleContentView } from '../../src/discord/samples.js';
import { contentView, GUILD, liveView, makeNotifier, platformView, settings, summaryView, T0, withFeatures } from './helpers.js';

const en = (patch: Parameters<typeof settings>[0] = {}) => withFeatures({ language: 'en' }, patch);
const fieldsOf = (m: { embeds: Array<{ fields?: Array<{ name: string; value: string }> }> }) => m.embeds[0]?.fields ?? [];
const buttonLabels = (m: { components: Array<{ components: Array<{ label?: string }> }> }) => m.components.flatMap((r) => r.components.map((b) => b.label));

describe('dictionary', () => {
  it('has both languages for every key and identical placeholders', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, entry] of Object.entries(NOTIFICATION_MESSAGES)) {
      expect(entry.ar.trim(), key).not.toBe('');
      expect(entry.en.trim(), key).not.toBe('');
      expect(placeholders(entry.en), key).toEqual(placeholders(entry.ar));
    }
  });

  it('translates with Arabic as the fallback language', () => {
    expect(tm('en', 'live.now')).toBe('Live now');
    expect(tm('ar', 'live.now')).toBe('مباشر الحين');
    expect(tm(null, 'live.now')).toBe('مباشر الحين');
    expect(tm('en', 'live.watchOn', { platform: 'Kick' })).toBe('Watch on Kick');
    // Unknown keys never crash (typed away, but defensive at runtime).
    expect(defineMessages({})('en', 'missing' as never)).toBe('missing');
  });

  it('reads the language defensively from settings', () => {
    expect(langOf(en())).toBe('en');
    expect(langOf(settings())).toBe('ar');
    expect(langOf(null)).toBe('ar');
    expect(langOf({ features: undefined } as never)).toBe('ar');
    expect(langOf({ features: { language: 'fr' } } as never)).toBe('ar');
  });

  it('joins lists, pluralizes viewers and names content kinds per language', () => {
    expect(joinList(['Twitch', 'Kick', 'YouTube'], 'en')).toBe('Twitch, Kick and YouTube');
    expect(joinList(['Twitch', 'Kick', 'YouTube'], 'ar')).toBe('Twitch، Kick و YouTube');
    expect(joinList(['Twitch'], 'en')).toBe('Twitch');
    expect(joinList([], 'en')).toBe('');
    expect(viewersText('en', '1', 1)).toBe('1 viewer');
    expect(viewersText('en', '1,200', 1200)).toBe('1,200 viewers');
    expect(viewersText('ar', '1', 1)).toBe('1 مشاهد');
    expect(contentKindLabel('short', 'en')).toBe('Short');
    expect(contentKindLabel('vod', 'ar')).toBe('تسجيل بث');
    expect(contentKindLabel('unknown', 'en')).toBe('video');
    expect(contentKindLabel('unknown', 'ar')).toBe('مقطع');
  });
});

describe('English live notification', () => {
  it('uses English defaults, field names, buttons and viewer counts', () => {
    const view = liveView(
      [platformView('kick', { viewers: 900 }, {}, 2), platformView('twitch', { viewers: 1, title: 'Other title' }, {}, 1), platformView('tiktok', { viewers: null, category: null, title: null }, {}, 3)],
      { settings: en() },
    );
    const msg = buildLiveMessage(view, { now: T0 });
    const embed = msg.embeds[0]!;
    expect(embed.title).toBe('🔴 أبو فهد is live now!');
    expect(embed.footer?.text).toBe('Updates automatically');
    const fields = fieldsOf(msg);
    expect(fields.map((f) => f.name)).toEqual(['💚 Kick', '💜 Twitch', '🎵 TikTok', '👥 Total', '⏱️ Started']);
    expect(fields[0]!.value).toContain('👀 900 viewers • 🎮 Valorant');
    expect(fields[1]!.value).toContain('👀 1 viewer');
    expect(fields[2]!.value).toContain('🔴 Live now');
    expect(fields[3]!.value).toBe('901 viewers');
    expect(buttonLabels(msg)).toEqual(['Watch on Kick', 'Watch on Twitch', 'Watch on TikTok']);
  });

  it('joins {platforms} the English way and labels same-platform buttons with the channel', () => {
    const view = liveView(
      [
        platformView('twitch', { url: 'https://www.twitch.tv/main' }, { displayName: 'Main', url: 'https://www.twitch.tv/main' }, 1),
        platformView('twitch', { url: 'https://www.twitch.tv/alt' }, { displayName: 'Alt', url: 'https://www.twitch.tv/alt' }, 2),
        platformView('kick', {}, {}, 3),
      ],
      { settings: en({ templates: { live: { title: '{name} on {platforms}' } } }) },
    );
    const msg = buildLiveMessage(view);
    expect(msg.embeds[0]!.title).toBe('أبو فهد on Twitch and Kick');
    expect(buttonLabels(msg)).toEqual(['Watch on Twitch (Main)', 'Watch on Twitch (Alt)', 'Watch on Kick']);
  });

  it('keeps saved custom templates exactly as written', () => {
    const view = liveView([platformView('twitch')], { settings: en({ templates: { live: { title: 'بث {name}', footer: 'تذييل' } } }) });
    const embed = buildLiveMessage(view).embeds[0]!;
    expect(embed.title).toBe('بث أبو فهد');
    expect(embed.footer?.text).toBe('تذييل');
  });
});

describe('English summary, ended card and content', () => {
  it('localizes summary fields, durations, games overflow and buttons', () => {
    const categories = Array.from({ length: 10 }, (_, i) => ({ name: `Game ${i}`, imageUrl: null, firstSeenAt: '', seconds: 3600 + 600 }));
    const msg = buildSummaryMessage(summaryView({ settings: en(), categories }), { now: T0 });
    const embed = msg.embeds[0]!;
    expect(embed.title).toBe("⚫ أبو فهد's stream has ended");
    expect(embed.footer?.text).toBe('Stream summary');
    const fields = Object.fromEntries(fieldsOf(msg).map((f) => [f.name, f.value]));
    expect(fields['⏱️ Duration']).toBe('2h 15m');
    expect(fields['📈 Peak viewers']).toBe('1,580');
    expect(fields['📊 Average viewers']).toBe('1,120');
    expect(fields['🎮 Games']!.split('\n')[0]).toBe('• Game 0 — 1h 10m');
    expect(fields['🎮 Games']!.endsWith('and 2 more')).toBe(true);
    expect(fields['📡 Platforms']).toContain('— peak 1,300');
    expect(fields['🕒 Time']).toMatch(/^From <t:\d+:f> to <t:\d+:t>$/);
    expect(buttonLabels(msg)).toEqual(['Replay on Twitch', 'Kick replays', 'Twitch channel', 'Kick channel']);
  });

  it('localizes the {duration} and {games} summary variables', () => {
    const view = summaryView({ settings: en({ templates: { summary: { description: '{duration} • {games}' } } }) });
    expect(buildSummaryMessage(view).embeds[0]!.description).toBe('2h 15m • Valorant and Just Chatting');
  });

  it('localizes the minimal ended card', () => {
    const msg = buildEndedMessage(summaryView({ settings: en(), durationSec: 30 }));
    expect(msg.embeds[0]!.title).toBe('⚫ Stream ended');
    expect(msg.embeds[0]!.description).toBe('⏱️ Duration: under a minute');
    expect(buttonLabels(msg)).toEqual(['Twitch channel', 'Kick channel']);
  });

  it('localizes content defaults, kind names, fields and buttons', () => {
    const msg = buildContentMessage(contentView({ settings: en() }, { kind: 'short' }));
    const embed = msg.embeds[0]!;
    expect(embed.description).toBe('🎬 **أبو فهد** posted a new Short on YouTube!');
    expect(embed.footer?.text).toBe('YouTube • Short');
    expect(fieldsOf(msg).map((f) => f.name)).toEqual(['⏱️ Duration', '👁️ Views', '📅 Published']);
    expect(buttonLabels(msg)).toEqual(['Watch', 'Channel']);
  });

  it('keeps Arabic output unchanged for Arabic guilds', () => {
    const msg = buildContentMessage(contentView({}, { kind: 'vod' }));
    expect(msg.embeds[0]!.description).toBe('🎬 **أبو فهد** نزّل تسجيل بث جديد على YouTube!');
    expect(buttonLabels(msg)).toEqual(['شاهد', 'القناة']);
  });
});

describe('test marker, log channel and admin warnings', () => {
  it('marks English test messages in English', () => {
    expect(asTestMessage({ content: '', embeds: [], components: [] }, 'en').content).toBe('🧪 **Test message** — sample data so you can see how the notification looks');
    expect(asTestMessage({ content: '', embeds: [], components: [] }).content.startsWith('🧪 **رسالة تجريبية**')).toBe(true);
  });

  it('localizes the log channel footer', () => {
    const entries = [{ level: 'info' as const, message: 'hello', at: T0 }];
    expect(buildLogMessages(entries, 'en')[0]!.embeds[0]!.footer?.text).toBe('Bot log');
    expect(buildLogMessages(entries)[0]!.embeds[0]!.footer?.text).toBe('سجل البوت');
  });

  it('explains delivery failures in English, keeping the Arabic helper identical', () => {
    const missing = { ok: false as const, reason: 'forbidden' as const, detail: '', missing: ['SendMessages' as const, 'EmbedLinks' as const], channelName: 'live' };
    expect(failureMessage(missing, 'live', '1', 'en')).toBe("The bot can't post in the live notifications channel (#live) — missing permissions: Send Messages, Embed Links");
    expect(failureMessage({ ok: false, reason: 'channel_missing', detail: '' }, 'content', '42', 'en')).toContain('content notifications channel (42)');
    expect(failureMessage({ ok: false, reason: 'not_ready', detail: '' }, 'live', '1', 'en')).toBeNull();
    expect(failureMessageAr(missing, 'live', '1')).toBe(failureMessage(missing, 'live', '1', 'ar'));
    expect(failureMessageAr(missing, 'live', '1')).toContain('إرسال الرسائل (Send Messages)');
    expect(permissionList(['AttachFiles'], 'en')).toBe('Attach Files');
    expect(permissionNameEn('ManageChannels' as never)).toBe('Manage Channels');
  });

  it('records delivery warnings in the guild language', async () => {
    const { notifier, transport, warnings } = makeNotifier();
    transport.push({ ok: false, reason: 'forbidden', detail: 'x', missing: ['EmbedLinks'], channelName: 'live' });
    await notifier.postLive(liveView([platformView('twitch')], { settings: en({ liveChannelId: '333333333333333333' }) }));
    expect(warnings()[0]!.message).toBe("The bot can't post in the live notifications channel (#live) — missing permissions: Embed Links");
  });

  it('flushes the log channel with the guild language', async () => {
    const { notifier, transport, repos } = makeNotifier();
    repos.settings.update(GUILD, { logChannelId: '555555555555555555', features: { language: 'en' } });
    await notifier.log(GUILD, 'info', 'hello');
    await notifier.close();
    expect(transport.calls[0]!.message.embeds[0]!.footer?.text).toBe('Bot log');
  });
});

describe('samples follow the language', () => {
  it('uses English sample texts and identity for English guilds', () => {
    const view = sampleLiveView(en(), T0);
    expect(view.streamer.displayName).toBe('Sample streamer');
    expect(view.platforms[0]!.snapshot.title).toBe('Ranked Valorant 🔥 road to Radiant');
    expect(sampleContentView(en(), T0).item.title).toContain('Best plays of the week');
    expect(sampleLiveView(settings(), T0).streamer.displayName).toBe('ستريمر تجريبي');
    expect(sampleIdentityFor('en', '123').discordUserId).toBe('123');
    // An explicit identity always wins.
    expect(sampleLiveView(en(), T0, { displayName: 'X', discordUserId: '', avatarUrl: null }).streamer.displayName).toBe('X');
  });
});
