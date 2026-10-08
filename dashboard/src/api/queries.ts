/**
 * React Query wiring: one key factory, the shared QueryClient (retry/error policy) and typed hooks for
 * every endpoint. Mutations write server responses straight into the cache so the UI never shows
 * stale data between a save and the next refetch.
 */
import {
  keepPreviousData,
  MutationCache,
  QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { toast } from '../lib/toast';
import { ApiRequestError, errorMessage, setCsrfRefresher, setCsrfToken } from './client';
import { api } from './endpoints';
import type {
  AccountInput,
  ApplicationDto,
  ApplicationStatus,
  ApproveApplicationRequest,
  AuditEntry,
  LinkPlatform,
  ManualPostRequest,
  PanelKind,
  StatsRange,
  AuditLevel,
  CreateStreamerRequest,
  GuildOverview,
  MeResponse,
  MessageType,
  Platform,
  SettingsDto,
  SettingsUpdate,
  StreamerDto,
  TemplateSpec,
  UpdateAccountRequest,
  UpdateStreamerRequest,
} from './types';

export const keys = {
  me: ['me'] as const,
  system: ['system'] as const,
  resolve: (platform: Platform, input: string) => ['resolve', platform, input] as const,
  guild: (guildId: string) => ['guild', guildId] as const,
  overview: (guildId: string) => ['guild', guildId, 'overview'] as const,
  discord: (guildId: string) => ['guild', guildId, 'discord'] as const,
  member: (guildId: string, userId: string) => ['guild', guildId, 'member', userId] as const,
  settings: (guildId: string) => ['guild', guildId, 'settings'] as const,
  streamers: (guildId: string) => ['guild', guildId, 'streamers'] as const,
  sessions: (guildId: string, page?: number, pageSize?: number) =>
    page === undefined ? (['guild', guildId, 'sessions'] as const) : (['guild', guildId, 'sessions', page, pageSize] as const),
  content: (guildId: string) => ['guild', guildId, 'content'] as const,
  audit: (guildId: string, level?: AuditLevel | 'all') =>
    level === undefined ? (['guild', guildId, 'audit'] as const) : (['guild', guildId, 'audit', level] as const),
  leaderboard: (guildId: string, days?: number) =>
    days === undefined ? (['guild', guildId, 'leaderboard'] as const) : (['guild', guildId, 'leaderboard', days] as const),
  preview: (guildId: string, type: MessageType, template: TemplateSpec | undefined, streamerId?: number) =>
    streamerId === undefined ? (['guild', guildId, 'preview', type, template] as const) : (['guild', guildId, 'preview', type, template, streamerId] as const),
  applications: (guildId: string, status?: ApplicationStatus) =>
    status === undefined ? (['guild', guildId, 'applications'] as const) : (['guild', guildId, 'applications', status] as const),
  sessionDetail: (guildId: string, id: number) => ['guild', guildId, 'session', id] as const,
  streamerStats: (guildId: string, id: number, days?: StatsRange) =>
    days === undefined ? (['guild', guildId, 'stats', id] as const) : (['guild', guildId, 'stats', id, days] as const),
  manualInspect: (guildId: string, url: string) => ['guild', guildId, 'manual-inspect', url] as const,
};

declare module '@tanstack/react-query' {
  interface Register {
    defaultError: ApiRequestError | Error;
    mutationMeta: {
      /** Skip the automatic error toast (the caller renders the error inline). */
      silent?: boolean;
    };
  }
}

const NO_RETRY_STATUSES = new Set([400, 401, 403, 404, 409, 413, 422, 429]);

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 20_000,
        gcTime: 10 * 60_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => {
          if (error instanceof ApiRequestError && NO_RETRY_STATUSES.has(error.status)) return false;
          return failureCount < 2;
        },
        retryDelay: (attempt) => Math.min(8000, 800 * 2 ** attempt),
      },
      mutations: { retry: false },
    },
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (mutation.meta?.silent) return;
        if (error instanceof ApiRequestError && error.status === 401) return; // the login screen takes over
        toast.error(errorMessage(error));
      },
    }),
  });
}

/** Installs the CSRF refresher (GET /api/me) used when a mutation hits a stale token. */
export function installSessionHooks(client: QueryClient): void {
  setCsrfRefresher(async () => {
    const me = await client.fetchQuery({ queryKey: keys.me, queryFn: ({ signal }) => fetchMe(signal), staleTime: 0 });
    return me?.csrfToken ?? null;
  });
}

async function fetchMe(signal?: AbortSignal): Promise<MeResponse | null> {
  const me = await api.me(signal);
  setCsrfToken(me?.csrfToken ?? null);
  return me;
}

// ───────────── session ─────────────

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: ({ signal }) => fetchMe(signal),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: (failureCount, error) => error instanceof ApiRequestError && error.isTransient && failureCount < 3,
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.logout(),
    onSettled: () => {
      setCsrfToken(null);
      client.setQueryData(keys.me, null);
      client.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    },
  });
}

export function useSystem() {
  return useQuery({ queryKey: keys.system, queryFn: ({ signal }) => api.system(signal), refetchInterval: 15_000 });
}

/** Debounced callers pass the final input; empty input disables the lookup. */
export function useResolve(platform: Platform, input: string) {
  const value = input.trim();
  return useQuery({
    queryKey: keys.resolve(platform, value),
    queryFn: ({ signal }) => api.resolve({ platform, input: value }, signal),
    enabled: value.length >= 2,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

// ───────────── guild ─────────────

export function useOverview(guildId: string, realtime = true) {
  return useQuery({
    queryKey: keys.overview(guildId),
    queryFn: ({ signal }) => api.overview(guildId, signal),
    // SSE invalidates on changes; polling is the safety net (faster when the stream is down).
    refetchInterval: realtime ? 60_000 : 20_000,
  });
}

export function useDiscordLookups(guildId: string) {
  return useQuery({
    queryKey: keys.discord(guildId),
    queryFn: ({ signal }) => api.discord(guildId, signal),
    staleTime: 60_000,
    retry: (failureCount, error) => error instanceof ApiRequestError && error.isTransient && failureCount < 2,
  });
}

export function useMember(guildId: string, userId: string | null) {
  return useQuery({
    queryKey: keys.member(guildId, userId ?? ''),
    queryFn: ({ signal }) => api.member(guildId, userId ?? '', signal),
    enabled: !!userId,
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useSettings(guildId: string, enabled = true) {
  return useQuery({ queryKey: keys.settings(guildId), queryFn: ({ signal }) => api.settings(guildId, signal), enabled: enabled && guildId !== '' });
}

export function useUpdateSettings(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SettingsUpdate) => api.updateSettings(guildId, body),
    meta: { silent: true },
    onSuccess: (saved: SettingsDto) => {
      client.setQueryData(keys.settings(guildId), saved);
      void client.invalidateQueries({ queryKey: keys.overview(guildId) });
      void client.invalidateQueries({ queryKey: ['guild', guildId, 'preview'] });
    },
  });
}

export function useStreamers(guildId: string) {
  return useQuery({
    queryKey: keys.streamers(guildId),
    queryFn: ({ signal }) => api.streamers(guildId, signal),
    refetchInterval: 90_000,
  });
}

/** Writes one streamer into the cached list (insert or replace). */
function upsertStreamer(client: ReturnType<typeof useQueryClient>, guildId: string, streamer: StreamerDto): void {
  client.setQueryData<StreamerDto[]>(keys.streamers(guildId), (list) => {
    if (!list) return [streamer];
    const index = list.findIndex((s) => s.id === streamer.id);
    if (index === -1) return [streamer, ...list];
    const next = [...list];
    next[index] = streamer;
    return next;
  });
}

function useStreamerMutation<V>(
  guildId: string,
  fn: (vars: V) => Promise<StreamerDto>,
  options: { silent?: boolean; optimistic?: (streamer: StreamerDto, vars: V) => StreamerDto | null; streamerId?: (vars: V) => number } = {},
) {
  const client = useQueryClient();
  const listKey = keys.streamers(guildId);
  return useMutation({
    mutationFn: fn,
    meta: { silent: options.silent },
    onMutate: async (vars: V) => {
      const { optimistic, streamerId } = options;
      if (!optimistic || !streamerId) return { previous: undefined };
      await client.cancelQueries({ queryKey: listKey });
      const previous = client.getQueryData<StreamerDto[]>(listKey);
      const id = streamerId(vars);
      client.setQueryData<StreamerDto[]>(listKey, (list) => list?.map((s) => (s.id === id ? (optimistic(s, vars) ?? s) : s)));
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) client.setQueryData(listKey, context.previous);
    },
    onSuccess: (streamer) => {
      upsertStreamer(client, guildId, streamer);
      void client.invalidateQueries({ queryKey: keys.overview(guildId) });
    },
  });
}

export function useCreateStreamer(guildId: string) {
  return useStreamerMutation(guildId, (body: CreateStreamerRequest) => api.createStreamer(guildId, body), { silent: true });
}

export function useUpdateStreamer(guildId: string) {
  return useStreamerMutation(guildId, ({ id, body }: { id: number; body: UpdateStreamerRequest }) => api.updateStreamer(guildId, id, body), {
    streamerId: (vars) => vars.id,
    optimistic: (streamer, { body }) => ({
      ...streamer,
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
    }),
  });
}

export function useAddAccount(guildId: string) {
  return useStreamerMutation(guildId, ({ id, body }: { id: number; body: AccountInput }) => api.addAccount(guildId, id, body), { silent: true });
}

export function useUpdateAccount(guildId: string) {
  return useStreamerMutation(
    guildId,
    ({ id, accountId, body }: { id: number; accountId: number; body: UpdateAccountRequest }) => api.updateAccount(guildId, id, accountId, body),
    {
      streamerId: (vars) => vars.id,
      optimistic: (streamer, { accountId, body }) => ({
        ...streamer,
        accounts: streamer.accounts.map((a) =>
          a.id === accountId
            ? {
                ...a,
                ...(body.notifyLive !== undefined ? { notifyLive: body.notifyLive } : {}),
                ...(body.notifyContent !== undefined ? { notifyContent: body.notifyContent } : {}),
                ...(body.contentKinds !== undefined ? { contentKinds: body.contentKinds } : {}),
              }
            : a,
        ),
      }),
    },
  );
}

export function useRemoveAccount(guildId: string) {
  return useStreamerMutation(guildId, ({ id, accountId }: { id: number; accountId: number }) => api.removeAccount(guildId, id, accountId));
}

export function useDeleteStreamer(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteStreamer(guildId, id),
    onSuccess: (_result, id) => {
      client.setQueryData<StreamerDto[]>(keys.streamers(guildId), (list) => list?.filter((s) => s.id !== id));
      void client.invalidateQueries({ queryKey: keys.overview(guildId) });
    },
  });
}

export function useCheckStreamer(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.checkStreamer(guildId, id),
    onSuccess: (_result, id) => {
      // The check runs in the background; pick up its result shortly after.
      for (const delay of [4000, 12_000]) {
        setTimeout(() => {
          void api
            .streamer(guildId, id)
            .then((s) => upsertStreamer(client, guildId, s))
            .catch(() => undefined);
          void client.invalidateQueries({ queryKey: keys.overview(guildId) });
        }, delay);
      }
    },
  });
}

export function useSessions(guildId: string, page: number, pageSize: number) {
  return useQuery({
    queryKey: keys.sessions(guildId, page, pageSize),
    queryFn: ({ signal }) => api.sessions(guildId, { limit: pageSize, offset: page * pageSize }, signal),
    placeholderData: keepPreviousData,
  });
}

export function useLeaderboard(guildId: string, days: number) {
  return useQuery({
    queryKey: keys.leaderboard(guildId, days),
    queryFn: ({ signal }) => api.leaderboard(guildId, days, signal),
    placeholderData: keepPreviousData,
  });
}

export function useContent(guildId: string, limit = 30) {
  return useQuery({ queryKey: keys.content(guildId), queryFn: ({ signal }) => api.content(guildId, limit, signal) });
}

export const AUDIT_PAGE_SIZE = 50;

export function useAuditFeed(guildId: string, level: AuditLevel | 'all') {
  return useInfiniteQuery({
    queryKey: keys.audit(guildId, level),
    queryFn: ({ pageParam, signal }) =>
      api.audit(guildId, { limit: AUDIT_PAGE_SIZE, beforeId: pageParam ?? undefined, level: level === 'all' ? undefined : level }, signal),
    initialPageParam: null as number | null,
    getNextPageParam: (lastPage) => (lastPage.length < AUDIT_PAGE_SIZE ? null : (lastPage[lastPage.length - 1]?.id ?? null)),
  });
}

/** Prepends a realtime audit entry to every cached feed whose level filter matches. */
export function prependAuditEntry(client: QueryClient, guildId: string, entry: AuditEntry): void {
  type Feed = { pages: AuditEntry[][]; pageParams: Array<number | null> };
  for (const query of client.getQueryCache().findAll({ queryKey: keys.audit(guildId) })) {
    const level = query.queryKey[3] as AuditLevel | 'all' | undefined;
    if (level && level !== 'all' && level !== entry.level) continue;
    client.setQueryData<Feed>(query.queryKey, (feed) => {
      if (!feed || feed.pages.length === 0) return feed;
      if (feed.pages.some((page) => page.some((e) => e.id === entry.id))) return feed;
      const [first = [], ...rest] = feed.pages;
      return { ...feed, pages: [[entry, ...first], ...rest] };
    });
  }
  client.setQueryData<GuildOverview>(keys.overview(guildId), (overview) => {
    if (!overview || overview.recentAudit.some((e) => e.id === entry.id)) return overview;
    return { ...overview, recentAudit: [entry, ...overview.recentAudit].slice(0, 10) };
  });
}

export function useSyncRoles(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.syncRoles(guildId),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.overview(guildId) }),
  });
}

export function useTestMessage(guildId: string) {
  return useMutation({ mutationFn: (type: MessageType) => api.test(guildId, type) });
}

export function usePreview(guildId: string, type: MessageType, template: TemplateSpec | undefined, streamerId?: number) {
  return useQuery({
    queryKey: keys.preview(guildId, type, template, streamerId),
    queryFn: ({ signal }) => api.preview(guildId, type, template, signal, streamerId),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

// ───────────── v2: applications (#9) ─────────────

export const APPLICATIONS_PAGE_SIZE = 50;

export function useApplications(guildId: string, status: ApplicationStatus) {
  return useInfiniteQuery({
    queryKey: keys.applications(guildId, status),
    queryFn: ({ pageParam, signal }) => api.applications(guildId, { status, limit: APPLICATIONS_PAGE_SIZE, beforeId: pageParam ?? undefined }, signal),
    initialPageParam: null as number | null,
    getNextPageParam: (lastPage) => (lastPage.length < APPLICATIONS_PAGE_SIZE ? null : (lastPage[lastPage.length - 1]?.id ?? null)),
    refetchInterval: 120_000,
  });
}

function useApplicationDecision<V>(guildId: string, fn: (vars: V) => Promise<ApplicationDto>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    meta: { silent: true },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.applications(guildId) });
      void client.invalidateQueries({ queryKey: keys.overview(guildId) });
    },
  });
}

export function useApproveApplication(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: ApproveApplicationRequest }) => api.approveApplication(guildId, id, body),
    meta: { silent: true },
    onSuccess: (result) => {
      upsertStreamer(client, guildId, result.streamer);
      void client.invalidateQueries({ queryKey: keys.applications(guildId) });
      void client.invalidateQueries({ queryKey: keys.overview(guildId) });
    },
  });
}

export function useRejectApplication(guildId: string) {
  return useApplicationDecision(guildId, ({ id, note }: { id: number; note: string | null }) => api.rejectApplication(guildId, id, note));
}

// ───────────── v2: panels, digest, manual posts ─────────────

export function usePostPanel(guildId: string) {
  return useMutation({ mutationFn: (kind: PanelKind) => api.postPanel(guildId, kind) });
}

export function usePostDigestNow(guildId: string) {
  return useMutation({ mutationFn: () => api.postDigestNow(guildId) });
}

export function useInspectManualPost(guildId: string, url: string) {
  const value = url.trim();
  return useQuery({
    queryKey: keys.manualInspect(guildId, value),
    queryFn: ({ signal }) => api.inspectManualPost(guildId, value, signal),
    enabled: /^https?:\/\/\S+\.\S+/i.test(value),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useManualPost(guildId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ManualPostRequest) => api.manualPost(guildId, body),
    meta: { silent: true },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.content(guildId) });
      void client.invalidateQueries({ queryKey: keys.overview(guildId) });
      void client.invalidateQueries({ queryKey: ['guild', guildId, 'manual-inspect'] });
    },
  });
}

// ───────────── v2: statistics (#13) ─────────────

export function useSessionDetail(guildId: string, id: number) {
  return useQuery({
    queryKey: keys.sessionDetail(guildId, id),
    queryFn: ({ signal }) => api.sessionDetail(guildId, id, signal),
    enabled: Number.isInteger(id) && id > 0,
    // Live sessions keep growing; ended ones never change.
    refetchInterval: (query) => (query.state.data?.status === 'live' ? 60_000 : false),
  });
}

export function useStreamerStats(guildId: string, id: number, days: StatsRange) {
  return useQuery({
    queryKey: keys.streamerStats(guildId, id, days),
    queryFn: ({ signal }) => api.streamerStats(guildId, id, days, signal),
    enabled: Number.isInteger(id) && id > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

// ───────────── v2: account links (#11) ─────────────

export function useRemoveLink(guildId: string) {
  return useStreamerMutation(guildId, ({ id, platform }: { id: number; platform: LinkPlatform }) => api.removeLink(guildId, id, platform));
}

/** Invalidates several keys at most once per `delayMs` (bursts of realtime events → one refetch). */
export function createInvalidationBatcher(client: QueryClient, delayMs = 400): { add: (key: QueryKey) => void; cancel: () => void } {
  const pending = new Map<string, QueryKey>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    timer = null;
    const batch = [...pending.values()];
    pending.clear();
    for (const queryKey of batch) void client.invalidateQueries({ queryKey });
  };
  return {
    add(key) {
      pending.set(JSON.stringify(key), key);
      timer ??= setTimeout(flush, delayMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}
