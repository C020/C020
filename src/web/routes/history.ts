import type { FastifyInstance } from 'fastify';
import type { AuditEntry } from '../../db/models.js';
import type { ContentDto, LeaderboardEntry, SessionDto } from '../../shared/api.js';
import { deletedStreamerSummary } from '../dto.js';
import { auditQuery, contentQuery, leaderboardQuery, parseInput, sessionsQuery } from '../schemas.js';
import { guildIdOf, type ApiDeps } from './deps.js';

const EPOCH = new Date(0).toISOString();

export function registerHistoryRoutes(g: FastifyInstance, deps: ApiDeps): void {
  const { ctx, dto } = deps;

  g.get('/sessions', async (request): Promise<{ items: SessionDto[]; total: number }> => {
    const guildId = guildIdOf(request);
    const { limit, offset } = parseInput(sessionsQuery, request.query);
    const summaries = dto.summaries(guildId);
    const sessions = ctx.repos.sessions.listRecent(guildId, limit, offset);
    dto.prefetchMembers(guildId, [...new Set(sessions.map((s) => summaries(s.streamerId)?.discordUserId).filter((id): id is string => !!id))]);
    return {
      items: sessions.map((s) => dto.session(s, summaries(s.streamerId) ?? deletedStreamerSummary(s.streamerId))),
      total: ctx.repos.sessions.totals(guildId, EPOCH).reduce((n, row) => n + row.sessions, 0),
    };
  });

  g.get('/content', async (request): Promise<ContentDto[]> => {
    const guildId = guildIdOf(request);
    const { limit } = parseInput(contentQuery, request.query);
    return dto.contentList(ctx.repos.content.recentForGuild(guildId, limit), dto.summaries(guildId));
  });

  g.get('/audit', async (request): Promise<AuditEntry[]> => {
    const guildId = guildIdOf(request);
    const { limit, beforeId, level } = parseInput(auditQuery, request.query);
    return ctx.repos.audit.list({ guildId, limit, beforeId, level });
  });

  g.get('/leaderboard', async (request): Promise<LeaderboardEntry[]> => {
    const guildId = guildIdOf(request);
    const { days } = parseInput(leaderboardQuery, request.query);
    return dto.leaderboard(guildId, days);
  });
}
