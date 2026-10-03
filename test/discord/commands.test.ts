import { ApplicationCommandOptionType, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import type { Channel, StreamerWithAccounts } from '../../src/db/models.js';
import { buildStatusEmbed, platformHealth } from '../../src/discord/commands/bot.js';
import { commandDefinitions } from '../../src/discord/commands/index.js';
import { buildLiveNowMessage } from '../../src/discord/commands/live.js';
import { friendlyError } from '../../src/discord/commands/replies.js';
import { buildStreamerCard, buildStreamerList } from '../../src/discord/commands/streamer.js';
import { GUILD, liveView, platformView, session, streamer, T0 } from './helpers.js';

interface Option {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  options?: Option[];
  choices?: Array<{ name: string; value: string }>;
}

const NAME_RE = /^[-_\p{Ll}\p{N}]{1,32}$/u;

function checkOptions(options: Option[] | undefined, path: string): void {
  if (!options) return;
  expect(options.length, path).toBeLessThanOrEqual(25);
  let seenOptional = false;
  for (const option of options) {
    expect(option.name, path).toMatch(NAME_RE);
    expect(option.description.length, `${path}.${option.name}`).toBeGreaterThan(0);
    expect(option.description.length, `${path}.${option.name}`).toBeLessThanOrEqual(100);
    if (option.type !== ApplicationCommandOptionType.Subcommand && option.type !== ApplicationCommandOptionType.SubcommandGroup) {
      // Discord rejects required options after optional ones.
      if (option.required) expect(seenOptional, `${path}.${option.name} required after optional`).toBe(false);
      else seenOptional = true;
    }
    for (const choice of option.choices ?? []) expect(choice.name.length).toBeLessThanOrEqual(100);
    checkOptions(option.options, `${path}.${option.name}`);
  }
}

describe('slash command definitions', () => {
  const defs = commandDefinitions();

  it('defines /live, /streamer and /bot with valid names and descriptions', () => {
    expect(defs.map((d) => d.name)).toEqual(['live', 'streamer', 'bot']);
    for (const def of defs) {
      expect(def.name).toMatch(NAME_RE);
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.description.length).toBeLessThanOrEqual(100);
      checkOptions(def.options as Option[] | undefined, def.name);
      expect(JSON.stringify(def).length).toBeLessThan(8000);
    }
  });

  it('restricts management commands to Manage Server by default and keeps /live public', () => {
    const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
    const manageGuild = PermissionFlagsBits.ManageGuild.toString();
    expect(byName.streamer!.default_member_permissions).toBe(manageGuild);
    expect(byName.bot!.default_member_permissions).toBe(manageGuild);
    expect(byName.live!.default_member_permissions ?? null).toBeNull();
    for (const def of defs) expect(def.contexts).toEqual([0]);
  });

  it('offers the expected subcommands and platform options', () => {
    const streamerDef = defs.find((d) => d.name === 'streamer')!;
    const subs = (streamerDef.options as Option[]).map((o) => o.name);
    expect(subs).toEqual(['add', 'remove', 'list', 'info']);
    const add = (streamerDef.options as Option[])[0]!;
    expect(add.options!.map((o) => o.name)).toEqual(['user', 'twitch', 'kick', 'youtube', 'tiktok', 'name']);
    const botDef = defs.find((d) => d.name === 'bot')!;
    const test = (botDef.options as Option[]).find((o) => o.name === 'test')!;
    expect(test.options![0]!.choices!.map((c) => c.value)).toEqual(['live', 'summary', 'content']);
  });
});

describe('/live builder', () => {
  it('says nobody is live', () => {
    const reply = buildLiveNowMessage([]);
    expect(reply.embeds![0]!.title).toBe('😴 ما فيه أحد يبث الحين');
  });

  it('lists live streamers sorted by viewers with links', () => {
    const a = liveView([platformView('twitch', { viewers: 50 })], { streamer: streamer({ id: 1, displayName: 'فهد' }) });
    const b = liveView([platformView('kick', { viewers: 500 }), platformView('tiktok', { viewers: 20 }, {}, 2)], {
      streamer: streamer({ id: 2, displayName: 'نورة' }),
      session: session({ id: 8 }),
    });
    const reply = buildLiveNowMessage([a, b]);
    const embed = reply.embeds![0]!;
    expect(embed.title).toBe('🔴 يبثون الحين (2)');
    expect(embed.description!.indexOf('نورة')).toBeLessThan(embed.description!.indexOf('فهد'));
    expect(embed.description).toContain('💚 [Kick](https://kick.com/abufahad) 👀 500');
    expect(embed.footer?.text).toBe('👥 مجموع المشاهدين: 570');
    expect(reply.components).toEqual([]);
  });

  it('adds watch buttons when exactly one streamer is live', () => {
    const reply = buildLiveNowMessage([liveView([platformView('twitch'), platformView('youtube', {}, {}, 2)])]);
    expect(reply.components![0]!.components.map((b) => b.label)).toEqual(['شاهد على Twitch', 'شاهد على YouTube']);
  });

  it('summarizes overflow instead of exceeding the description limit', () => {
    const views = Array.from({ length: 60 }, (_, i) =>
      liveView([platformView('twitch', { title: 'x'.repeat(200) })], { streamer: streamer({ id: i + 1, displayName: `ستريمر ${i}` }) }),
    );
    const embed = buildLiveNowMessage(views).embeds![0]!;
    expect(embed.description!.length).toBeLessThanOrEqual(4096);
    expect(embed.description).toMatch(/و \d+ غيرهم يبثون الحين$/);
  });
});

function channel(id: number, patch: Partial<Channel> = {}): Channel {
  return {
    id,
    platform: 'twitch',
    platformId: `p${id}`,
    handle: `handle${id}`,
    displayName: `Name${id}`,
    avatarUrl: null,
    url: `https://www.twitch.tv/handle${id}`,
    meta: {},
    isLive: false,
    liveSnapshot: null,
    liveSince: null,
    offlineSince: null,
    missCount: 0,
    lastLiveCheckAt: new Date(T0).toISOString(),
    contentSeeded: true,
    lastContentCheckAt: null,
    lastError: null,
    errorCount: 0,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...patch,
  };
}

function withAccounts(id: number, channels: Channel[], patch: Partial<StreamerWithAccounts> = {}): StreamerWithAccounts {
  return {
    ...streamer({ id, discordUserId: `22222222222222222${id}`, displayName: `ستريمر ${id}` }),
    accounts: channels.map((c, i) => ({ id: id * 10 + i, streamerId: id, channelId: c.id, notifyLive: true, notifyContent: i === 0, contentKinds: null, createdAt: '', channel: c })),
    ...patch,
  };
}

describe('/streamer builders', () => {
  it('renders a streamer card with account status', () => {
    const card = buildStreamerCard(
      withAccounts(1, [channel(1, { isLive: true, liveSnapshot: { viewers: 42 } as Channel['liveSnapshot'] }), channel(2, { platform: 'kick', lastError: 'boom', errorCount: 3 })]),
      { live: true, stats: { sessions: 4, seconds: 3600 * 5, peakViewers: 900 } },
    );
    expect(card.description).toContain('🔴 يبث الحين');
    expect(card.fields![0]!.value).toContain('🔴 مباشر الحين — 👀 42');
    expect(card.fields![1]!.name).toBe('💚 Kick');
    expect(card.fields![1]!.value).toContain('⚠️ boom');
    expect(card.fields![1]!.value).toContain('🔔 البث ✅ • المقاطع ❌');
    expect(card.fields!.at(-1)).toEqual({ name: '📊 آخر 30 يوم', value: '4 بث • 5س • أعلى 900 مشاهد', inline: false });
  });

  it('lists streamers with live ones first', () => {
    const list = buildStreamerList([withAccounts(1, [channel(1)]), withAccounts(2, [channel(2)]), withAccounts(3, [], { enabled: false })], new Set([2]));
    const lines = list.description!.split('\n');
    expect(lines[0]).toContain('🔴 **ستريمر 2**');
    expect(lines[2]).toContain('⏸️');
    expect(lines[2]).toContain('بدون حسابات');
    expect(list.title).toBe('👥 الستريمرز (3)');
    expect(list.footer?.text).toBe('🔴 يبث الحين: 1');
  });

  it('explains how to add the first streamer', () => {
    expect(buildStreamerList([], new Set()).description).toContain('/streamer add');
  });
});

describe('/bot builders', () => {
  it('computes per-platform health from enabled streamers only (deduplicated)', () => {
    const shared = channel(1, { isLive: true });
    const health = platformHealth(
      [withAccounts(1, [shared, channel(2, { platform: 'kick', errorCount: 2 })]), withAccounts(2, [shared]), withAccounts(3, [channel(3)], { enabled: false })],
      { platformsEnabled: ['twitch', 'kick', 'youtube'] },
    );
    const twitch = health.find((h) => h.platform === 'twitch')!;
    expect(twitch).toMatchObject({ tracked: 1, live: 1, failing: 0, enabled: true });
    expect(health.find((h) => h.platform === 'kick')).toMatchObject({ tracked: 1, failing: 1 });
    expect(health.find((h) => h.platform === 'tiktok')).toMatchObject({ tracked: 0, enabled: false });
  });

  it('colors the status by the worst problem and lists problems', () => {
    const base = { health: [], streamers: 2, accounts: 3, liveNow: 1, wsPing: 42, startedAt: T0 };
    const ok = buildStatusEmbed({ ...base, diagnostics: { guildId: GUILD, botInGuild: true, botHasManageRoles: true, problems: [] } });
    expect(ok.color).toBe(0x57f287);
    expect(ok.description).toContain('✅ كل شي مضبوط');
    const bad = buildStatusEmbed({
      ...base,
      diagnostics: {
        guildId: GUILD,
        botInGuild: true,
        botHasManageRoles: false,
        problems: [
          { code: 'a', level: 'warn', message: 'تحذير' },
          { code: 'b', level: 'error', message: 'خطأ' },
        ],
      },
    });
    expect(bad.color).toBe(0xed4245);
    expect(bad.description).toContain('⚠️ تحذير');
    expect(bad.description).toContain('⛔ خطأ');
    expect(bad.fields![0]!.value).toContain('42ms');
  });
});

describe('friendlyError', () => {
  it('shows validation and Arabic errors, hides internal ones', () => {
    expect(friendlyError(new ValidationError('الستريمر غير موجود'))).toBe('الستريمر غير موجود');
    expect(friendlyError(new Error('البوت غير متصل'))).toBe('البوت غير متصل');
    expect(friendlyError(new Error('SQLITE_BUSY'))).toContain('صار خطأ غير متوقع');
    expect(friendlyError('weird')).toContain('صار خطأ غير متوقع');
  });
});
