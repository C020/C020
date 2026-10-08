import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/logger.js', async () => {
  const { pino } = await import('pino');
  const logger = pino({ level: 'silent' });
  return { logger, childLogger: () => logger };
});

import type { SessionServiceApi } from '../../src/app/context.js';
import { ValidationError } from '../../src/core/errors.js';
import { StreamerService, validateStreamerTemplates } from '../../src/services/streamerService.js';
import { addStreamer, configureGuild, createEnv, type Env, resolved } from './helpers.js';

const GUILD = 'g1';
const USER = '100000000000000001';

describe('StreamerService — #5 per-streamer templates', () => {
  let env: Env;
  let svc: StreamerService;
  let streamerId: number;

  beforeEach(() => {
    env = createEnv();
    configureGuild(env.repos, GUILD);
    streamerId = addStreamer(env.repos, GUILD, USER, [resolved('twitch', 'tw1', 'abu')]).streamer.id;
    const sessions = { endStreamerSession: async () => {} } as unknown as SessionServiceApi;
    svc = new StreamerService({ repos: env.repos, audit: env.audit, providers: env.providers, discord: env.gateway, roles: env.roles, sessions, monitor: env.monitor });
  });

  it('persists templates (empty strings kept, unset fields inherited, empty specs dropped)', async () => {
    const out = await svc.update(GUILD, streamerId, { templates: { live: { title: 'Hi {streamer}', content: '', color: 0xff0000 }, summary: {} } }, 'user:1');
    expect(out.templates).toEqual({ live: { title: 'Hi {streamer}', content: '', color: 0xff0000 } });
    expect(env.repos.streamers.get(streamerId)?.templates).toEqual(out.templates);

    // Replaces the whole object.
    const next = await svc.update(GUILD, streamerId, { templates: { content: { footer: 'f' } } }, 'user:1');
    expect(next.templates).toEqual({ content: { footer: 'f' } });

    // Other patches keep the templates.
    const renamed = await svc.update(GUILD, streamerId, { displayName: 'New' }, 'user:1');
    expect(renamed.templates).toEqual({ content: { footer: 'f' } });

    const cleared = await svc.update(GUILD, streamerId, { templates: {} }, 'user:1');
    expect(cleared.templates).toEqual({});
  });

  it('validates templates', () => {
    expect(() => validateStreamerTemplates({ bogus: {} })).toThrow(ValidationError);
    expect(() => validateStreamerTemplates({ live: { title: 5 } })).toThrow(/نص/);
    expect(() => validateStreamerTemplates({ live: { title: 'x'.repeat(257) } })).toThrow(ValidationError);
    expect(() => validateStreamerTemplates({ live: { color: 0x1000000 } })).toThrow(ValidationError);
    expect(() => validateStreamerTemplates([])).toThrow(ValidationError);
    expect(validateStreamerTemplates(null)).toEqual({});
    expect(validateStreamerTemplates({ live: { color: null, description: 'd' } })).toEqual({ live: { description: 'd' } });
  });
});
