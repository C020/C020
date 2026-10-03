import { existsSync } from 'node:fs';
import { z } from 'zod';

// Load .env when present (Node >= 22 ships process.loadEnvFile).
if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile('.env');
}

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v.trim() === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));

const seconds = (def: number, min: number) => z.coerce.number().int().min(min).default(def);

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),

  // Discord
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID is required'),
  DISCORD_CLIENT_SECRET: optionalString,
  /** Optional: register slash commands to this guild instantly and treat it as the default guild. */
  DISCORD_GUILD_ID: optionalString,

  // Web dashboard
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** Public base URL, e.g. https://bot.example.com — needed for OAuth redirect and webhooks. */
  PUBLIC_URL: optionalString,
  SESSION_SECRET: optionalString,
  /** Discord user ids that can always access the dashboard (besides guild managers). */
  ADMIN_USER_IDS: csv,

  // Storage
  DATABASE_PATH: z.string().default('./data/bot.db'),

  // Twitch
  TWITCH_CLIENT_ID: optionalString,
  TWITCH_CLIENT_SECRET: optionalString,
  /** Secret used to sign Twitch EventSub webhook deliveries (10-100 chars). Enables EventSub when PUBLIC_URL is set. */
  TWITCH_EVENTSUB_SECRET: optionalString,

  // Kick
  KICK_CLIENT_ID: optionalString,
  KICK_CLIENT_SECRET: optionalString,
  /**
   * Kick has no official VOD/clip API. When true, the bot tries Kick's unofficial website endpoints
   * (plain requests, no Cloudflare circumvention). Off by default: Kick's ToS forbid scraping and a
   * violation could get the developer app (which live detection depends on) suspended.
   */
  KICK_UNOFFICIAL_CONTENT: bool(false),

  // YouTube
  YOUTUBE_API_KEY: optionalString,
  /** Optional secret for verifying YouTube WebSub (PubSubHubbub) pushes. Enables WebSub when PUBLIC_URL is set. */
  YOUTUBE_WEBSUB_SECRET: optionalString,

  // TikTok (unofficial)
  /** Optional Euler Stream API key used by tiktok-live-connector style signing; improves TikTok reliability. */
  TIKTOK_SIGN_API_KEY: optionalString,
  /** Optional RSSHub base URL (self-hosted recommended) used as a TikTok video fallback, e.g. http://rsshub:1200 */
  RSSHUB_URL: optionalString,

  // Polling intervals (seconds)
  POLL_TWITCH_LIVE: seconds(60, 15),
  POLL_KICK_LIVE: seconds(60, 15),
  POLL_YOUTUBE_LIVE: seconds(120, 30),
  POLL_TIKTOK_LIVE: seconds(120, 60),
  POLL_CONTENT: seconds(300, 60),
  POLL_TIKTOK_CONTENT: seconds(900, 300),
  /** A live channel must look offline for at least this long (and 2 checks) before it is considered offline. */
  OFFLINE_GRACE_SECONDS: seconds(150, 30),
  /** If a live channel cannot be checked successfully for this long, treat it as offline (avoids stuck roles). */
  STALE_LIVE_MINUTES: z.coerce.number().int().min(5).default(30),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  /** True when webhooks can be received (PUBLIC_URL is https). */
  webhooksEnabled: boolean;
  dashboardEnabled: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration (.env):\n${issues}`);
  }
  const cfg = parsed.data;
  const publicUrl = cfg.PUBLIC_URL?.replace(/\/+$/, '');
  return {
    ...cfg,
    PUBLIC_URL: publicUrl,
    webhooksEnabled: !!publicUrl && publicUrl.startsWith('https://'),
    dashboardEnabled: !!cfg.DISCORD_CLIENT_SECRET && !!cfg.SESSION_SECRET && !!publicUrl,
  };
}
