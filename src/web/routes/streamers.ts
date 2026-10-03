import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app/context.js';
import type { StreamerDto } from '../../shared/api.js';
import { notFound } from '../httpErrors.js';
import {
  accountInputSchema,
  accountParams,
  createStreamerSchema,
  parseInput,
  streamerParams,
  updateAccountSchema,
  updateStreamerSchema,
} from '../schemas.js';
import { guildIdOf, requireAuth, type ApiDeps } from './deps.js';

export function registerStreamerRoutes(g: FastifyInstance, deps: ApiDeps): void {
  const { ctx, dto } = deps;

  g.get('/streamers', async (request): Promise<StreamerDto[]> => dto.streamerList(guildIdOf(request)));

  g.post('/streamers', async (request, reply) => {
    const guildId = guildIdOf(request);
    const body = parseInput(createStreamerSchema, request.body);
    const created = await ctx.streamers.create(guildId, body, requireAuth(request).actor);
    deps.members.invalidate(guildId, created.discordUserId);
    return reply.code(201).send(await dto.streamer(created));
  });

  g.get('/streamers/:id', async (request): Promise<StreamerDto> => {
    const { guildId, id } = parseInput(streamerParams, request.params);
    ensureStreamer(ctx, guildId, id);
    return dto.streamer(ctx.streamers.get(guildId, id));
  });

  g.patch('/streamers/:id', async (request): Promise<StreamerDto> => {
    const { guildId, id } = parseInput(streamerParams, request.params);
    ensureStreamer(ctx, guildId, id);
    const body = parseInput(updateStreamerSchema, request.body ?? {});
    return dto.streamer(await ctx.streamers.update(guildId, id, body, requireAuth(request).actor));
  });

  g.delete('/streamers/:id', async (request) => {
    const { guildId, id } = parseInput(streamerParams, request.params);
    ensureStreamer(ctx, guildId, id);
    await ctx.streamers.delete(guildId, id, requireAuth(request).actor);
    return { ok: true as const };
  });

  g.post('/streamers/:id/accounts', async (request): Promise<StreamerDto> => {
    const { guildId, id } = parseInput(streamerParams, request.params);
    ensureStreamer(ctx, guildId, id);
    const body = parseInput(accountInputSchema, request.body);
    return dto.streamer(await ctx.streamers.addAccount(guildId, id, body, requireAuth(request).actor));
  });

  g.patch('/streamers/:id/accounts/:accountId', async (request): Promise<StreamerDto> => {
    const { guildId, id, accountId } = parseInput(accountParams, request.params);
    ensureAccount(ctx, guildId, id, accountId);
    const body = parseInput(updateAccountSchema, request.body ?? {});
    return dto.streamer(await ctx.streamers.updateAccount(guildId, id, accountId, body, requireAuth(request).actor));
  });

  g.delete('/streamers/:id/accounts/:accountId', async (request): Promise<StreamerDto> => {
    const { guildId, id, accountId } = parseInput(accountParams, request.params);
    ensureAccount(ctx, guildId, id, accountId);
    return dto.streamer(await ctx.streamers.removeAccount(guildId, id, accountId, requireAuth(request).actor));
  });

  g.post('/streamers/:id/check', { config: { rateLimit: { max: 20, timeWindow: 60_000 } } }, async (request) => {
    const { guildId, id } = parseInput(streamerParams, request.params);
    ensureStreamer(ctx, guildId, id);
    ctx.streamers.checkNow(guildId, id);
    return { ok: true as const };
  });
}

/** 404 (instead of the service's generic validation error) when the streamer is not in this guild. */
function ensureStreamer(ctx: AppContext, guildId: string, streamerId: number): void {
  const streamer = ctx.repos.streamers.get(streamerId);
  if (!streamer || streamer.guildId !== guildId) throw notFound('الستريمر غير موجود');
}

function ensureAccount(ctx: AppContext, guildId: string, streamerId: number, accountId: number): void {
  ensureStreamer(ctx, guildId, streamerId);
  const account = ctx.repos.accounts.get(accountId);
  if (!account || account.streamerId !== streamerId) throw notFound('الحساب غير موجود');
}
