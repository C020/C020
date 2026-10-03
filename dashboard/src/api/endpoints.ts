import { apiRequest, ApiRequestError, http } from './client';
import type {
  AccountInput,
  AuditEntry,
  AuditLevel,
  ContentDto,
  CreateStreamerRequest,
  DiscordLookups,
  GuildOverview,
  LeaderboardEntry,
  MemberDto,
  MeResponse,
  MessagePreview,
  MessageType,
  ResolvePreview,
  ResolveRequest,
  SessionDto,
  SettingsDto,
  SettingsUpdate,
  StreamerDto,
  SystemStatus,
  TemplateSpec,
  UpdateAccountRequest,
  UpdateStreamerRequest,
} from './types';

const g = (guildId: string, path = ''): string => `/api/guilds/${encodeURIComponent(guildId)}${path}`;

export const api = {
  /** Resolves to null when not logged in (401). */
  me: async (signal?: AbortSignal): Promise<MeResponse | null> => {
    try {
      return await apiRequest<MeResponse>('/api/me', { signal, silentUnauthorized: true });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) return null;
      throw error;
    }
  },
  logout: () => http.post<{ ok: true }>('/auth/logout'),
  system: (signal?: AbortSignal) => http.get<SystemStatus>('/api/system', undefined, signal),
  resolve: (body: ResolveRequest, signal?: AbortSignal) => http.post<ResolvePreview>('/api/platforms/resolve', body, signal),

  overview: (guildId: string, signal?: AbortSignal) => http.get<GuildOverview>(g(guildId, '/overview'), undefined, signal),
  discord: (guildId: string, signal?: AbortSignal) => http.get<DiscordLookups>(g(guildId, '/discord'), undefined, signal),
  member: (guildId: string, userId: string, signal?: AbortSignal) =>
    http.get<MemberDto>(g(guildId, `/members/${encodeURIComponent(userId)}`), undefined, signal),

  settings: (guildId: string, signal?: AbortSignal) => http.get<SettingsDto>(g(guildId, '/settings'), undefined, signal),
  updateSettings: (guildId: string, body: SettingsUpdate) => http.put<SettingsDto>(g(guildId, '/settings'), body),

  streamers: (guildId: string, signal?: AbortSignal) => http.get<StreamerDto[]>(g(guildId, '/streamers'), undefined, signal),
  streamer: (guildId: string, id: number, signal?: AbortSignal) => http.get<StreamerDto>(g(guildId, `/streamers/${id}`), undefined, signal),
  createStreamer: (guildId: string, body: CreateStreamerRequest) => http.post<StreamerDto>(g(guildId, '/streamers'), body),
  updateStreamer: (guildId: string, id: number, body: UpdateStreamerRequest) => http.patch<StreamerDto>(g(guildId, `/streamers/${id}`), body),
  deleteStreamer: (guildId: string, id: number) => http.delete<{ ok: true }>(g(guildId, `/streamers/${id}`)),
  addAccount: (guildId: string, id: number, body: AccountInput) => http.post<StreamerDto>(g(guildId, `/streamers/${id}/accounts`), body),
  updateAccount: (guildId: string, id: number, accountId: number, body: UpdateAccountRequest) =>
    http.patch<StreamerDto>(g(guildId, `/streamers/${id}/accounts/${accountId}`), body),
  removeAccount: (guildId: string, id: number, accountId: number) => http.delete<StreamerDto>(g(guildId, `/streamers/${id}/accounts/${accountId}`)),
  checkStreamer: (guildId: string, id: number) => http.post<{ ok: true }>(g(guildId, `/streamers/${id}/check`)),

  sessions: (guildId: string, params: { limit: number; offset: number }, signal?: AbortSignal) =>
    http.get<{ items: SessionDto[]; total: number }>(g(guildId, '/sessions'), params, signal),
  content: (guildId: string, limit: number, signal?: AbortSignal) => http.get<ContentDto[]>(g(guildId, '/content'), { limit }, signal),
  audit: (guildId: string, params: { limit: number; beforeId?: number; level?: AuditLevel }, signal?: AbortSignal) =>
    http.get<AuditEntry[]>(g(guildId, '/audit'), params, signal),
  leaderboard: (guildId: string, days: number, signal?: AbortSignal) => http.get<LeaderboardEntry[]>(g(guildId, '/leaderboard'), { days }, signal),

  test: (guildId: string, type: MessageType) => http.post<{ ok: true; messageUrl: string | null }>(g(guildId, '/test'), { type }),
  syncRoles: (guildId: string) => http.post<{ added: number; removed: number }>(g(guildId, '/sync-roles')),
  preview: (guildId: string, type: MessageType, template: TemplateSpec | undefined, signal?: AbortSignal) =>
    http.post<MessagePreview>(g(guildId, '/preview'), { type, template }, signal),
};
