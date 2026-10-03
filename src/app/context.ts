/**
 * Application composition contracts. Concrete classes implement these interfaces; the web layer and
 * slash commands depend only on AppContext, so modules can be developed/tested independently.
 */
import type { AppConfig } from '../config.js';
import type { AppEvents } from '../core/events.js';
import type { ContentKind, Platform, ResolvedChannel } from '../core/types.js';
import type { AccountInput, CreateStreamerRequest, MessagePreview, UpdateAccountRequest, UpdateStreamerRequest } from '../shared/api.js';
import type { TemplateSpec, StreamerWithAccounts } from '../db/models.js';
import type { Repositories } from '../db/repositories.js';
import type { PlatformProvider, PushHint, WebhookAdapter } from '../platforms/types.js';
import type { AuditService } from '../services/audit.js';
import type {
  ContentEventHandler,
  DiscordGateway,
  LiveEventHandler,
  LiveView,
  MessageRef,
  MonitorControl,
  Notifier,
  RoleManager,
  SummaryView,
} from '../services/ports.js';

export type { AccountInput, CreateStreamerRequest, UpdateAccountRequest, UpdateStreamerRequest };

export interface ProviderRegistryApi {
  get(platform: Platform): PlatformProvider;
  all(): PlatformProvider[];
  /** Providers whose credentials are present. */
  configured(): PlatformProvider[];
  /** Active webhook adapters (push configured). */
  webhooks(): Array<{ platform: Platform; adapter: WebhookAdapter }>;
}

export interface ProviderRuntimeStatus {
  platform: Platform;
  trackedChannels: number;
  liveChannels: number;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveErrors: number;
}

export interface MonitorApi extends MonitorControl {
  start(): void;
  stop(): Promise<void>;
  /** Push hints from webhooks → immediate targeted re-checks. */
  handleHints(hints: PushHint[]): void;
  status(): ProviderRuntimeStatus[];
}

export interface StreamerServiceApi {
  list(guildId: string): StreamerWithAccounts[];
  /** Throws ValidationError('...غير موجود') when missing or in another guild. */
  get(guildId: string, streamerId: number): StreamerWithAccounts;
  create(guildId: string, req: CreateStreamerRequest, actor: string): Promise<StreamerWithAccounts>;
  update(guildId: string, streamerId: number, patch: UpdateStreamerRequest, actor: string): Promise<StreamerWithAccounts>;
  delete(guildId: string, streamerId: number, actor: string): Promise<void>;
  addAccount(guildId: string, streamerId: number, input: AccountInput, actor: string): Promise<StreamerWithAccounts>;
  updateAccount(guildId: string, streamerId: number, accountId: number, patch: UpdateAccountRequest, actor: string): Promise<StreamerWithAccounts>;
  removeAccount(guildId: string, streamerId: number, accountId: number, actor: string): Promise<StreamerWithAccounts>;
  /** Resolve + validate a platform account (dashboard preview). Throws ValidationError / ChannelNotFoundError. */
  resolve(platform: Platform, input: string): Promise<ResolvedChannel>;
  /** Force an immediate live/content check of all the streamer's channels. */
  checkNow(guildId: string, streamerId: number): void;
}

export interface SessionServiceApi extends LiveEventHandler {
  /** Starts the periodic tick (throttled message edits, merge-window expiry, category time accounting). */
  start(): void;
  stop(): void;
  /** Startup consistency: end stale sessions, then reconcile roles in every guild. */
  reconcile(): Promise<void>;
  syncRoles(guildId: string, actor: string): Promise<{ added: number; removed: number }>;
  /** Live sessions of a guild rendered as views (dashboard "live now"). */
  liveViews(guildId: string): LiveView[];
  /** Summary for any session (dashboard history). */
  summaryOf(sessionId: number): SummaryView | null;
  /** End the active session of a streamer immediately (e.g. streamer deleted/disabled). */
  endStreamerSession(streamerId: number, reason: string): Promise<void>;
}

export type ContentServiceApi = ContentEventHandler;

export interface DiscordApi extends DiscordGateway, Notifier, RoleManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Give slash commands access to services (called once during wiring). */
  attachServices(services: { streamers: StreamerServiceApi; sessions: SessionServiceApi; repos: Repositories; audit: AuditService }): void;
  /** Render a message preview with sample data (and optional template override) for the dashboard editor. */
  preview(guildId: string, type: 'live' | 'summary' | 'content', template?: TemplateSpec): Promise<MessagePreview>;
  /** Send a test notification with sample data to the configured channel. */
  sendTest(guildId: string, type: 'live' | 'summary' | 'content'): Promise<MessageRef | null>;
  messageUrl(guildId: string, ref: MessageRef): string;
  /** Bot invite URL with the permissions the bot needs. */
  inviteUrl(): string;
}

export interface AppContext {
  config: AppConfig;
  version: string;
  startedAt: number;
  repos: Repositories;
  events: AppEvents;
  audit: AuditService;
  providers: ProviderRegistryApi;
  monitor: MonitorApi;
  streamers: StreamerServiceApi;
  sessions: SessionServiceApi;
  content: ContentServiceApi;
  discord: DiscordApi;
}

/** Content kinds a guild/account wants for a provider (helper type for services/monitor). */
export type KindFilter = ReadonlySet<ContentKind>;
