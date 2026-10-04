/**
 * StreamerService — registering streamers and their platform accounts (dashboard + slash commands).
 *
 * Validation errors are Arabic `ValidationError`s with a `field` path the dashboard can highlight
 * (e.g. "discordUserId", "accounts.1.input"). Side effects that talk to Discord (roles) run after the DB
 * transaction committed and never fail the request; the monitor is told about channel changes last.
 */
import type { ProviderRegistryApi, SessionServiceApi, StreamerServiceApi } from '../app/context.js';
import { ChannelNotFoundError, ProviderNotConfiguredError, RateLimitedError, ValidationError } from '../core/errors.js';
import { childLogger } from '../core/logger.js';
import type { ContentKind, Platform, ResolvedChannel } from '../core/types.js';
import { CONTENT_KINDS, isContentKind, isPlatform, PLATFORM_LABELS } from '../core/types.js';
import type { AccountWithChannel, Streamer, StreamerWithAccounts } from '../db/models.js';
import type { Repositories } from '../db/repositories.js';
import type { PlatformProvider } from '../platforms/types.js';
import type { AccountInput, CreateStreamerRequest, UpdateAccountRequest, UpdateStreamerRequest } from '../shared/api.js';
import type { AuditService } from './audit.js';
import type { DiscordGateway, DiscordMemberInfo, MonitorControl, RoleChangeOutcome, RoleManager } from './ports.js';
import { platformListAr } from './views.js';

const log = childLogger('streamers');

export interface StreamerServiceDeps {
  repos: Repositories;
  audit: AuditService;
  providers: ProviderRegistryApi;
  discord: DiscordGateway;
  roles: RoleManager;
  sessions: SessionServiceApi;
  monitor: MonitorControl;
}

const SNOWFLAKE_RE = /^\d{17,20}$/;
/** The monitor's per-channel content baseline record (same format as `seedKey` in src/monitor/monitor.ts). */
const contentSeedKey = (channelId: number): string => `monitor:content-seed:${channelId}`;
export const MAX_ACCOUNTS_PER_STREAMER = 12;
export const MAX_ACCOUNT_INPUT_LENGTH = 300;
const MAX_NAME_LENGTH = 64;
const MAX_NOTES_LENGTH = 500;

/** Environment variables each provider needs (TikTok works without credentials). */
export const PROVIDER_ENV_KEYS: Record<Platform, string[]> = {
  twitch: ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET'],
  kick: ['KICK_CLIENT_ID', 'KICK_CLIENT_SECRET'],
  youtube: ['YOUTUBE_API_KEY'],
  tiktok: [],
};

// Bidi marks, zero-width characters and BOM that sneak in when copying handles from RTL chats.
const INVISIBLE_CHARS_RE = /[­؜᠎​-‏‪-‮⁠-⁩﻿]/g;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g;

/** Cleans admin input for a platform account (invisible characters, whitespace, length). */
export function sanitizeAccountInput(input: unknown, field = 'input'): string {
  if (typeof input !== 'string') throw new ValidationError('اكتب اسم الحساب أو رابطه', field);
  const cleaned = input.normalize('NFKC').replace(INVISIBLE_CHARS_RE, '').replace(CONTROL_CHARS_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) throw new ValidationError('اكتب اسم الحساب أو رابطه', field);
  if (cleaned.length > MAX_ACCOUNT_INPUT_LENGTH) {
    throw new ValidationError(`النص طويل مرة، الحد ${MAX_ACCOUNT_INPUT_LENGTH} حرف`, field);
  }
  return cleaned;
}

interface NormalizedAccountInput {
  platform: Platform;
  input: string;
  notifyLive: boolean;
  notifyContent: boolean;
  contentKinds: ContentKind[] | null;
}

export class StreamerService implements StreamerServiceApi {
  private readonly repos: Repositories;
  private readonly audit: AuditService;
  private readonly providers: ProviderRegistryApi;
  private readonly discord: DiscordGateway;
  private readonly roles: RoleManager;
  private readonly sessions: SessionServiceApi;
  private readonly monitor: MonitorControl;

  constructor(deps: StreamerServiceDeps) {
    this.repos = deps.repos;
    this.audit = deps.audit;
    this.providers = deps.providers;
    this.discord = deps.discord;
    this.roles = deps.roles;
    this.sessions = deps.sessions;
    this.monitor = deps.monitor;
  }

  // ───────────────────────────── queries ─────────────────────────────

  list(guildId: string): StreamerWithAccounts[] {
    return this.repos.streamersWithAccounts(guildId);
  }

  get(guildId: string, streamerId: number): StreamerWithAccounts {
    const streamer = Number.isSafeInteger(streamerId) && streamerId > 0 ? this.repos.streamerWithAccounts(streamerId) : null;
    if (!streamer || streamer.guildId !== guildId) throw new ValidationError('الستريمر غير موجود', 'streamerId');
    return streamer;
  }

  // ───────────────────────────── streamers ─────────────────────────────

  async create(guildId: string, req: CreateStreamerRequest, actor: string): Promise<StreamerWithAccounts> {
    if (!req || typeof req !== 'object') throw new ValidationError('بيانات الطلب ناقصة');
    const userId = typeof req.discordUserId === 'string' ? req.discordUserId.trim() : '';
    if (!SNOWFLAKE_RE.test(userId)) {
      throw new ValidationError('آيدي الديسكورد غير صحيح، لازم يكون رقم من 17 إلى 20 خانة', 'discordUserId');
    }
    if (this.repos.streamers.getByDiscordId(guildId, userId)) {
      throw new ValidationError('هذا العضو مسجّل كستريمر من قبل', 'discordUserId');
    }
    if (!Array.isArray(req.accounts) || req.accounts.length === 0) {
      throw new ValidationError('لازم تضيف حساب واحد على الأقل (تويتش، كيك، يوتيوب أو تيك توك)', 'accounts');
    }
    if (req.accounts.length > MAX_ACCOUNTS_PER_STREAMER) {
      throw new ValidationError(`الحد الأقصى ${MAX_ACCOUNTS_PER_STREAMER} حساب لكل ستريمر`, 'accounts');
    }
    const accounts = req.accounts.map((a, i) => normalizeAccountInput(a, `accounts.${i}`));
    const displayNameInput = req.displayName === undefined || req.displayName === '' ? undefined : validateDisplayName(req.displayName);
    const notes = req.notes === undefined ? null : validateNotes(req.notes);
    const color = req.color === undefined ? null : validateColor(req.color);

    const member = await this.lookupMember(guildId, userId);
    const resolved = await this.resolveAll(accounts);

    const displayName =
      displayNameInput ?? clip(member?.displayName, MAX_NAME_LENGTH) ?? clip(resolved[0]?.channel.displayName, MAX_NAME_LENGTH) ?? userId;

    let streamerId: number;
    try {
      streamerId = this.repos.tx(() => {
        const tracked = this.trackedChannelIds();
        const streamer = this.repos.streamers.create({ guildId, discordUserId: userId, displayName, notes, color });
        for (const { input, channel } of resolved) {
          const stored = this.repos.channels.upsertResolved(channel);
          if (!tracked.has(stored.id)) this.resetContentSeed(stored.id);
          this.repos.accounts.create({
            streamerId: streamer.id,
            channelId: stored.id,
            notifyLive: input.notifyLive,
            notifyContent: input.notifyContent,
            contentKinds: input.contentKinds,
          });
        }
        return streamer.id;
      });
    } catch (err) {
      // Two admins registering the same member at the same time: the UNIQUE constraint decides.
      if (/UNIQUE constraint failed: streamers/i.test(String((err as Error)?.message))) {
        throw new ValidationError('هذا العضو مسجّل كستريمر من قبل', 'discordUserId');
      }
      throw err;
    }

    const result = this.get(guildId, streamerId);
    const settings = this.repos.settings.get(guildId);
    if (settings.options.autoStreamerRole && settings.streamerRoleId) {
      await this.setStreamerRole(guildId, userId, true, 'تسجيل ستريمر جديد');
    }
    this.audit.record({
      guildId,
      actor,
      action: 'streamer.create',
      message: `تمت إضافة الستريمر ${displayName} (${platformListAr(result.accounts.map((a) => a.channel.platform))})`,
      details: {
        streamerId,
        discordUserId: userId,
        memberVerified: member !== null,
        accounts: result.accounts.map((a) => ({ platform: a.channel.platform, handle: a.channel.handle })),
      },
    });
    this.channelsChanged(result.accounts.map((a) => a.channelId));
    return result;
  }

  async update(guildId: string, streamerId: number, patch: UpdateStreamerRequest, actor: string): Promise<StreamerWithAccounts> {
    const current = this.get(guildId, streamerId);
    if (!patch || typeof patch !== 'object') throw new ValidationError('بيانات الطلب ناقصة');
    const changes: Partial<Pick<Streamer, 'displayName' | 'notes' | 'color' | 'enabled'>> = {};
    if (patch.displayName !== undefined) changes.displayName = validateDisplayName(patch.displayName);
    if (patch.notes !== undefined) changes.notes = validateNotes(patch.notes);
    if (patch.color !== undefined) changes.color = validateColor(patch.color);
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new ValidationError('قيمة التفعيل غير صحيحة', 'enabled');
      changes.enabled = patch.enabled;
    }
    const enabling = changes.enabled === true && !current.enabled;
    this.repos.tx(() => {
      const tracked = enabling ? this.trackedChannelIds() : null;
      this.repos.streamers.update(streamerId, changes);
      if (!tracked) return;
      for (const account of this.repos.accounts.listForStreamer(streamerId)) {
        if (!tracked.has(account.channelId)) this.resetContentSeed(account.channelId);
      }
    });

    const settings = this.repos.settings.get(guildId);
    const name = changes.displayName ?? current.displayName;
    let message = `تم تعديل بيانات الستريمر ${name}`;

    if (changes.enabled === false && current.enabled) {
      // The DB flag flips first, so no monitor event can reopen a session while we tear down.
      await this.endSession(streamerId, 'disabled');
      await this.setLiveRole(guildId, current.discordUserId, false, 'تم إيقاف الستريمر');
      if (settings.options.autoStreamerRole && settings.options.removeStreamerRoleOnDelete && settings.streamerRoleId) {
        await this.setStreamerRole(guildId, current.discordUserId, false, 'تم إيقاف الستريمر');
      }
      this.channelsChanged([]);
      message = `تم إيقاف الستريمر ${name}`;
    } else if (enabling) {
      if (settings.options.autoStreamerRole && settings.streamerRoleId) {
        await this.setStreamerRole(guildId, current.discordUserId, true, 'تم تفعيل الستريمر');
      }
      this.channelsChanged(current.accounts.map((a) => a.channelId));
      message = `تم تفعيل الستريمر ${name}`;
    }

    this.audit.record({ guildId, actor, action: 'streamer.update', message, details: { streamerId, changes } });
    return this.get(guildId, streamerId);
  }

  async delete(guildId: string, streamerId: number, actor: string): Promise<void> {
    const current = this.get(guildId, streamerId);
    const settings = this.repos.settings.get(guildId);

    if (current.enabled) this.repos.streamers.update(streamerId, { enabled: false });
    await this.endSession(streamerId, 'deleted');
    const liveRole = await this.setLiveRole(guildId, current.discordUserId, false, 'تم حذف الستريمر');
    if (liveRole === 'transient') {
      // Once deleted, the member is no longer a registered streamer, so role reconciles will not touch them again.
      this.audit.record({
        guildId,
        actor,
        action: 'discord.roles',
        level: 'warn',
        message: `ما قدرنا نشيل رتبة البث المباشر من ${current.displayName} بسبب مشكلة مؤقتة في ديسكورد — إذا بقت عنده شيلها يدوياً`,
        details: { streamerId, discordUserId: current.discordUserId },
      });
    }
    if (settings.options.removeStreamerRoleOnDelete && settings.streamerRoleId) {
      await this.setStreamerRole(guildId, current.discordUserId, false, 'تم حذف الستريمر');
    }

    const orphaned = this.repos.tx(() => {
      this.repos.streamers.delete(streamerId);
      return this.repos.channels.deleteOrphans();
    });
    this.audit.record({
      guildId,
      actor,
      action: 'streamer.delete',
      message: `تم حذف الستريمر ${current.displayName}`,
      details: { streamerId, discordUserId: current.discordUserId, removedChannels: orphaned },
    });
    this.channelsChanged([]);
  }

  // ───────────────────────────── accounts ─────────────────────────────

  async addAccount(guildId: string, streamerId: number, input: AccountInput, actor: string): Promise<StreamerWithAccounts> {
    const streamer = this.get(guildId, streamerId);
    const account = normalizeAccountInput(input, '');
    if (streamer.accounts.length >= MAX_ACCOUNTS_PER_STREAMER) {
      throw new ValidationError(`الحد الأقصى ${MAX_ACCOUNTS_PER_STREAMER} حساب لكل ستريمر`, 'accounts');
    }
    const resolved = await this.resolveForWrite(account.platform, account.input, '');
    const duplicate = streamer.accounts.find((a) => a.channel.platform === resolved.platform && a.channel.platformId === resolved.platformId);
    if (duplicate) {
      throw new ValidationError(`حساب ${PLATFORM_LABELS[resolved.platform]} "${duplicate.channel.handle}" مضاف لهذا الستريمر من قبل`, 'input');
    }

    const created = this.repos.tx(() => {
      const tracked = this.repos.streamers.get(streamerId)?.enabled ? this.trackedChannelIds() : null;
      const channel = this.repos.channels.upsertResolved(resolved);
      if (tracked && !tracked.has(channel.id)) this.resetContentSeed(channel.id);
      return this.repos.accounts.create({
        streamerId,
        channelId: channel.id,
        notifyLive: account.notifyLive,
        notifyContent: account.notifyContent,
        contentKinds: account.contentKinds,
      });
    });
    this.audit.record({
      guildId,
      actor,
      action: 'account.add',
      message: `تمت إضافة حساب ${PLATFORM_LABELS[resolved.platform]} "${resolved.handle}" للستريمر ${streamer.displayName}`,
      details: { streamerId, accountId: created.id, channelId: created.channelId, platform: resolved.platform, platformId: resolved.platformId },
    });
    this.channelsChanged(streamer.enabled ? [created.channelId] : []);
    return this.get(guildId, streamerId);
  }

  async updateAccount(
    guildId: string,
    streamerId: number,
    accountId: number,
    patch: UpdateAccountRequest,
    actor: string,
  ): Promise<StreamerWithAccounts> {
    const streamer = this.get(guildId, streamerId);
    const account = this.ownedAccount(streamer, accountId);
    if (!patch || typeof patch !== 'object') throw new ValidationError('بيانات الطلب ناقصة');

    const changes: UpdateAccountRequest = {};
    if (patch.notifyLive !== undefined) changes.notifyLive = validateBoolean(patch.notifyLive, 'notifyLive');
    if (patch.notifyContent !== undefined) changes.notifyContent = validateBoolean(patch.notifyContent, 'notifyContent');
    if (patch.contentKinds !== undefined) changes.contentKinds = validateContentKinds(patch.contentKinds, 'contentKinds');
    this.repos.accounts.update(accountId, changes);

    this.audit.record({
      guildId,
      actor,
      action: 'account.update',
      message: `تم تعديل إعدادات حساب ${PLATFORM_LABELS[account.channel.platform]} "${account.channel.handle}" للستريمر ${streamer.displayName}`,
      details: { streamerId, accountId, changes },
    });
    // Live-notification changes are applied to a running session on the channel's next live update.
    this.channelsChanged([]);
    return this.get(guildId, streamerId);
  }

  async removeAccount(guildId: string, streamerId: number, accountId: number, actor: string): Promise<StreamerWithAccounts> {
    const streamer = this.get(guildId, streamerId);
    const account = this.ownedAccount(streamer, accountId);

    // If this was the only platform keeping the live session open, end it properly (summary + role).
    // Otherwise the session drops the platform on its next tick.
    const active = this.repos.sessions.getActive(streamerId);
    const open = active ? this.repos.sessions.segments(active.id).filter((s) => !s.endedAt) : [];
    const endsSession = open.length > 0 && open.every((s) => s.channelId === account.channelId);

    // Delete the account before ending the session: a live update queued behind endSession (it holds the
    // streamer lock for seconds: VOD lookup, Discord edit) then finds no account and cannot resume the session.
    // The channel row survives while its segments reference it, so the summary still renders.
    const orphaned = this.repos.tx(() => {
      this.repos.accounts.delete(accountId);
      return this.repos.channels.deleteOrphans();
    });
    if (endsSession) await this.endSession(streamerId, 'account-removed');
    this.audit.record({
      guildId,
      actor,
      action: 'account.remove',
      message: `تم حذف حساب ${PLATFORM_LABELS[account.channel.platform]} "${account.channel.handle}" من الستريمر ${streamer.displayName}`,
      details: { streamerId, accountId, channelId: account.channelId, channelDeleted: orphaned.includes(account.channelId) },
    });
    this.channelsChanged([]);
    return this.get(guildId, streamerId);
  }

  async resolve(platform: Platform, input: string): Promise<ResolvedChannel> {
    const provider = this.providerFor(platform, 'platform');
    const cleaned = sanitizeAccountInput(input, 'input');
    try {
      return checkResolved(platform, await provider.resolveChannel(cleaned));
    } catch (err) {
      if (err instanceof ValidationError || err instanceof ChannelNotFoundError) throw err;
      throw this.providerFailure(platform, err, 'input');
    }
  }

  checkNow(guildId: string, streamerId: number): void {
    const streamer = this.get(guildId, streamerId);
    for (const account of streamer.accounts) {
      try {
        this.monitor.checkNow(account.channelId);
      } catch (err) {
        log.warn({ err, channelId: account.channelId }, 'checkNow failed');
      }
    }
  }

  // ───────────────────────────── helpers ─────────────────────────────

  /** Member checks when the gateway is ready; null = unknown (gateway not ready / lookup failed). */
  private async lookupMember(guildId: string, userId: string): Promise<DiscordMemberInfo | null> {
    if (!this.discord.isReady()) {
      log.warn({ guildId, userId }, 'Discord gateway not ready; registering streamer without member validation');
      return null;
    }
    let member: DiscordMemberInfo | null;
    try {
      member = await this.discord.fetchMember(guildId, userId);
    } catch (err) {
      log.warn({ err, guildId, userId }, 'Member lookup failed; registering streamer without member validation');
      return null;
    }
    if (!member) throw new ValidationError('هذا العضو مو موجود في السيرفر، تأكد من الآيدي', 'discordUserId');
    if (member.bot) throw new ValidationError('ما ينفع تسجّل بوت كستريمر', 'discordUserId');
    return member;
  }

  /** Resolves every account in parallel; reports the first failure in input order (deterministic). */
  private async resolveAll(accounts: NormalizedAccountInput[]): Promise<Array<{ input: NormalizedAccountInput; channel: ResolvedChannel }>> {
    const results = await Promise.allSettled(accounts.map((a, i) => this.resolveForWrite(a.platform, a.input, `accounts.${i}.`)));
    const resolved: Array<{ input: NormalizedAccountInput; channel: ResolvedChannel }> = [];
    const seen = new Map<string, number>();
    for (const [i, result] of results.entries()) {
      if (result.status === 'rejected') throw result.reason;
      const input = accounts[i]!;
      const key = `${result.value.platform}:${result.value.platformId}`;
      if (seen.has(key)) {
        throw new ValidationError(`حساب ${PLATFORM_LABELS[result.value.platform]} "${result.value.handle}" مكرر`, `accounts.${i}.input`);
      }
      seen.set(key, i);
      resolved.push({ input, channel: result.value });
    }
    return resolved;
  }

  /** Resolve for create/add: every failure becomes a ValidationError pointing at the right field. */
  private async resolveForWrite(platform: Platform, input: string, fieldPrefix: string): Promise<ResolvedChannel> {
    const provider = this.providerFor(platform, `${fieldPrefix}platform`);
    try {
      return checkResolved(platform, await provider.resolveChannel(input));
    } catch (err) {
      if (err instanceof ValidationError) throw new ValidationError(err.message, `${fieldPrefix}input`);
      if (err instanceof ChannelNotFoundError) {
        throw new ValidationError(`ما لقيت حساب ${PLATFORM_LABELS[platform]} بهذا الاسم: ${clip(input, 80)}`, `${fieldPrefix}input`);
      }
      throw this.providerFailure(platform, err, `${fieldPrefix}input`);
    }
  }

  private providerFor(platform: Platform, field: string): PlatformProvider {
    if (!isPlatform(platform)) throw new ValidationError('المنصة غير معروفة', field);
    let provider: PlatformProvider;
    try {
      provider = this.providers.get(platform);
    } catch {
      throw new ValidationError('المنصة غير مدعومة', field);
    }
    if (!provider.isConfigured()) throw notConfiguredError(platform, field);
    return provider;
  }

  private providerFailure(platform: Platform, err: unknown, field: string): ValidationError {
    const label = PLATFORM_LABELS[platform];
    if (err instanceof ProviderNotConfiguredError) {
      const keys = PROVIDER_ENV_KEYS[platform].join(' و ');
      return new ValidationError(`مفاتيح ${label} مرفوضة أو ناقصة — راجع ${keys} في ملف الإعدادات (.env)`, field);
    }
    if (err instanceof RateLimitedError) {
      return new ValidationError(`${label} طالبة نهدّي شوي، جرّب بعد ${Math.max(1, Math.ceil(err.retryAfterMs / 1000))} ثانية`, field);
    }
    log.warn({ err, platform }, 'Resolving account failed');
    return new ValidationError(`ما قدرنا نتحقق من حساب ${label} الحين، جرّب بعد شوي`, field);
  }

  private ownedAccount(streamer: StreamerWithAccounts, accountId: number): AccountWithChannel {
    const account = streamer.accounts.find((a) => a.id === accountId);
    if (!account) throw new ValidationError('الحساب غير موجود', 'accountId');
    return account;
  }

  private async endSession(streamerId: number, reason: string): Promise<void> {
    try {
      await this.sessions.endStreamerSession(streamerId, reason);
    } catch (err) {
      log.error({ err, streamerId, reason }, 'Ending live session failed');
    }
  }

  private async setLiveRole(guildId: string, userId: string, live: boolean, reason: string): Promise<RoleChangeOutcome> {
    try {
      return await this.roles.setLive(guildId, userId, live, reason);
    } catch (err) {
      log.warn({ err, guildId, userId }, 'Updating live role failed');
      return 'transient';
    }
  }

  private async setStreamerRole(guildId: string, userId: string, isStreamer: boolean, reason: string): Promise<void> {
    try {
      await this.roles.setStreamer(guildId, userId, isStreamer, reason);
    } catch (err) {
      log.warn({ err, guildId, userId }, 'Updating streamer role failed');
    }
  }

  /** Ids of the channels at least one enabled streamer tracks (read inside the write tx, before linking). */
  private trackedChannelIds(): Set<number> {
    return new Set(this.repos.channels.listTracked().map((c) => c.id));
  }

  /**
   * A channel that becomes tracked again (kept in the DB for session history, or its streamer re-enabled) must be
   * baselined silently again; otherwise uploads published while nobody tracked it are announced as new.
   */
  private resetContentSeed(channelId: number): void {
    this.repos.channels.resetContentSeed(channelId);
    this.repos.kv.delete(contentSeedKey(channelId));
  }

  /** Tells the monitor the tracked set changed, then asks for immediate checks of the given channels. */
  private channelsChanged(checkChannelIds: number[]): void {
    try {
      this.monitor.channelsChanged();
      for (const id of new Set(checkChannelIds)) this.monitor.checkNow(id);
    } catch (err) {
      log.warn({ err }, 'Notifying monitor failed');
    }
  }
}

// ───────────────────────────── validation ─────────────────────────────

function notConfiguredError(platform: Platform, field: string): ValidationError {
  const keys = PROVIDER_ENV_KEYS[platform];
  const label = PLATFORM_LABELS[platform];
  const needs = keys.length > 0 ? `لازم تضيف ${keys.join(' و ')} في ملف الإعدادات (.env) وتعيد تشغيل البوت` : 'راجع إعدادات البوت';
  return new ValidationError(`منصة ${label} مو مفعّلة في البوت: ${needs}`, field);
}

function checkResolved(platform: Platform, resolved: ResolvedChannel): ResolvedChannel {
  if (!resolved || resolved.platform !== platform || !resolved.platformId) {
    throw new Error(`Provider ${platform} returned an invalid channel`);
  }
  return resolved;
}

function normalizeAccountInput(raw: AccountInput, path: string): NormalizedAccountInput {
  const field = (name: string) => (path ? `${path}.${name}` : name);
  if (!raw || typeof raw !== 'object') throw new ValidationError('بيانات الحساب ناقصة', path || 'input');
  if (!isPlatform(raw.platform)) throw new ValidationError('اختر المنصة (تويتش، كيك، يوتيوب أو تيك توك)', field('platform'));
  return {
    platform: raw.platform,
    input: sanitizeAccountInput(raw.input, field('input')),
    notifyLive: raw.notifyLive === undefined ? true : validateBoolean(raw.notifyLive, field('notifyLive')),
    notifyContent: raw.notifyContent === undefined ? true : validateBoolean(raw.notifyContent, field('notifyContent')),
    contentKinds: raw.contentKinds === undefined ? null : validateContentKinds(raw.contentKinds, field('contentKinds')),
  };
}

function validateBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError('القيمة لازم تكون صح أو خطأ', field);
  return value;
}

/** null = inherit the guild setting; arrays are de-duplicated into canonical order. */
function validateContentKinds(value: unknown, field: string): ContentKind[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || !value.every(isContentKind)) throw new ValidationError('نوع محتوى غير معروف', field);
  return CONTENT_KINDS.filter((k) => value.includes(k));
}

function validateDisplayName(value: unknown): string {
  const name = typeof value === 'string' ? value.replace(INVISIBLE_CHARS_RE, '').replace(/\s+/g, ' ').trim() : '';
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
    throw new ValidationError(`الاسم لازم يكون بين 1 و ${MAX_NAME_LENGTH} حرف`, 'displayName');
  }
  return name;
}

function validateNotes(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new ValidationError('الملاحظات لازم تكون نص', 'notes');
  const notes = value.trim();
  if (notes.length > MAX_NOTES_LENGTH) throw new ValidationError(`الملاحظات طويلة، الحد ${MAX_NOTES_LENGTH} حرف`, 'notes');
  return notes || null;
}

function validateColor(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffff) {
    throw new ValidationError('اللون غير صحيح', 'color');
  }
  return value;
}

function clip(value: string | null | undefined, max: number): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

