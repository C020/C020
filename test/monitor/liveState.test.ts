import { describe, expect, it } from 'vitest';
import type { LiveSnapshot } from '../../src/core/types.js';
import { offlineSnapshot } from '../../src/core/types.js';
import {
  evaluateSnapshot,
  forceOffline,
  isStaleLive,
  type LiveState,
  type LiveTransition,
  nextLiveState,
  offlineConfirmationAt,
  offlineState,
} from '../../src/monitor/liveState.js';
import { liveSnap } from './helpers.js';

const OPTS = { graceMs: 150_000, minMisses: 2 };
const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const at = (sec: number): number => NOW + sec * 1_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const OFF: LiveSnapshot = offlineSnapshot({ platform: 'twitch', platformId: 'p' }, 'https://example.com/p');
const live = (streamId: string | null = 's1', over: Partial<LiveSnapshot> = {}): LiveSnapshot => liveSnap('p', { streamId, ...over });

function liveState(over: Partial<LiveState> = {}): LiveState {
  return { isLive: true, snapshot: live(), liveSince: iso(at(-600)), offlineSince: null, missCount: 0, ...over };
}

/** Feeds a timeline of [secondsFromNow, snapshot] through the machine and returns the emitted events. */
function run(timeline: Array<[number, LiveSnapshot]>, start: LiveState = offlineState()): { events: Array<LiveTransition['event']>; last: LiveTransition | null } {
  let state = start;
  let last: LiveTransition | null = null;
  const events: Array<LiveTransition['event']> = [];
  for (const [sec, snap] of timeline) {
    last = nextLiveState(state, snap, at(sec), OPTS);
    state = last.state;
    events.push(last.event);
  }
  return { events, last };
}

describe('nextLiveState', () => {
  it('offline → live emits "live" and uses the platform start time', () => {
    const t = nextLiveState(offlineState(), live('s1', { startedAt: iso(at(-90)) }), NOW, OPTS);
    expect(t.event).toBe('live');
    expect(t.state).toMatchObject({ isLive: true, liveSince: iso(at(-90)), offlineSince: null, missCount: 0 });
    expect(t.state.snapshot?.streamId).toBe('s1');
  });

  it.each([
    ['missing', null],
    ['unparseable', 'not a date'],
    ['in the future', iso(at(3600))],
  ])('falls back to detection time when startedAt is %s', (_label, startedAt) => {
    const t = nextLiveState(offlineState(), live('s1', { startedAt }), NOW, OPTS);
    expect(t.state.liveSince).toBe(iso(NOW));
  });

  it.each<[string, string | null, string | null, boolean]>([
    ['same stream', 's1', 's1', false],
    ['new stream id', 's1', 's2', true],
    ['previous id unknown', null, 's2', false],
    ['new id unknown', 's1', null, false],
  ])('live + live = update (%s)', (_label, prevId, nextId, changed) => {
    const t = nextLiveState(liveState({ snapshot: live(prevId) }), live(nextId, { viewers: 99 }), NOW, OPTS);
    expect(t.event).toBe('update');
    expect(t.streamChanged).toBe(changed);
    expect(t.state.snapshot?.viewers).toBe(99);
    expect(t.state.liveSince).toBe(iso(at(-600)));
  });

  it('live + live clears a pending offline', () => {
    const t = nextLiveState(liveState({ missCount: 1, offlineSince: iso(at(-30)) }), live(), NOW, OPTS);
    expect(t.event).toBe('update');
    expect(t.state).toMatchObject({ missCount: 0, offlineSince: null });
  });

  it('first miss keeps the channel live and starts the grace period', () => {
    const prev = liveState();
    const t = nextLiveState(prev, OFF, NOW, OPTS);
    expect(t.event).toBeNull();
    expect(t.state).toMatchObject({ isLive: true, missCount: 1, offlineSince: iso(NOW) });
    expect(t.state.snapshot).toEqual(prev.snapshot);
  });

  it('two misses inside the grace window are not enough', () => {
    const { events, last } = run([[60, OFF]], liveState({ missCount: 1, offlineSince: iso(NOW) }));
    expect(events).toEqual([null]);
    expect(last?.state).toMatchObject({ isLive: true, missCount: 2, offlineSince: iso(NOW) });
  });

  it('grace elapsed with a single miss is not enough', () => {
    const t = nextLiveState(liveState(), OFF, NOW, { graceMs: 0, minMisses: 2 });
    expect(t.event).toBeNull();
    expect(t.state.missCount).toBe(1);
  });

  it('declares offline after minMisses and the grace period, ending at the first miss', () => {
    const prev = liveState({ missCount: 1, offlineSince: iso(NOW) });
    const t = nextLiveState(prev, OFF, at(150), OPTS);
    expect(t.event).toBe('offline');
    expect(t.endedAt).toBe(iso(NOW));
    expect(t.lastSnapshot).toEqual(prev.snapshot);
    expect(t.state).toEqual(offlineState());
  });

  it('offline + offline does nothing and normalizes the state', () => {
    const t = nextLiveState({ ...offlineState(), missCount: 3, offlineSince: iso(NOW) }, OFF, NOW, OPTS);
    expect(t.event).toBeNull();
    expect(t.state).toEqual(offlineState());
  });

  it('treats a missing or future offlineSince as "now"', () => {
    expect(nextLiveState(liveState({ missCount: 1, offlineSince: null }), OFF, NOW, OPTS).state.offlineSince).toBe(iso(NOW));
    expect(nextLiveState(liveState({ missCount: 1, offlineSince: iso(at(600)) }), OFF, NOW, OPTS).state.offlineSince).toBe(iso(NOW));
  });

  it('survives a flapping stream without ending the session', () => {
    const { events } = run([
      [0, live('s1')],
      [60, OFF],
      [120, live('s2')], // reconnect inside the grace window
      [180, OFF],
      [240, OFF], // 2 misses but only 60s since the new first miss
      [300, live('s2')],
    ]);
    expect(events).toEqual(['live', null, 'update', null, null, 'update']);
  });

  it('ends a stream that stays offline and starts a new one afterwards', () => {
    const { events, last } = run([
      [0, live('s1')],
      [60, OFF],
      [120, OFF],
      [210, OFF],
      [270, OFF],
      [330, live('s2')],
    ]);
    expect(events).toEqual(['live', null, null, 'offline', null, 'live']);
    expect(last?.state.snapshot?.streamId).toBe('s2');
  });
});

describe('forced offline and helpers', () => {
  it('forceOffline ends a live state at the pending grace start or the given time', () => {
    expect(forceOffline(liveState(), at(-120))).toMatchObject({ event: 'offline', endedAt: iso(at(-120)), state: offlineState() });
    expect(forceOffline(liveState({ offlineSince: iso(at(-30)), missCount: 1 }), NOW).endedAt).toBe(iso(at(-30)));
    expect(forceOffline(offlineState(), NOW).event).toBeNull();
  });

  it('isStaleLive only flags live channels without a recent success', () => {
    const stale = 30 * 60_000;
    expect(isStaleLive(true, NOW - stale, NOW, stale)).toBe(true);
    expect(isStaleLive(true, NOW - stale + 1, NOW, stale)).toBe(false);
    expect(isStaleLive(false, NOW - 10 * stale, NOW, stale)).toBe(false);
    expect(isStaleLive(true, null, NOW, stale)).toBe(false);
  });

  it('offlineConfirmationAt is grace after the first miss, or null', () => {
    expect(offlineConfirmationAt(liveState({ missCount: 1, offlineSince: iso(NOW) }), OPTS)).toBe(at(150));
    expect(offlineConfirmationAt(liveState(), OPTS)).toBeNull();
    expect(offlineConfirmationAt(offlineState(), OPTS)).toBeNull();
  });
});

describe('evaluateSnapshot (blind spots)', () => {
  const EVAL = { ...OPTS, staleMs: 30 * 60_000 };
  const lastSeen = at(-2 * 3600);

  it('behaves like nextLiveState when the channel was checked recently', () => {
    const transitions = evaluateSnapshot(liveState(), live('s2'), NOW, EVAL, at(-60));
    expect(transitions.map((t) => t.event)).toEqual(['update']);
    expect(transitions[0]?.streamChanged).toBe(true);
  });

  it('splits into offline + live when a different stream is live after a long blind spot', () => {
    const transitions = evaluateSnapshot(liveState(), live('s2'), NOW, EVAL, lastSeen);
    expect(transitions.map((t) => t.event)).toEqual(['offline', 'live']);
    expect(transitions[0]?.endedAt).toBe(iso(lastSeen));
    expect(transitions[1]?.state.snapshot?.streamId).toBe('s2');
  });

  it('keeps the same stream as an update after a blind spot', () => {
    expect(evaluateSnapshot(liveState(), live('s1'), NOW, EVAL, lastSeen).map((t) => t.event)).toEqual(['update']);
  });

  it('starts the grace period at the last sighting when found offline after a blind spot', () => {
    const [first] = evaluateSnapshot(liveState(), OFF, NOW, EVAL, lastSeen);
    expect(first?.event).toBeNull();
    expect(first?.state).toMatchObject({ isLive: true, missCount: 1, offlineSince: iso(lastSeen) });
    // the confirming miss ends the stream at the last sighting, not at "now"
    const confirm = nextLiveState(first!.state, OFF, at(15), OPTS);
    expect(confirm).toMatchObject({ event: 'offline', endedAt: iso(lastSeen) });
  });
});
