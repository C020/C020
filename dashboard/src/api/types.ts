/**
 * Type surface of the server API (src/shared/api.ts). Model types the contract references are derived
 * from the DTOs so the dashboard only depends on the shared contract.
 */
import type { Platform } from '../../../src/core/types';
import type { DiscordLookups, GuildOverview, SessionDto, SettingsDto, StreamerSummary } from '../../../src/shared/api';

export type {
  AccountDto,
  AccountInput,
  ApiError,
  ContentDto,
  CreateStreamerRequest,
  DiagnosticsDto,
  DiscordLookups,
  GuildOverview,
  GuildSummary,
  LeaderboardEntry,
  LiveNowItem,
  MemberDto,
  MeResponse,
  MessagePreview,
  PreviewRequest,
  ProviderStatus,
  ResolvePreview,
  ResolveRequest,
  SessionDto,
  SettingsDto,
  SettingsUpdate,
  StreamerDto,
  StreamerSummary,
  SystemStatus,
  TestRequest,
  UpdateAccountRequest,
  UpdateStreamerRequest,
} from '../../../src/shared/api';
export type { ContentKind, LiveSnapshot, Platform } from '../../../src/core/types';

export type Templates = SettingsDto['templates'];
export type TemplateSpec = NonNullable<Templates['live']>;
export type GuildOptions = SettingsDto['options'];
export type PingMode = SettingsDto['pingMode'];
export type AuditEntry = GuildOverview['recentAudit'][number];
export type AuditLevel = AuditEntry['level'];
export type SessionCategory = SessionDto['categories'][number];
export type DiscordRole = DiscordLookups['roles'][number];
export type DiscordChannel = DiscordLookups['channels'][number];

/** Payloads of GET /api/guilds/:guildId/events (server-sent events). */
export interface LiveEventData {
  streamerId: number;
  status: 'live' | 'updated' | 'ended';
}

export interface ContentEventData {
  streamerId: number;
  streamer: StreamerSummary | null;
  platform: Platform;
  title: string;
  url: string;
}

export type MessageType = 'live' | 'summary' | 'content';
