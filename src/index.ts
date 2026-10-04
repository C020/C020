import { readFileSync } from 'node:fs';
import type { AppContext } from './app/context.js';
import { loadConfig } from './config.js';
import { AppEvents } from './core/events.js';
import { logger } from './core/logger.js';
import { PLATFORM_LABELS } from './core/types.js';
import { openDatabase } from './db/database.js';
import { Repositories } from './db/repositories.js';
import { DiscordService, DiscordStartupError } from './discord/discordService.js';
import { Monitor } from './monitor/monitor.js';
import { ProviderRegistry } from './platforms/registry.js';
import { AuditService } from './services/audit.js';
import { ContentService } from './services/contentService.js';
import { SessionService } from './services/sessionService.js';
import { StreamerService } from './services/streamerService.js';
import { createWebServer } from './web/server.js';

function readVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    try {
      return (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
    } catch {
      return '0.0.0';
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const version = readVersion();
  logger.info({ version, node: process.version }, 'Starting stream bot');

  const db = openDatabase(config.DATABASE_PATH);
  const repos = new Repositories(db);
  const events = new AppEvents();
  const audit = new AuditService(repos, events);
  const providers = new ProviderRegistry({ config, logger, kv: repos.kv });

  // Wiring order breaks the dependency cycle: Discord (notifier/roles) → services → monitor → streamer management.
  const discord = new DiscordService({ config, repos, audit, events });
  audit.attachNotifier(discord);
  const sessions = new SessionService({ repos, audit, events, notifier: discord, roles: discord, providers });
  const content = new ContentService({ repos, audit, events, notifier: discord });
  const monitor = new Monitor({ config, repos, providers, live: sessions, content, audit, events });
  const streamers = new StreamerService({ repos, audit, providers, discord, roles: discord, sessions, monitor });
  discord.attachServices({ streamers, sessions, repos, audit });
  // Role changes may have failed while the gateway was away.
  discord.onGatewayRecovered(() => void sessions.reconcileLiveRoles().catch((err) => logger.warn({ err }, 'Live role reconcile failed')));

  const ctx: AppContext = {
    config,
    version,
    startedAt: Date.now(),
    repos,
    events,
    audit,
    providers,
    monitor,
    streamers,
    sessions,
    content,
    discord,
  };

  logProviderSummary(ctx);

  // Web first: webhook verification callbacks (Twitch/YouTube) may arrive as soon as we subscribe.
  const web = await createWebServer(ctx);
  await web.start();
  logger.info(
    { port: config.PORT, dashboard: config.dashboardEnabled, webhooks: config.webhooksEnabled, publicUrl: config.PUBLIC_URL ?? null },
    'Web server listening',
  );

  await connectDiscord(discord);
  await sessions.reconcile().catch((err) => logger.error({ err }, 'Startup reconcile failed'));
  sessions.start();
  monitor.start();
  audit.record({ action: 'bot.start', message: `البوت اشتغل (الإصدار ${version})`, mirror: false });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    await monitor.stop().catch(() => {});
    sessions.stop();
    await web.stop().catch(() => {});
    await discord.stop().catch(() => {});
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * Connects to Discord, retrying transient failures (network, Discord outage) with backoff while the web
 * server keeps serving webhooks and the dashboard. Configuration errors (bad token, missing intent) are fatal.
 */
async function connectDiscord(discord: DiscordService): Promise<void> {
  let delayMs = 5_000;
  for (;;) {
    try {
      await discord.start();
      return;
    } catch (err) {
      if (err instanceof DiscordStartupError && err.permanent) throw err;
      logger.error({ err: (err as Error).message, retryInSec: delayMs / 1000 }, 'Discord connection failed, retrying');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 5 * 60_000);
    }
  }
}

function logProviderSummary(ctx: AppContext): void {
  for (const provider of ctx.providers.all()) {
    const health = provider.health();
    logger.info(
      { platform: provider.platform, configured: provider.isConfigured(), push: !!provider.webhook, notes: health.notes },
      `${PLATFORM_LABELS[provider.platform]}: ${provider.isConfigured() ? 'enabled' : 'NOT configured (missing credentials)'}`,
    );
  }
  if (!ctx.config.dashboardEnabled) {
    logger.warn('Dashboard disabled: set DISCORD_CLIENT_SECRET, SESSION_SECRET and PUBLIC_URL to enable it');
  }
}

process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled promise rejection'));
process.on('uncaughtException', (err) => {
  // State may be corrupted; exit and let Docker's restart policy bring us back cleanly.
  logger.fatal({ err }, 'Uncaught exception');
  setTimeout(() => process.exit(1), 500).unref();
});

main().catch((err) => {
  logger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
