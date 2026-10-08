import { ActivityType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { platformFromStreamUrl, PresenceTracker, sameActivity, streamingActivityFrom } from '../../src/discord/interactions/presence.js';

const G = '111111111111111111';
const A = '200000000000000001';
const B = '200000000000000002';

const streaming = (url: string, details = 'رانكد', state = 'VALORANT') => ({ type: ActivityType.Streaming, name: 'Twitch', url, details, state });
const playing = { type: ActivityType.Playing, name: 'VALORANT' };

describe('streaming activity parsing', () => {
  it('maps stream URL hosts to platforms', () => {
    expect(platformFromStreamUrl('https://www.twitch.tv/abufahad')).toBe('twitch');
    expect(platformFromStreamUrl('https://m.twitch.tv/abufahad')).toBe('twitch');
    expect(platformFromStreamUrl('https://www.youtube.com/watch?v=x')).toBe('youtube');
    expect(platformFromStreamUrl('https://youtu.be/x')).toBe('youtube');
    expect(platformFromStreamUrl('https://kick.com/abufahad')).toBe('kick');
    expect(platformFromStreamUrl('https://www.tiktok.com/@abu/live')).toBe('tiktok');
    expect(platformFromStreamUrl('https://eviltwitch.tv/x')).toBeNull();
    expect(platformFromStreamUrl('https://twitch.tv.evil.com/x')).toBeNull();
    expect(platformFromStreamUrl('not a url')).toBeNull();
    expect(platformFromStreamUrl(null)).toBeNull();
  });

  it('extracts the Streaming activity (title = details, game = state) and ignores other activities', () => {
    expect(streamingActivityFrom([playing, streaming('https://www.twitch.tv/abufahad')])).toEqual({
      url: 'https://www.twitch.tv/abufahad',
      platform: 'twitch',
      title: 'رانكد',
      game: 'VALORANT',
    });
    expect(streamingActivityFrom([playing])).toBeNull();
    expect(streamingActivityFrom(null)).toBeNull();
    expect(streamingActivityFrom([{ type: ActivityType.Streaming, url: 'javascript:alert(1)', details: '  ' }])).toEqual({
      url: null,
      platform: null,
      title: null,
      game: null,
    });
  });

  it('compares activities by value', () => {
    const a = streamingActivityFrom([streaming('https://kick.com/a')]);
    expect(sameActivity(a, streamingActivityFrom([streaming('https://kick.com/a')]))).toBe(true);
    expect(sameActivity(a, streamingActivityFrom([streaming('https://kick.com/a', 'new title')]))).toBe(false);
    expect(sameActivity(null, undefined)).toBe(true);
    expect(sameActivity(a, null)).toBe(false);
  });
});

describe('PresenceTracker', () => {
  it('is unknown (null) until the guild snapshot arrives, then tracks streaming members only', () => {
    const tracker = new PresenceTracker();
    expect(tracker.streaming(G)).toBeNull();
    const changes = tracker.handlePacket({
      t: 'GUILD_CREATE',
      d: {
        id: G,
        presences: [
          { user: { id: A }, status: 'online', activities: [streaming('https://www.twitch.tv/a')] },
          { user: { id: B }, status: 'online', activities: [playing] },
        ],
      },
    });
    expect(changes).toEqual([]);
    expect([...tracker.streaming(G)!.keys()]).toEqual([A]);
  });

  it('reports only real changes of the streaming activity', () => {
    const tracker = new PresenceTracker();
    tracker.handlePacket({ t: 'GUILD_CREATE', d: { id: G, presences: [] } });
    const start = tracker.handlePacket({ t: 'PRESENCE_UPDATE', d: { guild_id: G, user: { id: A }, status: 'online', activities: [streaming('https://kick.com/a')] } });
    expect(start).toEqual([{ guildId: G, userId: A, activity: { url: 'https://kick.com/a', platform: 'kick', title: 'رانكد', game: 'VALORANT' } }]);
    // Status flip with the same activity: nothing to report.
    expect(tracker.handlePacket({ t: 'PRESENCE_UPDATE', d: { guild_id: G, user: { id: A }, status: 'idle', activities: [streaming('https://kick.com/a')] } })).toEqual([]);
    // Title change is reported.
    expect(tracker.handlePacket({ t: 'PRESENCE_UPDATE', d: { guild_id: G, user: { id: A }, status: 'idle', activities: [streaming('https://kick.com/a', 'جديد')] } })).toHaveLength(1);
    // Going offline ends the stream even if stale activities are attached.
    expect(tracker.handlePacket({ t: 'PRESENCE_UPDATE', d: { guild_id: G, user: { id: A }, status: 'offline', activities: [streaming('https://kick.com/a')] } })).toEqual([
      { guildId: G, userId: A, activity: null },
    ]);
    expect(tracker.streaming(G)!.size).toBe(0);
    // A member who was never streaming and still is not: nothing.
    expect(tracker.handlePacket({ t: 'PRESENCE_UPDATE', d: { guild_id: G, user: { id: B }, status: 'online', activities: [playing] } })).toEqual([]);
  });

  it('always reports members who left (a grant may predate the snapshot) and forgets them', () => {
    const tracker = new PresenceTracker();
    tracker.snapshot(G, [{ user: { id: A }, status: 'online', activities: [streaming('https://www.twitch.tv/a')] }]);
    expect(tracker.handlePacket({ t: 'GUILD_MEMBER_REMOVE', d: { guild_id: G, user: { id: A } } })).toEqual([{ guildId: G, userId: A, activity: null }]);
    expect(tracker.handlePacket({ t: 'GUILD_MEMBER_REMOVE', d: { guild_id: G, user: { id: B } } })).toEqual([{ guildId: G, userId: B, activity: null }]);
    expect(tracker.streaming(G)!.size).toBe(0);
  });

  it('a re-identify snapshot replaces the old state; an outage makes the guild unknown again', () => {
    const tracker = new PresenceTracker();
    tracker.snapshot(G, [{ user: { id: A }, status: 'online', activities: [streaming('https://www.twitch.tv/a')] }]);
    tracker.handlePacket({ t: 'GUILD_CREATE', d: { id: G, presences: [{ user: { id: B }, status: 'dnd', activities: [streaming('https://youtu.be/b')] }] } });
    expect([...tracker.streaming(G)!.keys()]).toEqual([B]);
    tracker.handlePacket({ t: 'GUILD_DELETE', d: { id: G, unavailable: true } });
    expect(tracker.streaming(G)).toBeNull();
    // An unavailable GUILD_CREATE is not a snapshot.
    tracker.handlePacket({ t: 'GUILD_CREATE', d: { id: G, unavailable: true } });
    expect(tracker.streaming(G)).toBeNull();
  });

  it('ignores malformed and unrelated packets', () => {
    const tracker = new PresenceTracker();
    expect(tracker.handlePacket(null)).toEqual([]);
    expect(tracker.handlePacket({ t: 'MESSAGE_CREATE', d: {} })).toEqual([]);
    expect(tracker.handlePacket({ t: 'PRESENCE_UPDATE', d: { user: { id: A } } })).toEqual([]);
    expect(tracker.handlePacket({ t: 'PRESENCE_UPDATE', d: null })).toEqual([]);
    expect(tracker.handlePacket({ t: 7, d: {} })).toEqual([]);
  });
});
