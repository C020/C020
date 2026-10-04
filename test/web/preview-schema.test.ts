/** Template preview: a cleared field in the editor draft must render empty, not fall back to the saved template. */
import { afterEach, describe, expect, it } from 'vitest';
import { resolveTemplate } from '../../src/discord/templates.js';
import type { WebServer } from '../../src/web/server.js';
import { parseInput, previewSchema, templatesSchema } from '../../src/web/schemas.js';
import { createEnv, GUILD, login, startServer } from './helpers.js';

let server: WebServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

describe('preview template overrides keep empty strings', () => {
  it('schema: "" stays "" for the preview, while saving still treats blank as "use the default"', () => {
    const preview = parseInput(previewSchema, { type: 'live', template: { content: '', title: 'عنوان', footer: '' } });
    expect(preview.template).toEqual({ content: '', title: 'عنوان', footer: '' });
    expect(parseInput(templatesSchema, { live: { content: '' } }).live).toEqual({ content: undefined });
  });

  it('a cleared message text previews as empty even when the guild saved one', () => {
    const saved = { live: { content: '{mention} بدأ البث!' } };
    const { template } = parseInput(previewSchema, { type: 'live', template: { content: '' } });
    expect(resolveTemplate('live', saved, template).content).toBe('');
  });

  it('POST /preview passes the empty override to the renderer', async () => {
    const env = createEnv();
    server = await startServer(env);
    const auth = login(env);
    const res = await server.app.inject({
      method: 'POST',
      url: `/api/guilds/${GUILD}/preview`,
      headers: auth.headers,
      payload: { type: 'live', template: { content: '', title: '{name} live', color: null } },
    });
    expect(res.statusCode).toBe(200);
    expect(env.discord.preview).toHaveBeenCalledWith(GUILD, 'live', { content: '', title: '{name} live', color: null });
  });

  it('still bounds the override lengths', () => {
    expect(() => parseInput(previewSchema, { type: 'live', template: { title: 'x'.repeat(257) } })).toThrow();
  });
});
