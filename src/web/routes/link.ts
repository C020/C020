/**
 * #11 — public OAuth endpoints for optional account linking:
 *   GET /link/start?t=<signed start token>   → 302 to Twitch / TikTok consent (binds the flow to a browser cookie)
 *   GET /link/callback/:platform              → exchange + small bilingual HTML result page
 * Pages are static HTML with a strict CSP (no scripts, hashed inline style). Tokens/codes are never logged.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../app/context.js';
import { childLogger } from '../../core/logger.js';
import type { Language, LinkPlatform } from '../../db/models.js';
import { LinkFlowError, type LinkAccountOutcome, type LinkErrorCode, type LinkService } from '../../services/linkService.js';

const log = childLogger('web:link');

export const LINK_COOKIE = 'link_flow';
const COOKIE_MAX_AGE_S = 15 * 60;
const LINK_RATE_LIMIT = { max: 30, timeWindow: '1 minute' };

const PLATFORM_LABEL: Record<LinkPlatform, string> = { twitch: 'Twitch', tiktok: 'TikTok' };

type Bi = { ar: string; en: string };

const ERRORS: Record<LinkErrorCode | 'unknown', Bi> = {
  invalid: { ar: 'الرابط غير صالح. ارجع لديسكورد واستخدم أمر /link من جديد.', en: 'This link is invalid. Go back to Discord and run /link again.' },
  expired: { ar: 'انتهت صلاحية الرابط. استخدم أمر /link من جديد.', en: 'This link has expired. Run /link again.' },
  unavailable: { ar: 'ربط هذه المنصة غير مُعد في البوت حالياً.', en: 'Linking this platform is not configured on the bot.' },
  disabled: { ar: 'ربط الحسابات مقفل في هذا السيرفر.', en: 'Account linking is disabled in this server.' },
  denied: { ar: 'تم إلغاء الربط. ما تغيّر شيء.', en: 'Linking was cancelled. Nothing changed.' },
  replay: { ar: 'هذا الرابط مستخدم من قبل. استخدم أمر /link من جديد.', en: 'This link was already used. Run /link again.' },
  exchange_failed: { ar: 'ما قدرنا نتحقق من حسابك عند المنصة. جرّب مرة ثانية بعد شوي.', en: 'We could not verify your account with the platform. Please try again shortly.' },
  already_linked: { ar: 'هذا الحساب مربوط بعضو ثاني في ديسكورد.', en: 'This account is already linked to another Discord member.' },
  unknown: { ar: 'صار خطأ غير متوقع. جرّب مرة ثانية.', en: 'Something went wrong. Please try again.' },
};

const OUTCOME: Record<LinkAccountOutcome, Bi | null> = {
  added: { ar: 'وأضفنا الحساب لملفك كستريمر.', en: 'The account was added to your streamer profile.' },
  verified: { ar: 'وحسابك المسجّل صار موثّق رسمياً.', en: 'Your registered account is now officially verified.' },
  mismatch: { ar: 'ملاحظة: الحساب المسجّل لك في السيرفر يختلف عن الحساب اللي ربطته.', en: 'Note: the account registered for you in the server differs from the one you linked.' },
  not_streamer: null,
  no_handle: null,
  add_failed: { ar: 'ما قدرنا نضيف الحساب لملفك تلقائياً، الإدارة تقدر تضيفه.', en: 'We could not add the account to your profile automatically; an admin can add it.' },
};

const STYLE =
  'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e8eaf0;' +
  'font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif}main{max-width:28rem;margin:1rem;padding:2rem;border-radius:1rem;' +
  'background:#1a1d24;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.4)}h1{font-size:1.4rem;margin:.5rem 0 1rem}p{line-height:1.7;margin:.4rem 0}' +
  '.alt{opacity:.7;font-size:.9rem;margin-top:1.25rem;border-top:1px solid #2c313c;padding-top:1rem}.icon{font-size:2.5rem}';
const STYLE_HASH = createHash('sha256').update(STYLE).digest('base64');
export const LINK_PAGE_CSP = `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderLinkPage(lang: Language, page: { ok: boolean; title: Bi; lines: Bi[] }): string {
  const other: Language = lang === 'en' ? 'ar' : 'en';
  const block = (l: Language) => page.lines.map((line) => `<p>${escapeHtml(line[l])}</p>`).join('');
  const dir = (l: Language) => (l === 'ar' ? 'rtl' : 'ltr');
  return (
    `<!doctype html><html lang="${lang}" dir="${dir(lang)}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
    `<title>${escapeHtml(page.title[lang])}</title><style>${STYLE}</style></head><body><main>` +
    `<div class="icon">${page.ok ? '✅' : '⚠️'}</div><h1>${escapeHtml(page.title[lang])}</h1>${block(lang)}` +
    `<div class="alt" lang="${other}" dir="${dir(other)}"><p><strong>${escapeHtml(page.title[other])}</strong></p>${block(other)}</div>` +
    `</main></body></html>`
  );
}

function sendPage(reply: FastifyReply, status: number, html: string): FastifyReply {
  return reply
    .code(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('content-security-policy', LINK_PAGE_CSP)
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .header('x-content-type-options', 'nosniff')
    .send(html);
}

function errorPage(reply: FastifyReply, err: unknown, fallbackLang: Language | null): FastifyReply {
  const code: LinkErrorCode | 'unknown' = err instanceof LinkFlowError ? err.code : 'unknown';
  const lang = (err instanceof LinkFlowError ? err.language : null) ?? fallbackLang ?? 'ar';
  const status = code === 'unknown' || code === 'exchange_failed' ? 502 : code === 'already_linked' || code === 'replay' ? 409 : code === 'unavailable' || code === 'disabled' ? 403 : 400;
  return sendPage(reply, status, renderLinkPage(lang, { ok: false, title: { ar: 'ما تم الربط', en: 'Account not linked' }, lines: [ERRORS[code]] }));
}

function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function flowCookie(value: string, maxAge: number, secure: boolean): string {
  return `${LINK_COOKIE}=${encodeURIComponent(value)}; Path=/link/callback; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function registerLinkRoutes(app: FastifyInstance, ctx: AppContext, link: LinkService): void {
  const secure = ctx.config.PUBLIC_URL?.startsWith('https://') ?? false;

  app.get('/link/start', { config: { rateLimit: LINK_RATE_LIMIT } }, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    try {
      const { url, nonce } = link.authorizeRedirect(str(query.t));
      return reply.header('set-cookie', flowCookie(nonce, COOKIE_MAX_AGE_S, secure)).header('cache-control', 'no-store').redirect(url, 302);
    } catch (err) {
      if (!(err instanceof LinkFlowError)) log.warn({ err }, 'Link start failed');
      return errorPage(reply, err, null);
    }
  });

  app.get<{ Params: { platform: string } }>('/link/callback/:platform', { config: { rateLimit: LINK_RATE_LIMIT } }, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const state = str(query.state);
    // The flow cookie is single-use whatever happens.
    reply.header('set-cookie', flowCookie('', 0, secure));
    try {
      const result = await link.complete(
        request.params.platform,
        { code: str(query.code), state, error: str(query.error) },
        readCookie(request, LINK_COOKIE),
      );
      const who = result.login ?? result.displayName;
      const label = PLATFORM_LABEL[result.platform];
      const lines: Bi[] = [
        {
          ar: `تم ربط حسابك في ${label}${who ? ` (${who})` : ''} ✅ تقدر تسكر الصفحة.`,
          en: `Your ${label} account${who ? ` (${who})` : ''} is linked ✅ You can close this page.`,
        },
      ];
      const extra = OUTCOME[result.account];
      if (extra) lines.push(extra);
      return sendPage(reply, 200, renderLinkPage(result.language, { ok: true, title: { ar: 'تم ربط حسابك', en: 'Account linked' }, lines }));
    } catch (err) {
      if (!(err instanceof LinkFlowError)) log.warn({ err, platform: request.params.platform }, 'Link callback failed');
      else if (err.code === 'exchange_failed') log.warn({ platform: request.params.platform, reason: err.message }, 'Link exchange failed');
      return errorPage(reply, err, link.languageOfState(state));
    }
  });
}
