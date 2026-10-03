import type { FastifyHelmetOptions } from '@fastify/helmet';
import type { AppConfig } from '../config.js';

/**
 * Trust X-Forwarded-* only from loopback/private networks: the Docker setup puts Caddy on a private
 * bridge network, and a client hitting the port directly cannot spoof its IP for rate limiting.
 */
export const TRUSTED_PROXIES = ['loopback', 'linklocal', 'uniquelocal'];

/** Image CDNs used by Discord and the platforms (avatars, stream thumbnails, category art). */
export const IMAGE_SOURCES = [
  'https://cdn.discordapp.com',
  'https://media.discordapp.net',
  'https://static-cdn.jtvnw.net',
  'https://*.jtvnw.net',
  'https://clips-media-assets2.twitch.tv',
  'https://i.ytimg.com',
  'https://*.ytimg.com',
  'https://yt3.ggpht.com',
  'https://yt3.googleusercontent.com',
  'https://kick.com',
  'https://*.kick.com',
  'https://*.tiktokcdn.com',
  'https://*.tiktokcdn-us.com',
  'https://*.tiktokcdn-eu.com',
  'https://*.ibyteimg.com',
  'https://*.byteimg.com',
];

export function helmetOptions(config: Pick<AppConfig, 'PUBLIC_URL'>): FastifyHelmetOptions {
  const https = config.PUBLIC_URL?.startsWith('https://') ?? false;
  return {
    global: true,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        scriptSrc: ["'self'"],
        // Tailwind/React set inline style attributes; fonts may come from Google Fonts.
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:', ...IMAGE_SOURCES],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        manifestSrc: ["'self'"],
        // Upgrading on plain-http dev setups would break every asset request.
        upgradeInsecureRequests: https ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: https ? { maxAge: 180 * 24 * 60 * 60, includeSubDomains: false } : false,
    referrerPolicy: { policy: 'no-referrer' },
  };
}
