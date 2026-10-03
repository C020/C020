import type { ProviderRegistryApi } from '../app/context.js';
import type { Platform } from '../core/types.js';
import { PLATFORMS } from '../core/types.js';
import { createKickProvider } from './kick.js';
import { createTikTokProvider } from './tiktok.js';
import { createTwitchProvider } from './twitch.js';
import type { PlatformProvider, ProviderContext, ProviderFactory, WebhookAdapter } from './types.js';
import { createYouTubeProvider } from './youtube.js';

const FACTORIES: Record<Platform, ProviderFactory> = {
  twitch: createTwitchProvider,
  kick: createKickProvider,
  youtube: createYouTubeProvider,
  tiktok: createTikTokProvider,
};

export class ProviderRegistry implements ProviderRegistryApi {
  private readonly providers: Map<Platform, PlatformProvider>;

  constructor(ctx: ProviderContext, overrides: Partial<Record<Platform, PlatformProvider>> = {}) {
    this.providers = new Map(
      PLATFORMS.map((p) => [p, overrides[p] ?? FACTORIES[p]({ ...ctx, logger: ctx.logger.child({ platform: p }) })]),
    );
  }

  get(platform: Platform): PlatformProvider {
    const p = this.providers.get(platform);
    if (!p) throw new Error(`Unknown platform ${platform}`);
    return p;
  }

  all(): PlatformProvider[] {
    return [...this.providers.values()];
  }

  configured(): PlatformProvider[] {
    return this.all().filter((p) => p.isConfigured());
  }

  webhooks(): Array<{ platform: Platform; adapter: WebhookAdapter }> {
    return this.configured()
      .filter((p) => p.webhook)
      .map((p) => ({ platform: p.platform, adapter: p.webhook! }));
  }
}
