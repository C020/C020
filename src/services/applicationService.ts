/**
 * #9 — streamer applications: members apply from a Discord button + modal, reviewers approve/reject from the
 * dashboard or from the review message in Discord.
 *
 * - All user-facing validation errors follow the guild language (features.language).
 * - Approval is tolerant: every account is resolved first; the ones that fail are skipped and reported, at least
 *   one must succeed. The streamer is then registered through StreamerService.create (roles, audit, monitor).
 * - Discord side effects (review message, DM) are best effort and never fail the request.
 */
import type { ApplicationServiceApi, ProviderRegistryApi, StreamerServiceApi } from '../app/context.js';
import { ChannelNotFoundError, errorMessage, ValidationError } from '../core/errors.js';
import type { AppEvents } from '../core/events.js';
import { childLogger } from '../core/logger.js';
import type { Platform } from '../core/types.js';
import { isPlatform, PLATFORMS } from '../core/types.js';
import type { GuildSettings, Language, StreamerApplication, StreamerWithAccounts } from '../db/models.js';
import type { Repositories } from '../db/repositories.js';
import { defineMessages } from '../discord/i18n/index.js';
import type { AccountInput } from '../shared/api.js';
import type { AuditService } from './audit.js';
import type { DiscordActions, DiscordGateway } from './ports.js';

const log = childLogger('applications');

export const MAX_APPLICATION_INPUT_LENGTH = 200;
export const MAX_APPLICATION_NOTE_LENGTH = 500;
const MAX_USERNAME_LENGTH = 64;
const SNOWFLAKE_RE = /^\d{17,20}$/;
const INVISIBLE_CHARS_RE = /[­؜᠎​-‏‪-‮⁠-⁩﻿]/g;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

const PLATFORM_NAMES: Record<Platform, { ar: string; en: string }> = {
  twitch: { ar: 'تويتش', en: 'Twitch' },
  kick: { ar: 'كيك', en: 'Kick' },
  youtube: { ar: 'يوتيوب', en: 'YouTube' },
  tiktok: { ar: 'تيك توك', en: 'TikTok' },
};

export const applicationMessages = defineMessages({
  disabled: { ar: 'التقديم كستريمر مقفل حالياً في هذا السيرفر', en: 'Streamer applications are closed on this server right now' },
  alreadyRegistered: { ar: 'أنت مسجّل كستريمر من قبل ✅', en: "You're already registered as a streamer ✅" },
  pendingExists: { ar: 'عندك طلب قيد المراجعة، انتظر رد الإدارة', en: 'You already have an application under review — please wait for the staff' },
  noAccount: { ar: 'اكتب حساب واحد على الأقل (تويتش، كيك، يوتيوب أو تيك توك)', en: 'Enter at least one account (Twitch, Kick, YouTube or TikTok)' },
  tooLong: { ar: 'النص طويل، الحد {max} حرف', en: 'Too long — the limit is {max} characters' },
  wrongPlatform: { ar: 'الرابط في خانة {field} لازم يكون رابط {field} (الرابط اللي كتبته من {other})', en: 'The {field} field needs a {field} link (you entered a {other} link)' },
  badUser: { ar: 'بيانات العضو غير صحيحة', en: 'Invalid member data' },
  badPlatform: { ar: 'المنصة غير معروفة', en: 'Unknown platform' },
  duplicatePlatform: { ar: 'كتبت حساب {field} أكثر من مرة', en: 'You entered more than one {field} account' },
  notFound: { ar: 'الطلب غير موجود', en: 'Application not found' },
  notPending: { ar: 'هذا الطلب تمت مراجعته من قبل', en: 'This application was already reviewed' },
  busy: { ar: 'الطلب قيد المعالجة الحين، جرّب بعد ثواني', en: 'This application is being processed, try again in a few seconds' },
  noneResolved: { ar: 'ما قدرنا نتحقق من أي حساب في الطلب: {reasons}', en: "None of the application's accounts could be verified: {reasons}" },
  accountNotFound: { ar: 'ما لقينا الحساب', en: 'account not found' },
  accountFailed: { ar: 'تعذّر التحقق', en: 'verification failed' },
  dmApprovedTitle: { ar: 'تم قبول طلبك ✅', en: 'Your application was approved ✅' },
  dmApproved: { ar: 'مبروك! تم قبولك كستريمر في **{guild}**. بننشر إشعار بثوثك تلقائياً.', en: "Congrats! You're now a registered streamer on **{guild}**. Your streams will be announced automatically." },
  dmSkipped: { ar: 'ما قدرنا نضيف هذي الحسابات: {list}', en: "These accounts couldn't be added: {list}" },
  dmRejectedTitle: { ar: 'تم رفض طلبك', en: 'Your application was declined' },
  dmRejected: { ar: 'نعتذر، تم رفض طلبك كستريمر في **{guild}**.', en: 'Sorry, your streamer application on **{guild}** was declined.' },
  dmReason: { ar: 'السبب: {reason}', en: 'Reason: {reason}' },
  auditSubmitted: { ar: 'طلب ستريمر جديد من {user} ({platforms})', en: 'New streamer application from {user} ({platforms})' },
  auditApproved: { ar: 'تم قبول طلب {user} كستريمر', en: "{user}'s streamer application was approved" },
  auditRejected: { ar: 'تم رفض طلب {user}', en: "{user}'s streamer application was declined" },
  auditCancelled: { ar: '{user} سحب طلبه', en: '{user} withdrew their application' },
});

type MsgKey = Parameters<typeof applicationMessages>[1];

export interface ApplicationServiceDeps {
  repos: Repositories;
  audit: AuditService;
  events: AppEvents;
  streamers: StreamerServiceApi;
  /** Accepted for wiring symmetry; account resolution goes through StreamerService.resolve. */
  providers?: ProviderRegistryApi;
  discord: DiscordActions & Partial<Pick<DiscordGateway, 'fetchMember'>>;
  /** Server name used in DMs (optional; falls back to a generic text). */
  guildName?: (guildId: string) => string | null;
  clock?: () => number;
}

/** Platform a URL-looking input belongs to (null when it is not a URL of a known platform). */
export function platformOfUrl(input: string): Platform | null {
  const text = input.trim().toLowerCase();
  const looksLikeUrl = /^[a-z]+:\/\//.test(text) || /^(www\.|m\.)?[a-z0-9-]+\.[a-z.]+\//.test(text) || /^[a-z0-9.-]+\.(tv|com|be)(\/|$)/.test(text);
  if (!looksLikeUrl) return null;
  let host: string;
  try {
    host = new URL(/^[a-z]+:\/\//.test(text) ? text : `https://${text}`).hostname.replace(/^(www\.|m\.|mobile\.)/, '');
  } catch {
    return null;
  }
  if (host === 'twitch.tv' || host.endsWith('.twitch.tv')) return 'twitch';
  if (host === 'kick.com' || host.endsWith('.kick.com')) return 'kick';
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return 'youtube';
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  return null;
}

function cleanText(value: unknown, keepNewlines = false): string {
  if (typeof value !== 'string') return '';
  let text = value.normalize('NFKC').replace(INVISIBLE_CHARS_RE, '').replace(CONTROL_CHARS_RE, ' ');
  text = keepNewlines ? text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : text.replace(/\s+/g, ' ');
  return text.trim();
}

export class ApplicationService implements ApplicationServiceApi {
  private readonly repos: Repositories;
  private readonly audit: AuditService;
  private readonly events: AppEvents;
  private readonly streamers: StreamerServiceApi;
  private readonly discord: ApplicationServiceDeps['discord'];
  private readonly guildName: (guildId: string) => string | null;
  private readonly clock: () => number;
  /** Applications currently being decided (guards double clicks / concurrent reviewers). */
  private readonly deciding = new Set<number>();

  constructor(deps: ApplicationServiceDeps) {
    this.repos = deps.repos;
    this.audit = deps.audit;
    this.events = deps.events;
    this.streamers = deps.streamers;
    this.discord = deps.discord;
    this.guildName = deps.guildName ?? (() => null);
    this.clock = deps.clock ?? Date.now;
  }

  // ───────────────────────────── queries ─────────────────────────────

  list(guildId: string, opts: { status?: StreamerApplication['status']; limit?: number; beforeId?: number } = {}): StreamerApplication[] {
    return this.repos.applications.list(guildId, opts);
  }

  get(guildId: string, applicationId: number): StreamerApplication {
    const app = Number.isSafeInteger(applicationId) && applicationId > 0 ? this.repos.applications.get(applicationId) : null;
    if (!app || app.guildId !== guildId) throw this.error(guildId, 'notFound', 'applicationId');
    return app;
  }

  // ───────────────────────────── submit ─────────────────────────────

  async submit(
    guildId: string,
    input: { userId: string; username: string; accounts: Array<{ platform: Platform; input: string }>; note: string | null },
  ): Promise<StreamerApplication> {
    const settings = this.repos.settings.get(guildId);
    const lang = settings.features.language;
    if (!settings.features.applications.enabled) throw this.error(guildId, 'disabled');
    const userId = typeof input?.userId === 'string' ? input.userId.trim() : '';
    if (!SNOWFLAKE_RE.test(userId)) throw this.error(guildId, 'badUser', 'userId');
    if (this.repos.streamers.getByDiscordId(guildId, userId)) throw this.error(guildId, 'alreadyRegistered');
    if (this.repos.applications.pendingFor(guildId, userId)) throw this.error(guildId, 'pendingExists');

    const username = cleanText(input.username).slice(0, MAX_USERNAME_LENGTH) || userId;
    const accounts: Array<{ platform: Platform; input: string }> = [];
    for (const raw of Array.isArray(input.accounts) ? input.accounts : []) {
      if (!raw || typeof raw !== 'object') continue;
      if (!isPlatform(raw.platform)) throw this.error(guildId, 'badPlatform', 'accounts');
      const field = `accounts.${raw.platform}`;
      const text = cleanText(raw.input);
      if (!text) continue;
      if (text.length > MAX_APPLICATION_INPUT_LENGTH) throw new ValidationError(applicationMessages(lang, 'tooLong', { max: MAX_APPLICATION_INPUT_LENGTH }), field);
      const urlPlatform = platformOfUrl(text);
      if (urlPlatform && urlPlatform !== raw.platform) {
        throw new ValidationError(
          applicationMessages(lang, 'wrongPlatform', { field: PLATFORM_NAMES[raw.platform][lang], other: PLATFORM_NAMES[urlPlatform][lang] }),
          field,
        );
      }
      if (accounts.some((a) => a.platform === raw.platform)) {
        throw new ValidationError(applicationMessages(lang, 'duplicatePlatform', { field: PLATFORM_NAMES[raw.platform][lang] }), field);
      }
      accounts.push({ platform: raw.platform, input: text });
    }
    if (accounts.length === 0) throw this.error(guildId, 'noAccount', 'accounts');
    accounts.sort((a, b) => PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform));

    const note = cleanText(input.note, true);
    if (note.length > MAX_APPLICATION_NOTE_LENGTH) throw new ValidationError(applicationMessages(lang, 'tooLong', { max: MAX_APPLICATION_NOTE_LENGTH }), 'note');

    let app: StreamerApplication;
    try {
      app = this.repos.applications.create({ guildId, userId, username, accounts, note: note || null });
    } catch (err) {
      if (/UNIQUE constraint failed/i.test(errorMessage(err))) throw this.error(guildId, 'pendingExists');
      throw err;
    }

    app = await this.refreshReview(app, settings);
    this.events.emit('application.changed', { guildId, applicationId: app.id, status: 'pending' });
    this.audit.record({
      guildId,
      actor: `user:${userId}`,
      action: 'application.submit',
      message: applicationMessages(lang, 'auditSubmitted', { user: username, platforms: accounts.map((a) => PLATFORM_NAMES[a.platform][lang]).join(lang === 'en' ? ', ' : '، ') }),
      details: { applicationId: app.id, userId, accounts },
      mirror: true,
    });
    return app;
  }

  // ───────────────────────────── decisions ─────────────────────────────

  async approve(
    guildId: string,
    applicationId: number,
    actor: string,
    opts: { note?: string | null; accounts?: AccountInput[] } = {},
  ): Promise<{ application: StreamerApplication; streamer: StreamerWithAccounts; skipped: Array<{ platform: Platform; input: string; reason: string }> }> {
    return this.decide(guildId, applicationId, async (app, settings) => {
      const lang = settings.features.language;
      const candidates: AccountInput[] =
        opts.accounts && Array.isArray(opts.accounts) && opts.accounts.length > 0
          ? opts.accounts
          : app.accounts.map((a) => ({ platform: a.platform, input: a.input }));

      const skipped: Array<{ platform: Platform; input: string; reason: string }> = [];
      const ok: AccountInput[] = [];
      const results = await Promise.allSettled(
        candidates.map(async (a) => {
          if (!a || !isPlatform(a.platform) || typeof a.input !== 'string' || !a.input.trim()) throw new ValidationError(applicationMessages(lang, 'badPlatform'));
          return this.streamers.resolve(a.platform, a.input);
        }),
      );
      const seen = new Set<string>();
      for (const [i, result] of results.entries()) {
        const a = candidates[i]!;
        const platform = isPlatform(a?.platform) ? a.platform : ('twitch' as Platform);
        const inputText = typeof a?.input === 'string' ? a.input : '';
        if (result.status === 'rejected') {
          const reason =
            result.reason instanceof ChannelNotFoundError
              ? applicationMessages(lang, 'accountNotFound')
              : result.reason instanceof ValidationError
                ? result.reason.message
                : applicationMessages(lang, 'accountFailed');
          skipped.push({ platform, input: inputText, reason });
          continue;
        }
        const key = `${result.value.platform}:${result.value.platformId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ok.push({ ...a, platform: result.value.platform, input: inputText.trim() });
      }
      if (ok.length === 0) {
        const reasons = skipped.map((s) => `${PLATFORM_NAMES[s.platform][lang]}: ${s.reason}`).join(' • ');
        throw new ValidationError(applicationMessages(lang, 'noneResolved', { reasons: reasons || '—' }), 'accounts');
      }

      const streamer = await this.streamers.create(
        guildId,
        { discordUserId: app.userId, displayName: app.username.slice(0, MAX_USERNAME_LENGTH), accounts: ok },
        actor,
      );
      const reviewNote = opts.note === undefined ? null : cleanText(opts.note, true).slice(0, MAX_APPLICATION_NOTE_LENGTH) || null;
      const updated =
        this.repos.applications.update(app.id, {
          status: 'approved',
          streamerId: streamer.id,
          reviewerId: reviewerIdOf(actor),
          reviewNote,
          decidedAt: new Date(this.clock()).toISOString(),
        }) ?? app;
      const application = await this.refreshReview(updated, settings);

      if (settings.features.applications.dmApplicant) {
        const lines = [applicationMessages(lang, 'dmApproved', { guild: this.guildLabel(guildId, lang) })];
        if (skipped.length > 0) lines.push(applicationMessages(lang, 'dmSkipped', { list: skipped.map((s) => `${PLATFORM_NAMES[s.platform][lang]} (${s.input})`).join(', ') }));
        if (reviewNote) lines.push(reviewNote);
        await this.dm(app.userId, applicationMessages(lang, 'dmApprovedTitle'), lines.join('\n'), 0x2ecc71);
      }
      this.events.emit('application.changed', { guildId, applicationId: app.id, status: 'approved' });
      this.audit.record({
        guildId,
        actor,
        action: 'application.approve',
        message: applicationMessages(lang, 'auditApproved', { user: app.username }),
        details: { applicationId: app.id, userId: app.userId, streamerId: streamer.id, skipped },
        mirror: true,
      });
      return { application, streamer, skipped };
    });
  }

  async reject(guildId: string, applicationId: number, actor: string, note?: string | null): Promise<StreamerApplication> {
    return this.decide(guildId, applicationId, async (app, settings) => {
      const lang = settings.features.language;
      const reviewNote = note == null ? null : cleanText(note, true).slice(0, MAX_APPLICATION_NOTE_LENGTH) || null;
      const updated =
        this.repos.applications.update(app.id, {
          status: 'rejected',
          reviewerId: reviewerIdOf(actor),
          reviewNote,
          decidedAt: new Date(this.clock()).toISOString(),
        }) ?? app;
      const application = await this.refreshReview(updated, settings);
      if (settings.features.applications.dmApplicant) {
        const lines = [applicationMessages(lang, 'dmRejected', { guild: this.guildLabel(guildId, lang) })];
        if (reviewNote) lines.push(applicationMessages(lang, 'dmReason', { reason: reviewNote }));
        await this.dm(app.userId, applicationMessages(lang, 'dmRejectedTitle'), lines.join('\n'), 0xe74c3c);
      }
      this.events.emit('application.changed', { guildId, applicationId: app.id, status: 'rejected' });
      this.audit.record({
        guildId,
        actor,
        action: 'application.reject',
        message: applicationMessages(lang, 'auditRejected', { user: app.username }),
        details: { applicationId: app.id, userId: app.userId, note: reviewNote },
        mirror: true,
      });
      return application;
    });
  }

  async cancel(guildId: string, userId: string): Promise<boolean> {
    const pending = this.repos.applications.pendingFor(guildId, userId);
    if (!pending || this.deciding.has(pending.id)) return false;
    this.deciding.add(pending.id);
    try {
      const settings = this.repos.settings.get(guildId);
      const updated = this.repos.applications.update(pending.id, { status: 'cancelled', decidedAt: new Date(this.clock()).toISOString() });
      if (!updated) return false;
      await this.refreshReview(updated, settings);
      this.events.emit('application.changed', { guildId, applicationId: pending.id, status: 'cancelled' });
      this.audit.record({
        guildId,
        actor: `user:${userId}`,
        action: 'application.cancel',
        message: applicationMessages(settings.features.language, 'auditCancelled', { user: pending.username }),
        details: { applicationId: pending.id, userId },
      });
      return true;
    } finally {
      this.deciding.delete(pending.id);
    }
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async decide<T>(guildId: string, applicationId: number, fn: (app: StreamerApplication, settings: GuildSettings) => Promise<T>): Promise<T> {
    const app = this.get(guildId, applicationId);
    if (app.status !== 'pending') throw this.error(guildId, 'notPending', 'applicationId');
    if (this.deciding.has(app.id)) throw this.error(guildId, 'busy', 'applicationId');
    this.deciding.add(app.id);
    try {
      // Re-read inside the guard: another request may have decided it meanwhile.
      const fresh = this.repos.applications.get(app.id);
      if (!fresh || fresh.status !== 'pending') throw this.error(guildId, 'notPending', 'applicationId');
      return await fn(fresh, this.repos.settings.get(guildId));
    } finally {
      this.deciding.delete(app.id);
    }
  }

  /** Posts/edits the reviewers' message and stores its ref. Best effort. */
  private async refreshReview(app: StreamerApplication, settings: GuildSettings): Promise<StreamerApplication> {
    if (!settings.features.applications.reviewChannelId && !app.reviewMessageId) return app;
    try {
      const ref = await this.discord.upsertApplicationReview(app, settings);
      if (ref && (ref.channelId !== app.reviewChannelId || ref.messageId !== app.reviewMessageId)) {
        return this.repos.applications.update(app.id, { reviewChannelId: ref.channelId, reviewMessageId: ref.messageId }) ?? app;
      }
    } catch (err) {
      log.warn({ err, guildId: app.guildId, applicationId: app.id }, 'Updating the application review message failed');
    }
    return app;
  }

  private async dm(userId: string, title: string, description: string, color: number): Promise<void> {
    try {
      const sent = await this.discord.sendDirectMessage(userId, { content: title, embedTitle: title, embedDescription: description, color });
      if (!sent) log.info({ userId }, 'Applicant DMs are closed');
    } catch (err) {
      log.warn({ err, userId }, 'Sending the application DM failed');
    }
  }

  private guildLabel(guildId: string, lang: Language): string {
    try {
      const name = this.guildName(guildId);
      if (name) return name;
    } catch {
      // ignore
    }
    return lang === 'en' ? 'the server' : 'السيرفر';
  }

  private error(guildId: string, key: MsgKey, field?: string): ValidationError {
    let lang: Language = 'ar';
    try {
      lang = this.repos.settings.get(guildId).features.language;
    } catch {
      // keep Arabic
    }
    return new ValidationError(applicationMessages(lang, key), field);
  }
}

/** 'user:<id>' → '<id>'; anything else (system, dashboard user ids) is kept as is. */
function reviewerIdOf(actor: string): string {
  return actor.startsWith('user:') ? actor.slice(5) : actor;
}
