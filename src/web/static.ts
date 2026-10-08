/**
 * Dashboard SPA hosting: hashed assets with long cache, index.html for client-side routes, and a
 * friendly Arabic page when the dashboard has not been built yet.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildMissingPage } from './pages.js';
import { localizeMessage, requestLanguage } from './i18n.js';

const API_PREFIXES = ['/api', '/auth', '/webhooks'];
const FILE_EXTENSION_RE = /\.[a-z0-9]{1,8}$/i;

export function isBackendPath(path: string): boolean {
  return API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export async function registerStatic(app: FastifyInstance, publicDir: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
    wildcard: true,
    index: ['index.html'],
    dotfiles: 'ignore',
    cacheControl: false,
    // A missing build is expected in development; the fallback page explains it.
    suppressWarning: true,
    setHeaders: (reply, filePath) => {
      const isHashedAsset = /[\\/]assets[\\/]/.test(filePath);
      reply.header('cache-control', isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
}

/**
 * Not-found handler: JSON for backend paths, index.html for SPA routes (GET/HEAD without a file
 * extension), or the "run npm run build" page when the dashboard is missing.
 */
export function spaFallback(publicDir: string) {
  const indexFile = join(publicDir, 'index.html');
  return (request: FastifyRequest, reply: FastifyReply): FastifyReply => {
    const path = request.url.split('?', 1)[0] ?? '/';
    const isPageRequest = (request.method === 'GET' || request.method === 'HEAD') && !isBackendPath(path);
    if (!isPageRequest) {
      return reply.code(404).header('cache-control', 'no-store').send({ error: 'not_found', message: localizeMessage('المسار غير موجود', requestLanguage(request)) });
    }
    if (FILE_EXTENSION_RE.test(path) && !path.endsWith('.html')) {
      // A missing asset must not be answered with HTML (browsers would report a confusing MIME error).
      return reply.code(404).header('cache-control', 'no-store').type('text/plain; charset=utf-8').send('Not found');
    }
    if (existsSync(indexFile)) {
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return reply.code(503).header('cache-control', 'no-store').type('text/html; charset=utf-8').send(buildMissingPage());
  };
}
