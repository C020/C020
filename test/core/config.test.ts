import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const base = { DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: 'c' };

describe('loadConfig', () => {
  it('applies defaults and derives flags', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.PORT).toBe(3000);
    expect(cfg.POLL_TWITCH_LIVE).toBe(60);
    expect(cfg.webhooksEnabled).toBe(false);
    expect(cfg.dashboardEnabled).toBe(false);
    expect(cfg.ADMIN_USER_IDS).toEqual([]);
    expect(cfg.TWITCH_CLIENT_ID).toBeUndefined();
  });

  it('enables webhooks only for https public urls and strips trailing slashes', () => {
    const cfg = loadConfig({ ...base, PUBLIC_URL: 'https://bot.example.com/', DISCORD_CLIENT_SECRET: 's', SESSION_SECRET: 'x' });
    expect(cfg.PUBLIC_URL).toBe('https://bot.example.com');
    expect(cfg.webhooksEnabled).toBe(true);
    expect(cfg.dashboardEnabled).toBe(true);
    expect(loadConfig({ ...base, PUBLIC_URL: 'http://localhost:3000' }).webhooksEnabled).toBe(false);
  });

  it('treats blank optional values as missing and parses csv', () => {
    const cfg = loadConfig({ ...base, TWITCH_CLIENT_ID: '  ', ADMIN_USER_IDS: '1, 2,,3' });
    expect(cfg.TWITCH_CLIENT_ID).toBeUndefined();
    expect(cfg.ADMIN_USER_IDS).toEqual(['1', '2', '3']);
  });

  it('rejects missing required values with a readable message', () => {
    expect(() => loadConfig({})).toThrow(/DISCORD_TOKEN/);
    expect(() => loadConfig({ ...base, POLL_TWITCH_LIVE: '5' })).toThrow(/POLL_TWITCH_LIVE/);
  });
});
