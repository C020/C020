/** #9 — streamer applications reviewed from the dashboard. */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app/context.js';
import type { ApplicationDto, ApproveApplicationResponse } from '../../shared/api.js';
import { HttpError, notFound } from '../httpErrors.js';
import { applicationParams, applicationsQuery, approveApplicationSchema, parseInput, rejectApplicationSchema } from '../schemas.js';
import { guildIdOf, requireAuth, type ApiDeps } from './deps.js';
import { mayChangeAssignedRoles } from './settings.js';

const DECISION_RATE_LIMIT = { max: 30, timeWindow: 60_000 };

export function registerApplicationRoutes(g: FastifyInstance, deps: ApiDeps): void {
  const { ctx, dto } = deps;

  g.get('/applications', async (request): Promise<ApplicationDto[]> => {
    const guildId = guildIdOf(request);
    const { status, limit, beforeId } = parseInput(applicationsQuery, request.query);
    const list = service(ctx).list(guildId, { status, limit, beforeId });
    return dto.applications(guildId, list);
  });

  g.get('/applications/:id', async (request): Promise<ApplicationDto> => {
    const { guildId, id } = parseInput(applicationParams, request.params);
    ensureApplication(ctx, guildId, id);
    const [item] = await dto.applications(guildId, [service(ctx).get(guildId, id)]);
    return item!;
  });

  g.post('/applications/:id/approve', { config: { rateLimit: DECISION_RATE_LIMIT } }, async (request): Promise<ApproveApplicationResponse> => {
    const { guildId, id } = parseInput(applicationParams, request.params);
    const auth = requireAuth(request);
    ensureApplication(ctx, guildId, id);
    const body = parseInput(approveApplicationSchema, request.body ?? {});
    // Same rule as the Discord review button: approving hands out the streamer role automatically.
    const settings = ctx.repos.settings.get(guildId);
    if (settings.streamerRoleId && settings.options.autoStreamerRole && !mayChangeAssignedRoles(auth, guildId)) {
      throw new HttpError(
        403,
        'forbidden',
        'قبول الطلبات يحتاج صلاحية Manage Roles (أو Administrator أو تكون صاحب السيرفر)، لأن البوت بيعطي المقبول رتبة الستريمر',
      );
    }
    const result = await service(ctx).approve(guildId, id, auth.actor, {
      note: body.note,
      ...(body.accounts ? { accounts: body.accounts } : {}),
    });
    deps.members.invalidate(guildId, result.application.userId);
    const [application] = await dto.applications(guildId, [result.application]);
    return { application: application!, streamer: await dto.streamer(result.streamer), skipped: result.skipped.map((s) => ({ ...s })) };
  });

  g.post('/applications/:id/reject', { config: { rateLimit: DECISION_RATE_LIMIT } }, async (request): Promise<ApplicationDto> => {
    const { guildId, id } = parseInput(applicationParams, request.params);
    ensureApplication(ctx, guildId, id);
    const body = parseInput(rejectApplicationSchema, request.body ?? {});
    const rejected = await service(ctx).reject(guildId, id, requireAuth(request).actor, body.note);
    const [item] = await dto.applications(guildId, [rejected]);
    return item!;
  });
}

function service(ctx: AppContext): AppContext['applications'] {
  if (!ctx.applications) throw new HttpError(503, 'unavailable', 'ما قدرنا نكمّل الطلب الحين، جرّب بعد شوي');
  return ctx.applications;
}

/** 404 (instead of the service's validation error) for applications of other guilds. */
function ensureApplication(ctx: AppContext, guildId: string, id: number): void {
  const app = ctx.repos.applications.get(id);
  if (!app || app.guildId !== guildId) throw notFound('الطلب غير موجود');
}
