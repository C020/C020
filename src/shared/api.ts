/**
 * HTTP API contract shared by the web server (src/web) and the dashboard SPA (dashboard/).
 * Pure types + constants only: this file is imported by browser code, so never import Node modules here.
 *
 * Conventions
 * - All endpoints are under /api, JSON in/out, cookie-session auth (cookie "sb_session", httpOnly).
 * - Mutating requests (POST/PUT/PATCH/DELETE) must send header "x-csrf-token" equal to the value
 *   returned by GET /api/me (csrfToken). The server rejects missing/mismatching tokens with 403.
 * - Errors: non-2xx with body ApiError. `message` is user-facing text (Arabic by default; English when the request
 *   carries header "x-ui-lang: en" and the server has an English message for that error).
 * - Guild-scoped endpoints require the user to be in ADMIN_USER_IDS or to have Manage Server/Administrator
 *   in that guild, and the bot must be in the guild.
 */
import type { ContentKind, LiveSnapshot, Platform } from '../core/types.js';
import type {
  ApplicationStatus,
  AuditEntry,
  GuildFeatures,
  GuildFeaturesPatch,
  GuildOptions,
  LinkPlatform,
  PingMode,
  SessionCategory,
  Templates,
  TemplateSpec,
} from '../db/models.js';

export interface ApiError {
  error: string; // machine code, e.g. "unauthorized", "forbidden", "not_found", "validation", "csrf", "internal"
  message: string; // Arabic, user-facing
  field?: string;
}

// ───────────── auth / session ─────────────
// GET  /auth/login            → 302 to Discord OAuth2 (scopes: identify guilds)
// GET  /auth/callback         → sets cookie, 302 to /
// POST /auth/logout           → clears session (CSRF required)

export interface MeResponse {
  user: { id: string; username: string; avatarUrl: string | null };
  csrfToken: string;
  /** Guilds the user can manage AND the bot is in. */
  guilds: GuildSummary[];
  bot: { id: string; username: string; avatarUrl: string | null; ready: boolean } | null;
  /** OAuth2 URL to invite the bot (with required permissions). */
  inviteUrl: string;
  /** What the server can do (drives which v2 settings the dashboard shows as available). */
  capabilities: Capabilities;
}

export interface Capabilities {
  /** #15 — the bot logged in with the Presence intent. */
  presenceIntent: boolean;
  /** #11 — account linking available per platform (credentials + public URL configured). */
  linking: Record<LinkPlatform, boolean>;
  /** Kick VOD/clip auto-detection enabled on the server (KICK_UNOFFICIAL_CONTENT). */
  kickAutoContent: boolean;
}

export interface GuildSummary {
  id: string;
  name: string;
  iconUrl: string | null;
  memberCount: number;
}

// ───────────── system ─────────────
// GET /api/system  (any authenticated user)
export interface SystemStatus {
  version: string;
  uptimeSec: number;
  webhooksEnabled: boolean;
  publicUrl: string | null;
  providers: ProviderStatus[];
}

export interface ProviderStatus {
  platform: Platform;
  configured: boolean;
  push: boolean; // webhooks active
  trackedChannels: number;
  liveChannels: number;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveErrors: number;
  notes: string[];
}

// ───────────── guild overview ─────────────
// GET /api/guilds/:guildId/overview
export interface GuildOverview {
  guild: GuildSummary;
  diagnostics: DiagnosticsDto;
  counts: { streamers: number; accounts: number; liveNow: number; sessionsLast7d: number; contentLast7d: number; pendingApplications: number };
  liveNow: LiveNowItem[];
  recentSessions: SessionDto[];
  recentContent: ContentDto[];
  recentAudit: AuditEntry[];
}

export interface DiagnosticsDto {
  botInGuild: boolean;
  botHasManageRoles: boolean;
  problems: Array<{ code: string; message: string; level: 'warn' | 'error' }>;
}

export interface LiveNowItem {
  sessionId: number;
  streamer: StreamerSummary;
  startedAt: string;
  totalViewers: number | null;
  peakViewers: number;
  platforms: Array<{ platform: Platform; channelId: number; displayName: string; url: string; snapshot: LiveSnapshot }>;
  messageUrl: string | null;
}

export interface StreamerSummary {
  id: number;
  discordUserId: string;
  displayName: string;
  avatarUrl: string | null; // Discord avatar when known, else first channel avatar
}

// ───────────── Discord lookups (for pickers / validation) ─────────────
// GET /api/guilds/:guildId/discord            → DiscordLookups
// GET /api/guilds/:guildId/members/:userId    → MemberDto (404 when not a member)
export interface DiscordLookups {
  roles: Array<{ id: string; name: string; color: number; position: number; managed: boolean; assignable: boolean }>;
  channels: Array<{ id: string; name: string; type: 'text' | 'announcement'; parentName: string | null; botCanPost: boolean }>;
}

export interface MemberDto {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bot: boolean;
  alreadyStreamer: boolean;
}

// ───────────── settings ─────────────
// GET /api/guilds/:guildId/settings   → SettingsDto
// PUT /api/guilds/:guildId/settings   body: SettingsUpdate → SettingsDto
export interface SettingsDto {
  guildId: string;
  streamerRoleId: string | null;
  liveRoleId: string | null;
  liveChannelId: string | null;
  contentChannelId: string | null;
  logChannelId: string | null;
  pingMode: PingMode;
  pingRoleId: string | null;
  platformsEnabled: Platform[];
  contentKinds: ContentKind[];
  templates: Templates;
  options: GuildOptions;
  /** Optional features (#1 notify role, #4 routing, #6 clips, #8 counter, #9 applications, #10 silent, #11 linking, #14 manual posts, #15 presence, #16 language). */
  features: GuildFeatures;
  updatedAt: string;
}

export type SettingsUpdate = Partial<Omit<SettingsDto, 'guildId' | 'updatedAt' | 'options' | 'features'>> & {
  options?: Partial<GuildOptions>;
  features?: GuildFeaturesPatch;
};

// ───────────── streamers ─────────────
// GET    /api/guilds/:guildId/streamers                       → StreamerDto[]
// POST   /api/guilds/:guildId/streamers        body: CreateStreamerRequest → StreamerDto
// GET    /api/guilds/:guildId/streamers/:id                   → StreamerDto
// PATCH  /api/guilds/:guildId/streamers/:id    body: UpdateStreamerRequest → StreamerDto
// DELETE /api/guilds/:guildId/streamers/:id                   → { ok: true }
// POST   /api/guilds/:guildId/streamers/:id/accounts  body: AccountInput → StreamerDto
// PATCH  /api/guilds/:guildId/streamers/:id/accounts/:accountId body: UpdateAccountRequest → StreamerDto
// DELETE /api/guilds/:guildId/streamers/:id/accounts/:accountId → StreamerDto
// POST   /api/guilds/:guildId/streamers/:id/check             → { ok: true }  (force immediate check)

export interface AccountInput {
  platform: Platform;
  /** Handle, @handle or profile/channel URL. */
  input: string;
  notifyLive?: boolean;
  notifyContent?: boolean;
  /** null/omitted = inherit guild setting */
  contentKinds?: ContentKind[] | null;
}

export interface CreateStreamerRequest {
  discordUserId: string;
  /** Defaults to the member's display name. */
  displayName?: string;
  notes?: string | null;
  color?: number | null;
  accounts: AccountInput[];
}

export interface UpdateStreamerRequest {
  displayName?: string;
  notes?: string | null;
  color?: number | null;
  enabled?: boolean;
  /** #5 — per-streamer template overrides (replaces the whole object; an empty spec for a type = no override). */
  templates?: Templates;
}

export interface UpdateAccountRequest {
  notifyLive?: boolean;
  notifyContent?: boolean;
  contentKinds?: ContentKind[] | null;
}

export interface AccountDto {
  id: number;
  platform: Platform;
  channelId: number;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  url: string;
  notifyLive: boolean;
  notifyContent: boolean;
  contentKinds: ContentKind[] | null;
  isLive: boolean;
  snapshot: LiveSnapshot | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  /** #11 — the member linked this exact platform account officially. */
  verified: boolean;
}

export interface StreamerDto {
  id: number;
  discordUserId: string;
  displayName: string;
  avatarUrl: string | null;
  notes: string | null;
  color: number | null;
  /** #5 — per-streamer template overrides. */
  templates: Templates;
  enabled: boolean;
  isLive: boolean;
  /** Whether the member is still in the guild (null = unknown). */
  inGuild: boolean | null;
  /** #11 — official account links of this member (verified ownership). */
  links: Array<{ platform: LinkPlatform; platformUserId: string; login: string | null; linkedAt: string }>;
  accounts: AccountDto[];
  stats: { sessions30d: number; hours30d: number; peakViewers30d: number };
  createdAt: string;
}

// ───────────── platform resolve (validation preview) ─────────────
// POST /api/platforms/resolve   body: { platform, input } → ResolvePreview   (404 ApiError when not found)
export interface ResolveRequest {
  platform: Platform;
  input: string;
}

export interface ResolvePreview {
  platform: Platform;
  platformId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  url: string;
}

// ───────────── sessions / content / audit ─────────────
// GET /api/guilds/:guildId/sessions?limit=&offset=      → { items: SessionDto[], total: number }
// GET /api/guilds/:guildId/content?limit=               → ContentDto[]
// GET /api/guilds/:guildId/audit?limit=&beforeId=&level= → AuditEntry[]
// GET /api/guilds/:guildId/leaderboard?days=30          → LeaderboardEntry[]
export interface SessionDto {
  id: number;
  streamer: StreamerSummary;
  status: 'live' | 'ended';
  startedAt: string;
  endedAt: string | null;
  durationSec: number;
  peakViewers: number;
  avgViewers: number | null;
  platforms: Platform[];
  categories: SessionCategory[];
  titles: string[];
  vodUrls: Array<{ platform: Platform; url: string }>;
  messageUrl: string | null;
}

export interface ContentDto {
  id: number;
  streamer: StreamerSummary | null;
  platform: Platform;
  kind: ContentKind;
  title: string;
  url: string;
  thumbnailUrl: string | null;
  publishedAt: string;
}

export interface LeaderboardEntry {
  streamer: StreamerSummary;
  seconds: number;
  sessions: number;
  peakViewers: number;
}

// ───────────── tools ─────────────
// POST /api/guilds/:guildId/test        body: { type: 'live' | 'summary' | 'content' } → { ok: true, messageUrl: string | null }
// POST /api/guilds/:guildId/sync-roles  → { added: number, removed: number }
// POST /api/guilds/:guildId/preview     body: { type: 'live' | 'summary' | 'content', template?: TemplateSpec } → MessagePreview
export interface TestRequest {
  type: 'live' | 'summary' | 'content';
}

export interface PreviewRequest {
  type: 'live' | 'summary' | 'content';
  template?: TemplateSpec;
  /** #5 — preview with this streamer's name/avatar/color and saved overrides (template = the edited override). */
  streamerId?: number;
}

/** Discord-like message JSON for the dashboard's live preview renderer. */
export interface MessagePreview {
  content: string | null;
  embeds: Array<{
    title?: string;
    description?: string;
    url?: string;
    color?: number;
    author?: { name: string; icon_url?: string; url?: string };
    thumbnail?: { url: string };
    image?: { url: string };
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    footer?: { text: string; icon_url?: string };
    timestamp?: string;
  }>;
  buttons: Array<{ label: string; url: string; emoji?: string }>;
}

// ───────────── realtime ─────────────
// GET /api/guilds/:guildId/events  (text/event-stream)
// events: "live" (data: { streamerId, status }), "content" (data: ContentDto-like), "audit" (data: AuditEntry), "ping"

/** Template variables documented in the dashboard editor. */
export const TEMPLATE_VARIABLES: Record<'live' | 'summary' | 'content', Array<{ key: string; description: string }>> = {
  live: [
    { key: 'name', description: 'اسم الستريمر' },
    { key: 'mention', description: 'منشن الستريمر' },
    { key: 'platform', description: 'المنصة الأساسية' },
    { key: 'platforms', description: 'كل المنصات اللي يبث عليها' },
    { key: 'title', description: 'عنوان البث' },
    { key: 'game', description: 'اللعبة / القسم' },
    { key: 'category', description: 'القسم (نفس game)' },
    { key: 'viewers', description: 'عدد المشاهدين الحالي (مجموع المنصات)' },
    { key: 'url', description: 'رابط البث الأساسي' },
    { key: 'started', description: 'وقت بداية البث (ديسكورد timestamp)' },
    { key: 'user', description: 'اسم العضو في ديسكورد' },
    { key: 'handle', description: 'يوزر الحساب على المنصة الأساسية' },
  ],
  summary: [
    { key: 'name', description: 'اسم الستريمر' },
    { key: 'mention', description: 'منشن الستريمر' },
    { key: 'duration', description: 'مدة البث' },
    { key: 'peak', description: 'أعلى عدد مشاهدين' },
    { key: 'avg', description: 'متوسط المشاهدين' },
    { key: 'games', description: 'الألعاب / الأقسام' },
    { key: 'platforms', description: 'المنصات' },
    { key: 'title', description: 'آخر عنوان' },
    { key: 'user', description: 'اسم العضو في ديسكورد' },
  ],
  content: [
    { key: 'name', description: 'اسم الستريمر' },
    { key: 'mention', description: 'منشن الستريمر' },
    { key: 'platform', description: 'المنصة' },
    { key: 'kind', description: 'نوع المحتوى (فيديو، شورتس، كليب...)' },
    { key: 'title', description: 'عنوان المقطع' },
    { key: 'url', description: 'رابط المقطع' },
    { key: 'duration', description: 'مدة المقطع' },
    { key: 'views', description: 'عدد المشاهدات' },
    { key: 'channel', description: 'اسم القناة على المنصة' },
    { key: 'handle', description: 'يوزر الحساب على المنصة' },
    { key: 'user', description: 'اسم العضو في ديسكورد' },
  ],
};

// ───────────── v2: applications (#9) ─────────────
// GET  /api/guilds/:guildId/applications?status=&limit=&beforeId=   → ApplicationDto[]
// GET  /api/guilds/:guildId/applications/:id                        → ApplicationDto
// POST /api/guilds/:guildId/applications/:id/approve  body: ApproveApplicationRequest → ApproveApplicationResponse
// POST /api/guilds/:guildId/applications/:id/reject   body: { note?: string | null } → ApplicationDto
export interface ApplicationDto {
  id: number;
  userId: string;
  username: string;
  avatarUrl: string | null;
  /** Member still in the guild (null = unknown). */
  inGuild: boolean | null;
  accounts: Array<{ platform: Platform; input: string }>;
  note: string | null;
  status: ApplicationStatus;
  reviewer: { id: string; username: string | null } | null;
  reviewNote: string | null;
  streamerId: number | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface ApproveApplicationRequest {
  note?: string | null;
  /** Optional edited accounts (defaults to the applicant's inputs). */
  accounts?: AccountInput[];
}

export interface ApproveApplicationResponse {
  application: ApplicationDto;
  streamer: StreamerDto;
  skipped: Array<{ platform: Platform; input: string; reason: string }>;
}

// ───────────── v2: panels (#1 notify role, #9 apply) ─────────────
// POST /api/guilds/:guildId/panels/:kind   (kind = notify | apply) → { ok: true, messageUrl: string }

// ───────────── v2: manual posts (#14) ─────────────
// POST /api/guilds/:guildId/manual-posts/inspect  body: { url } → ManualPostPreviewDto
// POST /api/guilds/:guildId/manual-posts          body: ManualPostRequest → { ok: true, messageUrl: string | null }
export interface ManualPostPreviewDto {
  platform: Platform;
  kind: ContentKind;
  contentId: string;
  url: string;
  title: string | null;
  thumbnailUrl: string | null;
  streamer: { id: number; displayName: string } | null;
  channelId: string | null;
  alreadyPosted: boolean;
}

export interface ManualPostRequest {
  url: string;
  title?: string | null;
  thumbnailUrl?: string | null;
  streamerId?: number | null;
  kind?: ContentKind | null;
}

// ───────────── v2: clips digest (#6) ─────────────
// POST /api/guilds/:guildId/digest/post-now → { ok: true, messageUrl: string | null }

// ───────────── v2: statistics (#13) ─────────────
// GET /api/guilds/:guildId/sessions/:sessionId          → SessionDetailDto
// GET /api/guilds/:guildId/streamers/:id/stats?days=30  → StreamerStatsDto   (days: 7 | 30 | 90 | 365)
export interface ViewerSampleDto {
  at: string;
  total: number | null;
  platforms: Partial<Record<Platform, number | null>>;
  category: string | null;
}

export interface SessionDetailDto extends SessionDto {
  samples: ViewerSampleDto[];
  segments: Array<{
    platform: Platform;
    channelId: number;
    displayName: string;
    url: string;
    startedAt: string;
    endedAt: string | null;
    peakViewers: number;
    vodUrl: string | null;
  }>;
}

export interface StreamerStatsDto {
  streamer: StreamerSummary;
  days: number;
  totals: { sessions: number; seconds: number; peakViewers: number; avgViewers: number | null; contentPosts: number };
  daily: Array<{ date: string; seconds: number; sessions: number; peakViewers: number }>;
  platforms: Array<{ platform: Platform; seconds: number; sessions: number; peakViewers: number }>;
  categories: Array<{ name: string; seconds: number }>;
  /** Seconds live per local hour of day (24 buckets). */
  hours: number[];
  recentSessions: SessionDto[];
}

// ───────────── v2: account links (#11) ─────────────
// DELETE /api/guilds/:guildId/streamers/:id/links/:platform → StreamerDto   (admin removes a member's link)
// GET    /link/start?t=<signed>          → 302 to the platform's OAuth consent screen
// GET    /link/callback/:platform        → small HTML result page (guild language)

// ───────────── realtime additions ─────────────
// events: "application" (data: { applicationId, status })
