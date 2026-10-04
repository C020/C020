import { beforeEach, describe, expect, it } from 'vitest';
import type { ResolvedChannel } from '../../src/core/types.js';
import { offlineSnapshot } from '../../src/core/types.js';
import { openDatabase } from '../../src/db/database.js';
import { DEFAULT_GUILD_OPTIONS } from '../../src/db/models.js';
import { Repositories } from '../../src/db/repositories.js';

const resolved = (platform: ResolvedChannel['platform'], id: string, handle = id): ResolvedChannel => ({
  platform,
  platformId: id,
  handle,
  displayName: handle.toUpperCase(),
  avatarUrl: null,
  url: `https://example.com/${handle}`,
  meta: { a: 1 },
});

describe('Repositories', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = new Repositories(openDatabase(':memory:'));
  });

  it('creates default guild settings and merges updates', () => {
    const s = repos.settings.get('g1');
    expect(s.pingMode).toBe('none');
    expect(s.platformsEnabled).toEqual(['twitch', 'kick', 'youtube', 'tiktok']);
    expect(s.options).toEqual(DEFAULT_GUILD_OPTIONS);

    const next = repos.settings.update('g1', { liveRoleId: '123', options: { liveUpdateMinutes: 2 } });
    expect(next.liveRoleId).toBe('123');
    expect(next.options.liveUpdateMinutes).toBe(2);
    expect(next.options.reconnectMergeMinutes).toBe(DEFAULT_GUILD_OPTIONS.reconnectMergeMinutes);
    expect(repos.settings.get('g1').liveRoleId).toBe('123');
    expect(repos.settings.listGuildIds()).toEqual(['g1']);
  });

  it('allows clearing nullable settings with null', () => {
    repos.settings.update('g1', { liveRoleId: '123' });
    expect(repos.settings.update('g1', { liveRoleId: null }).liveRoleId).toBeNull();
  });

  it('dedupes channels across streamers and lists subscribers', () => {
    const a = repos.streamers.create({ guildId: 'g1', discordUserId: '1', displayName: 'A' });
    const b = repos.streamers.create({ guildId: 'g2', discordUserId: '1', displayName: 'A2' });
    const ch1 = repos.channels.upsertResolved(resolved('twitch', '42', 'foo'));
    const ch2 = repos.channels.upsertResolved({ ...resolved('twitch', '42', 'foo_renamed') });
    expect(ch2.id).toBe(ch1.id);
    expect(ch2.handle).toBe('foo_renamed');

    repos.accounts.create({ streamerId: a.id, channelId: ch1.id });
    repos.accounts.create({ streamerId: b.id, channelId: ch1.id, notifyContent: false, contentKinds: ['clip'] });
    const subs = repos.accounts.subscribersOf(ch1.id);
    expect(subs.map((s) => s.guildId).sort()).toEqual(['g1', 'g2']);
    const g2 = subs.find((s) => s.guildId === 'g2')!;
    expect(g2.account.notifyContent).toBe(false);
    expect(g2.account.contentKinds).toEqual(['clip']);

    expect(repos.channels.listTracked('twitch')).toHaveLength(1);
    repos.streamers.update(a.id, { enabled: false });
    repos.streamers.update(b.id, { enabled: false });
    expect(repos.channels.listTracked()).toHaveLength(0);
    expect(repos.accounts.subscribersOf(ch1.id)).toHaveLength(0);
  });

  it('upserting an existing account updates flags instead of failing', () => {
    const st = repos.streamers.create({ guildId: 'g1', discordUserId: '1', displayName: 'A' });
    const ch = repos.channels.upsertResolved(resolved('kick', '7'));
    const first = repos.accounts.create({ streamerId: st.id, channelId: ch.id });
    const again = repos.accounts.create({ streamerId: st.id, channelId: ch.id, notifyLive: false });
    expect(again.id).toBe(first.id);
    expect(again.notifyLive).toBe(false);
  });

  it('cascades deletes and removes orphan channels', () => {
    const st = repos.streamers.create({ guildId: 'g1', discordUserId: '1', displayName: 'A' });
    const ch = repos.channels.upsertResolved(resolved('youtube', 'UC1'));
    repos.accounts.create({ streamerId: st.id, channelId: ch.id });
    const session = repos.sessions.create({ guildId: 'g1', streamerId: st.id, startedAt: new Date().toISOString() });
    repos.sessions.addSegment({ sessionId: session.id, channelId: ch.id, platform: 'youtube', streamId: 'v1', startedAt: session.startedAt, viewers: 5 });
    repos.streamers.delete(st.id);
    expect(repos.accounts.listForStreamer(st.id)).toHaveLength(0);
    expect(repos.sessions.get(session.id)).toBeNull();
    expect(repos.channels.deleteOrphans()).toEqual([ch.id]);
    expect(repos.channels.get(ch.id)).toBeNull();
  });

  it('keeps orphan channels that are part of session history', () => {
    const st = repos.streamers.create({ guildId: 'g1', discordUserId: '1', displayName: 'A' });
    const ch = repos.channels.upsertResolved(resolved('kick', '9'));
    const account = repos.accounts.create({ streamerId: st.id, channelId: ch.id });
    const session = repos.sessions.create({ guildId: 'g1', streamerId: st.id, startedAt: new Date().toISOString() });
    repos.sessions.addSegment({ sessionId: session.id, channelId: ch.id, platform: 'kick', streamId: 's', startedAt: session.startedAt, viewers: 1 });
    repos.accounts.delete(account.id);
    expect(repos.channels.deleteOrphans()).toEqual([]);
    expect(repos.sessions.segments(session.id)).toHaveLength(1);
    expect(repos.channels.listTracked()).toHaveLength(0);
  });

  it('persists live state and errors on channels', () => {
    const ch = repos.channels.upsertResolved(resolved('twitch', '1'));
    const snap = { ...offlineSnapshot(ch, ch.url), isLive: true, streamId: 's1', viewers: 10 };
    repos.channels.saveLiveState(ch.id, { isLive: true, snapshot: snap, liveSince: '2026-01-01T00:00:00.000Z', offlineSince: null, missCount: 0 });
    repos.channels.recordError(ch.id, 'boom');
    const got = repos.channels.get(ch.id)!;
    expect(got.isLive).toBe(true);
    expect(got.liveSnapshot?.streamId).toBe('s1');
    expect(got.lastError).toBe('boom');
    expect(got.errorCount).toBe(1);
    repos.channels.saveLiveState(ch.id, { isLive: false, snapshot: null, liveSince: null, offlineSince: null, missCount: 0 });
    expect(repos.channels.get(ch.id)!.errorCount).toBe(0);
  });

  it('tracks sessions, segments, recently ended lookup and totals', () => {
    const st = repos.streamers.create({ guildId: 'g1', discordUserId: '1', displayName: 'A' });
    const ch = repos.channels.upsertResolved(resolved('twitch', '1'));
    const started = new Date(Date.now() - 3600_000).toISOString();
    const s = repos.sessions.create({ guildId: 'g1', streamerId: st.id, startedAt: started });
    expect(repos.sessions.getActive(st.id)?.id).toBe(s.id);
    const seg = repos.sessions.addSegment({ sessionId: s.id, channelId: ch.id, platform: 'twitch', streamId: 'x', startedAt: started, viewers: 3 });
    expect(repos.sessions.openSegment(s.id, ch.id)?.id).toBe(seg.id);
    repos.sessions.saveSegment({ ...seg, endedAt: new Date().toISOString(), peakViewers: 50 });
    expect(repos.sessions.openSegment(s.id, ch.id)).toBeNull();

    const ended = new Date().toISOString();
    repos.sessions.save({ ...s, status: 'ended', endedAt: ended, peakViewers: 50, categories: [{ name: 'Valorant', imageUrl: null, firstSeenAt: started, seconds: 3600 }] });
    expect(repos.sessions.getActive(st.id)).toBeNull();
    expect(repos.sessions.getRecentlyEnded(st.id, new Date(Date.now() - 60_000).toISOString())?.id).toBe(s.id);
    expect(repos.sessions.getRecentlyEnded(st.id, new Date(Date.now() + 60_000).toISOString())).toBeNull();
    expect(repos.sessions.get(s.id)!.categories[0]!.name).toBe('Valorant');

    const totals = repos.sessions.totals('g1', new Date(Date.now() - 86_400_000).toISOString());
    expect(totals).toHaveLength(1);
    expect(totals[0]!.seconds).toBeGreaterThan(3500);
    expect(totals[0]!.peakViewers).toBe(50);
  });

  it('dedupes content and notifications per guild', () => {
    const ch = repos.channels.upsertResolved(resolved('youtube', 'UC1'));
    const item = {
      platform: 'youtube' as const,
      platformId: 'UC1',
      contentId: 'vid1',
      kind: 'video' as const,
      title: 't',
      url: 'u',
      thumbnailUrl: null,
      publishedAt: new Date().toISOString(),
      durationSec: null,
      viewCount: null,
    };
    const first = repos.content.insert(ch.id, item, false);
    const second = repos.content.insert(ch.id, item, false);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(repos.content.recordNotification({ contentItemId: first.item.id, guildId: 'g1', streamerId: null, messageChannelId: 'c', messageId: 'm' })).toBe(true);
    expect(repos.content.recordNotification({ contentItemId: first.item.id, guildId: 'g1', streamerId: null, messageChannelId: 'c', messageId: 'm' })).toBe(false);
    expect(repos.content.wasNotified(first.item.id, 'g1')).toBe(true);
    expect(repos.content.wasNotified(first.item.id, 'g2')).toBe(false);
    expect(repos.content.recentForGuild('g1')).toHaveLength(1);
  });

  it('audit log filtering and kv store', () => {
    repos.audit.add({ guildId: 'g1', action: 'live.start', message: 'x' });
    repos.audit.add({ guildId: 'g2', action: 'live.start', message: 'y', level: 'warn' });
    repos.audit.add({ action: 'bot.start', message: 'z' });
    expect(repos.audit.list({ guildId: 'g1' }).map((e) => e.message)).toEqual(['z', 'x']);
    expect(repos.audit.list({ level: 'warn' })).toHaveLength(1);
    expect(repos.audit.list({ actionPrefix: 'bot.' })).toHaveLength(1);

    repos.kv.set('k', { a: [1, 2] });
    expect(repos.kv.get<{ a: number[] }>('k')).toEqual({ a: [1, 2] });
    repos.kv.delete('k');
    expect(repos.kv.get('k')).toBeUndefined();
  });

  it('nested transactions roll back inner savepoints only', () => {
    expect(() =>
      repos.tx(() => {
        repos.streamers.create({ guildId: 'g1', discordUserId: '1', displayName: 'A' });
        try {
          repos.tx(() => {
            repos.streamers.create({ guildId: 'g1', discordUserId: '2', displayName: 'B' });
            throw new Error('inner');
          });
        } catch {
          // swallow inner failure
        }
      }),
    ).not.toThrow();
    expect(repos.streamers.list('g1').map((s) => s.discordUserId)).toEqual(['1']);
  });

  it('recovers from a failed COMMIT: no stuck transaction and later transactions still work', () => {
    const db = repos.db;
    db.exec('CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (pid INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED);');
    // A deferred foreign key violation makes COMMIT itself fail (SQLite keeps the transaction open).
    expect(() => repos.tx(() => db.exec('INSERT INTO c VALUES (42)'))).toThrow(/FOREIGN KEY/);
    expect(db.isTransaction).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM c').get()).toEqual({ n: 0 });

    repos.tx(() => repos.streamers.create({ guildId: 'g1', discordUserId: '7', displayName: 'After' }));
    expect(repos.streamers.getByDiscordId('g1', '7')?.displayName).toBe('After');
    expect(db.isTransaction).toBe(false);
  });

  it('web sessions expire', () => {
    const now = Date.now();
    repos.webSessions.create({ id: 'a', userId: 'u', username: 'n', avatarUrl: null, guilds: [], guildsRefreshedAt: new Date(now).toISOString(), accessToken: null, expiresAt: new Date(now - 1000).toISOString() });
    expect(repos.webSessions.get('a')).toBeNull();
    repos.webSessions.create({ id: 'b', userId: 'u', username: 'n', avatarUrl: null, guilds: [{ id: 'g', name: 'G', icon: null, permissions: '8', owner: false }], guildsRefreshedAt: new Date(now).toISOString(), accessToken: 't', expiresAt: new Date(now + 60_000).toISOString() });
    expect(repos.webSessions.get('b')?.guilds[0]?.id).toBe('g');
  });
});
