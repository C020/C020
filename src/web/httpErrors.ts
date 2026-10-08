import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import {
  ChannelNotFoundError,
  ProviderError,
  ProviderNotConfiguredError,
  RateLimitedError,
  ValidationError,
} from '../core/errors.js';
import { PLATFORM_LABELS } from '../core/types.js';
import { PROVIDER_ENV_KEYS } from '../services/streamerService.js';
import type { ApiError } from '../shared/api.js';
import { localizeMessage, requestLanguage } from './i18n.js';
import { zodToValidationError } from './schemas.js';

/** An error that already knows its HTTP status and user-facing (Arabic) message. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly field?: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const unauthorized = (): HttpError => new HttpError(401, 'unauthorized', 'سجّل دخولك أول عشان تقدر تستخدم لوحة التحكم');
export const forbidden = (message = 'ما عندك صلاحية على هذا السيرفر'): HttpError => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'المطلوب غير موجود'): HttpError => new HttpError(404, 'not_found', message);
export const discordUnavailable = (): HttpError =>
  new HttpError(503, 'discord_unavailable', 'البوت يتصل بديسكورد الحين، جرّب بعد لحظات', undefined, { 'retry-after': '5' });

export interface MappedError {
  status: number;
  body: ApiError;
  headers: Record<string, string>;
  /** Unexpected errors are logged with a stack; expected ones only at debug level. */
  unexpected: boolean;
}

/** Maps any thrown value to the API error shape. Pure, so the mapping is unit-testable. */
export function mapError(err: unknown): MappedError {
  const expected = (status: number, body: ApiError, headers: Record<string, string> = {}): MappedError => ({ status, body, headers, unexpected: false });

  if (err instanceof HttpError) {
    return expected(err.statusCode, withField({ error: err.code, message: err.message }, err.field), err.headers);
  }
  if (err instanceof ZodError) {
    const v = zodToValidationError(err);
    return expected(400, withField({ error: 'validation', message: v.message }, v.field));
  }
  if (err instanceof ValidationError) {
    return expected(400, withField({ error: 'validation', message: err.message }, err.field));
  }
  // Subclasses of ProviderError first: they are all ProviderErrors.
  if (err instanceof ChannelNotFoundError) {
    return expected(404, { error: 'not_found', message: 'الحساب غير موجود على المنصة' });
  }
  if (err instanceof ProviderNotConfiguredError) {
    const label = PLATFORM_LABELS[err.platform];
    const keys = PROVIDER_ENV_KEYS[err.platform] ?? [];
    const message =
      keys.length > 0
        ? `منصة ${label} مو مفعّلة أو مفاتيحها مرفوضة: تأكد من ${keys.join(' و ')} في ملف الإعدادات (.env) وأعد تشغيل البوت`
        : `منصة ${label} مو مفعّلة في البوت، راجع إعدادات البوت`;
    return expected(400, { error: 'provider_not_configured', message });
  }
  if (err instanceof RateLimitedError) {
    const seconds = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
    return expected(
      429,
      { error: 'rate_limited', message: `${PLATFORM_LABELS[err.platform]} طالبة نهدّي شوي، جرّب بعد ${seconds} ثانية` },
      { 'retry-after': String(seconds) },
    );
  }
  if (err instanceof ProviderError) {
    return { ...expected(502, { error: 'provider_error', message: `${PLATFORM_LABELS[err.platform]} ما ردّت الحين، جرّب بعد شوي` }), unexpected: true };
  }

  const status = statusOf(err);
  if (status === 413) return expected(413, { error: 'payload_too_large', message: 'حجم الطلب أكبر من المسموح' });
  if (status === 415) return expected(415, { error: 'unsupported_media_type', message: 'نوع البيانات غير مدعوم، أرسل JSON' });
  if (status === 429) return expected(429, { error: 'rate_limited', message: 'طلبات كثيرة، هدّ شوي وجرّب بعد دقيقة' });
  if (status !== null && status >= 400 && status < 500) {
    return expected(status, { error: 'bad_request', message: 'الطلب غير صالح' });
  }
  return {
    status: 500,
    body: { error: 'internal', message: 'صار خطأ غير متوقع، جرّب مرة ثانية' },
    headers: {},
    unexpected: true,
  };
}

function withField(body: ApiError, field: string | undefined): ApiError {
  return field ? { ...body, field } : body;
}

function statusOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const status = (err as Partial<FastifyError>).statusCode;
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

/** Installs the JSON error handler used by every route (API, auth, health). */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, request, reply) => {
    const mapped = mapError(err);
    if (mapped.unexpected) {
      request.log.error({ err, url: request.url, method: request.method }, 'Request failed');
    } else {
      request.log.debug({ code: mapped.body.error, status: mapped.status, url: request.url }, 'Request rejected');
    }
    if (reply.sent || reply.raw.headersSent) return;
    // #16 — English text for dashboards running in English (header x-ui-lang: en).
    const body: ApiError = { ...mapped.body, message: localizeMessage(mapped.body.message, requestLanguage(request)) };
    void reply.code(mapped.status).headers(mapped.headers).header('cache-control', 'no-store').send(body);
  });
}
