import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { DEFAULT_GUILD_FEATURES, mergeFeatures, normalizeFeatures } from '../../src/db/features.js';
import { Repositories } from '../../src/db/repositories.js';

describe('v2 repositories', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = new Repositories(openDatabase(':memory:'));
  });

  it('stores guild features with defaults and per-feature merging', () => {
    const s = repos.settings.get('g1');
    expect(s.features).toEqual(DEFAULT_GUILD_FEATURES);
    const next = repos.settings.update('g1', { features: { clips: { minViews: 25 }, language: 'en', routing: { contentByKind: { clip: '123' } } } });
    expect(next.features.clips).toEqual({ ...DEFAULT_GUILD_FEATURES.clips, minViews: 25 });
    expect(next.features.language).toBe('en');
    expect(repos.settings.get('g1').features.routing.contentByKind).toEqual({ clip: '123' });
    // unrelated patches keep features intact
    repos.settings.update('g1', { liveRoleId: '9' });
    expect(repos.settings.get('g1').features.clips.minViews).toBe(25);
  });

  it('normalizes stored feature JSON that predates newer fields', () => {
    const f = normalizeFeatures({ clips: { minViews: 5 }, unknown: 1 });
    expect(f.clips.mode).toBe('each');
    expect(f.clips.minViews).toBe(5);
    expect(f.presence).toEqual(DEFAULT_GUILD_FEATURES.presence);
    expect(mergeFeatures(f, undefined)).toBe(f);
  });

  it('persists per-streamer templates', () => {
    const st = repos.streamers.create({ guildId: 'g1', discordUserId: '1', displayName: 'A' });
    expect(st.templates).toEqual({});
    const upd = repos.streamers.update(st.id, { templates: { live: { title: 'X {name}' } }, color: 0xff00ff });
    expect(upd?.templates.live?.title).toBe('X {name}');
    expect(upd?.color).toBe(0xff00ff);
  });

  it('records viewer samples per session', () => {
    const st = repos.streamers.create({ guildId: 'g1', discordUserId: '1', displayName: 'A' });
    const session = repos.sessions.create({ guildId: 'g1', streamerId: st.id, startedAt: '2026-10-01T10:00:00.000Z' });
    repos.samples.add({ sessionId: session.id, at: '2026-10-01T10:01:00.000Z', totalViewers: 10, platforms: { twitch: 10 }, category: 'Valorant' });
    repos.samples.add({ sessionId: session.id, at: '2026-10-01T10:02:00.000Z', totalViewers: null, platforms: { kick: null }, category: null });
    expect(repos.samples.forSession(session.id).map((x) => x.totalViewers)).toEqual([10, null]);
    expect(repos.samples.last(session.id)?.platforms).toEqual({ kick: null });
  });

  it('allows one pending application per member and tracks decisions', () => {
    const app = repos.applications.create({ guildId: 'g1', userId: 'u1', username: 'n', accounts: [{ platform: 'kick', input: 'abc' }], note: null });
    expect(() => repos.applications.create({ guildId: 'g1', userId: 'u1', username: 'n', accounts: [], note: null })).toThrow();
    expect(repos.applications.pendingFor('g1', 'u1')?.id).toBe(app.id);
    expect(repos.applications.countPending('g1')).toBe(1);
    repos.applications.update(app.id, { status: 'rejected', reviewerId: 'r', reviewNote: 'لا', decidedAt: new Date().toISOString() });
    expect(repos.applications.pendingFor('g1', 'u1')).toBeNull();
    // a new application is allowed after a decision
    repos.applications.create({ guildId: 'g1', userId: 'u1', username: 'n', accounts: [], note: null });
    expect(repos.applications.list('g1').map((a) => a.status)).toEqual(['pending', 'rejected']);
    expect(repos.applications.list('g1', { status: 'rejected' })).toHaveLength(1);
  });

  it('upserts account links and finds them by platform user or login', () => {
    const base = { discordUserId: 'u1', platform: 'tiktok' as const, platformUserId: 'open-1', platformLogin: 'Streamer.One', displayName: 'S', accessTokenEnc: 'a', refreshTokenEnc: 'r', scopes: ['user.info.basic'], accessExpiresAt: null, refreshExpiresAt: null };
    const link = repos.links.upsert(base);
    expect(repos.links.byPlatformLogin('tiktok', 'streamer.one')?.id).toBe(link.id);
    repos.links.upsert({ ...base, accessTokenEnc: 'b' });
    expect(repos.links.get('u1', 'tiktok')?.accessTokenEnc).toBe('b');
    expect(repos.links.byPlatformUser('tiktok', 'open-1')?.discordUserId).toBe('u1');
    expect(repos.links.delete('u1', 'tiktok')).toBe(true);
    expect(repos.links.forUser('u1')).toEqual([]);
  });

  it('stores panels, presence grants and the digest queue', () => {
    repos.panels.set('g1', 'notify', 'c1', 'm1');
    repos.panels.set('g1', 'notify', 'c2', 'm2');
    expect(repos.panels.get('g1', 'notify')).toMatchObject({ channelId: 'c2', messageId: 'm2' });

    repos.presence.upsert({ guildId: 'g1', userId: 'u1', startedAt: 't', url: 'https://twitch.tv/x', platform: 'twitch', title: 'hi', game: null, messageChannelId: null, messageId: null });
    expect(repos.presence.list('g1')).toHaveLength(1);
    repos.presence.delete('g1', 'u1');
    expect(repos.presence.get('g1', 'u1')).toBeNull();

    const ch = repos.channels.upsertResolved({ platform: 'twitch', platformId: '1', handle: 'x', displayName: 'X', avatarUrl: null, url: 'u', meta: {} });
    const { item } = repos.content.insert(ch.id, { platform: 'twitch', platformId: '1', contentId: 'c', kind: 'clip', title: 't', url: 'u', thumbnailUrl: null, publishedAt: new Date().toISOString(), durationSec: 30, viewCount: 5 }, false);
    expect(repos.digest.enqueue('g1', item.id, null)).toBe(true);
    expect(repos.digest.enqueue('g1', item.id, null)).toBe(false);
    expect(repos.digest.guildsWithPending()).toEqual(['g1']);
    const pending = repos.digest.pending('g1');
    expect(pending[0]?.item.contentId).toBe('c');
    repos.digest.markPosted(pending.map((p) => p.id));
    expect(repos.digest.pending('g1')).toEqual([]);
  });
});
