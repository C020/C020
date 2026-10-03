import { describe, expect, it } from 'vitest';
import { classifyDiscordError, discordErrorCode } from '../../src/discord/apiErrors.js';
import { DEFAULT_PLATFORM_EMOJIS, hasCustomEmojis, resolvePlatformEmojis } from '../../src/discord/emojis.js';
import { isSnowflake, KeyedQueue, TimeoutError, WarnThrottle, withTimeout } from '../../src/discord/util.js';

describe('KeyedQueue', () => {
  it('runs tasks for the same key in order and isolates failures', async () => {
    const queue = new KeyedQueue();
    const order: string[] = [];
    const slow = queue.run('g', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('a');
    });
    const failing = queue.run('g', async () => {
      order.push('b');
      throw new Error('boom');
    });
    const after = queue.run('g', async () => {
      order.push('c');
      return 42;
    });
    const other = queue.run('h', async () => order.push('other'));
    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBe(42);
    await slow;
    await other;
    expect(order).toEqual(['other', 'a', 'b', 'c']);
    await new Promise((r) => setTimeout(r, 0));
    expect(queue.size).toBe(0);
  });
});

describe('WarnThrottle', () => {
  it('lets a key through once per window', () => {
    let now = 0;
    const throttle = new WarnThrottle(1000, () => now);
    expect(throttle.allow('k')).toBe(true);
    expect(throttle.allow('k')).toBe(false);
    expect(throttle.allow('other')).toBe(true);
    now = 999;
    expect(throttle.allow('k')).toBe(false);
    now = 1000;
    expect(throttle.allow('k')).toBe(true);
    throttle.reset('k');
    expect(throttle.allow('k')).toBe(true);
  });

  it('bounds memory', () => {
    const throttle = new WarnThrottle(1000, () => 0, 10);
    for (let i = 0; i < 50; i++) throttle.allow(`k${i}`);
    // Oldest keys were evicted, so they are allowed again.
    expect(throttle.allow('k0')).toBe(true);
    expect(throttle.allow('k49')).toBe(false);
  });
});

describe('withTimeout', () => {
  it('rejects slow promises with TimeoutError', async () => {
    await expect(withTimeout(new Promise(() => {}), 10, 'slow')).rejects.toBeInstanceOf(TimeoutError);
    await expect(withTimeout(Promise.resolve(1), 10, 'fast')).resolves.toBe(1);
  });
});

describe('isSnowflake', () => {
  it('accepts 17-20 digit ids only', () => {
    expect(isSnowflake('123456789012345678')).toBe(true);
    expect(isSnowflake('12345')).toBe(false);
    expect(isSnowflake(123456789012345678)).toBe(false);
    expect(isSnowflake('12345678901234567a')).toBe(false);
  });
});

describe('classifyDiscordError', () => {
  it('maps Discord error codes and HTTP statuses', () => {
    expect(classifyDiscordError({ code: 10008 })).toBe('unknown_message');
    expect(classifyDiscordError({ code: 10003 })).toBe('unknown_channel');
    expect(classifyDiscordError({ code: 10004 })).toBe('unknown_channel');
    expect(classifyDiscordError({ code: 10007 })).toBe('unknown_member');
    expect(classifyDiscordError({ code: 10013 })).toBe('unknown_member');
    expect(classifyDiscordError({ code: 10011 })).toBe('unknown_role');
    expect(classifyDiscordError({ code: 50001 })).toBe('forbidden');
    expect(classifyDiscordError({ code: 50013 })).toBe('forbidden');
    expect(classifyDiscordError({ code: 50035 })).toBe('invalid');
    expect(classifyDiscordError({ status: 403 })).toBe('forbidden');
    expect(classifyDiscordError({ status: 500 })).toBe('transient');
    expect(classifyDiscordError(new Error('ECONNRESET'))).toBe('transient');
    expect(discordErrorCode('nope')).toBeNull();
  });
});

describe('resolvePlatformEmojis', () => {
  it('maps application emojis by name and keeps unicode for the rest', () => {
    const emojis = resolvePlatformEmojis([
      { id: '100000000000000001', name: 'Twitch' },
      { id: '100000000000000002', name: 'kick_logo', animated: true },
      { id: '100000000000000003', name: 'yt' },
      { id: 'bad', name: 'tiktok' },
      { id: '100000000000000004', name: null },
    ]);
    expect(emojis.twitch).toEqual({ text: '<:Twitch:100000000000000001>', component: { id: '100000000000000001', name: 'Twitch' } });
    expect(emojis.kick.text).toBe('<a:kick_logo:100000000000000002>');
    expect(emojis.kick.component.animated).toBe(true);
    expect(emojis.youtube.component.id).toBe('100000000000000003');
    expect(emojis.tiktok).toEqual(DEFAULT_PLATFORM_EMOJIS.tiktok);
    expect(hasCustomEmojis(emojis)).toBe(true);
    expect(hasCustomEmojis(DEFAULT_PLATFORM_EMOJIS)).toBe(false);
  });
});
