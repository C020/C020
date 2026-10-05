/**
 * Application composition contracts. Concrete classes implement these interfaces; the web layer and
 * slash commands depend only on AppContext, so modules can be developed/tested independently.
 */
import type { AppConfig } from '../config.js';
import type { AppEvents } from '../core/events.js';
import type { ContentKind, Platform, ResolvedChannel } from '../core/types.js';
import type { AccountInput, CreateStreamerRequest, MessagePreview, UpdateAccountRequest, UpdateStreamerRequest } from '../shared/api.js';
import type {
  AccountLink,
  LinkPlatform,
  LiveSample,
  PanelKind,
  StreamerApplication,
  StreamerWithAccounts,
  TemplateSpec,
} from '../db/models.js';
import type { Repositories } from '../db/repositories.js';
import type { LinkedTokenSource, PlatformProvider, PushHint, WebhookAdapter } from '../platforms/types.js';
import type { AuditService } from '../services/audit.js';
import type {
  ContentEventHandler,
  DiscordActions,
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
  /** Reconcile live roles now (after a Discord gateway resume, presence changes, ...). */
  reconcileLiveRoles(): Promise<void>;
  /**
   * #15 — extra members who count as live for role reconciliation (Discord Streaming presence). Without it the
   * periodic live-role reconcile would strip presence-granted roles.
   */
  setExtraLiveUsers(source: { liveUserIds(guildId: string): Set<string> }): void;
}

export interface ContentServiceApi extends ContentEventHandler {
  /** Starts timers (#6 daily clip digest scheduler, retries). */
  start?(): void;
  stop?(): void;
  /** #6 — post the guild's pending clip digest now (dashboard "post digest now"). Returns the message ref or null. */
  postDigestNow?(guildId: string, actor: string): Promise<MessageRef | null>;
}

// ───────────── v2 services ─────────────

/** #9 — streamer applications. All validation messages are user-facing (guild language). */
export interface ApplicationServiceApi {
  /** Member submits from the Discord modal. Throws ValidationError (disabled, already registered, pending exists, no account, bad input). */
  submit(guildId: string, input: { userId: string; username: string; accounts: Array<{ platform: Platform; input: string }>; note: string | null }): Promise<StreamerApplication>;
  list(guildId: string, opts?: { status?: StreamerApplication['status']; limit?: number; beforeId?: number }): StreamerApplication[];
  /** Throws ValidationError when missing / other guild. */
  get(guildId: string, applicationId: number): StreamerApplication;
  /**
   * Approve: registers the streamer (StreamerService.create) with the application accounts, optionally edited by
   * the reviewer. Accounts that fail to resolve are reported; at least one must succeed.
   */
  approve(
    guildId: string,
    applicationId: number,
    actor: string,
    opts?: { note?: string | null; accounts?: AccountInput[] },
  ): Promise<{ application: StreamerApplication; streamer: StreamerWithAccounts; skipped: Array<{ platform: Platform; input: string; reason: string }> }>;
  reject(guildId: string, applicationId: number, actor: string, note?: string | null): Promise<StreamerApplication>;
  /** Applicant withdraws their pending application. */
  cancel(guildId: string, userId: string): Promise<boolean>;
}

export interface ManualPostPreview {
  platform: Platform;
  kind: ContentKind;
  contentId: string;
  url: string;
  title: string | null;
  thumbnailUrl: string | null;
  /** Registered streamer matched from the URL's channel, if any. */
  streamer: { id: number; displayName: string } | null;
  /** Channel the post would go to (routing applied), null when no content channel is configured. */
  channelId: string | null;
  alreadyPosted: boolean;
}

/** #14 — manual posting of a clip/VOD link (optional feature). */
export interface ManualPostServiceApi {
  /** Parses and enriches a URL (Kick clip/VOD, Twitch clip/VOD, YouTube, TikTok). Throws ValidationError for unsupported URLs. */
  inspect(guildId: string, url: string): Promise<ManualPostPreview>;
  post(
    guildId: string,
    input: { url: string; title?: string | null; thumbnailUrl?: string | null; streamerId?: number | null; kind?: ContentKind | null },
    actor: string,
  ): Promise<{ messageRef: MessageRef | null; contentItemId: number }>;
}

/** #13 — statistics (domain data; the web layer maps it to DTOs). */
export interface StreamerStatsData {
  streamerId: number;
  days: number;
  totals: { sessions: number; seconds: number; peakViewers: number; avgViewers: number | null; contentPosts: number };
  /** Per local day (guild timezone), oldest first, including empty days. */
  daily: Array<{ date: string; seconds: number; sessions: number; peakViewers: number }>;
  platforms: Array<{ platform: Platform; seconds: number; sessions: number; peakViewers: number }>;
  categories: Array<{ name: string; seconds: number }>;
  /** Seconds live per local hour of day (24 buckets) — "when does this streamer usually stream". */
  hours: number[];
  recentSessionIds: number[];
}

export interface StatsServiceApi {
  sessionSamples(sessionId: number): LiveSample[];
  streamerStats(guildId: string, streamerId: number, days: number): StreamerStatsData;
}

/** A member's Discord "Streaming" activity. */
export interface StreamingActivity {
  url: string | null;
  platform: Platform | null;
  title: string | null;
  game: string | null;
}

/** #15 — Discord Streaming presence detection. */
export interface PresenceServiceApi {
  start(): void;
  stop(): void;
  /** Called by the Discord layer on every presence change of a member (activity = null when not streaming). */
  onPresence(guildId: string, userId: string, activity: StreamingActivity | null): Promise<void>;
  /** Members currently live through presence (for live-role reconciliation). */
  liveUserIds(guildId: string): Set<string>;
  /** Re-sync grants with current presences (after (re)connect or settings change). */
  reconcile(guildId?: string): Promise<void>;
}

/** #8 — live counter channel. */
export interface CounterServiceApi {
  start(): void;
  stop(): void;
  /** Schedule a (throttled) refresh of the guild's counter channel. */
  refresh(guildId: string): void;
}

/** #11 — optional official account linking. */
export interface LinkServiceApi extends LinkedTokenSource {
  /** Credentials configured and a public URL available. */
  isAvailable(platform: LinkPlatform): boolean;
  /** Signed, short-lived URL that starts the OAuth flow for this member (sent ephemerally by /link). */
  startUrl(guildId: string, userId: string, platform: LinkPlatform): string;
  linksFor(userId: string): AccountLink[];
  unlink(userId: string, platform: LinkPlatform, actor: string): Promise<boolean>;
}

/** Services available to slash commands and interaction handlers (v2 ones are optional so tests can omit them). */
export interface DiscordServices {
  streamers: StreamerServiceApi;
  sessions: SessionServiceApi;
  repos: Repositories;
  audit: AuditService;
  applications?: ApplicationServiceApi;
  manualPosts?: ManualPostServiceApi;
  links?: LinkServiceApi;
  presence?: PresenceServiceApi;
  counter?: CounterServiceApi;
  content?: ContentServiceApi;
}

export interface DiscordApi extends DiscordGateway, Notifier, RoleManager, DiscordActions {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Give slash commands / interactions access to services (called once during wiring). */
  attachServices(services: DiscordServices): void;
  /** Called after a gateway resume / re-identify (role reconcile, presence re-sync). */
  onGatewayRecovered(listener: () => void): void;
  /** #15 — true when the bot logged in with the privileged Presence intent. */
  presenceIntentEnabled(): boolean;
  /**
   * Post (or move/refresh) an interactive panel: 'notify' = notification-role toggle (#1), 'apply' = streamer
   * application button (#9). Throws ValidationError (guild language) when the feature/channel isn't configured.
   */
  postPanel(guildId: string, kind: PanelKind): Promise<MessageRef>;
  /**
   * Render a message preview with sample data (and optional template override) for the dashboard editor.
   * #5 — with streamerId: use that streamer's name/avatar/color and saved overrides; `template` then overrides the
   * streamer's template fields (the editor's unsaved state).
   */
  preview(guildId: string, type: 'live' | 'summary' | 'content', template?: TemplateSpec, streamerId?: number): Promise<MessagePreview>;
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
  applications: ApplicationServiceApi;
  manualPosts: ManualPostServiceApi;
  stats: StatsServiceApi;
  presence: PresenceServiceApi;
  counter: CounterServiceApi;
  links: LinkServiceApi;
}

/** Content kinds a guild/account wants for a provider (helper type for services/monitor). */
export type KindFilter = ReadonlySet<ContentKind>;
