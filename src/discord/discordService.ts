/**
 * DiscordService — the bot's Discord layer (DiscordApi): gateway lifecycle, notifications, roles,
 * dashboard lookups/diagnostics, previews and slash commands.
 *
 * Gateway intents: Guilds + GuildMembers. GuildMembers is PRIVILEGED: enable "SERVER MEMBERS INTENT" in
 * the Discord Developer Portal (Bot → Privileged Gateway Intents) or login fails with a clear error. It is
 * needed to list members for role reconciliation and to restore roles when a streamer rejoins the server.
 *
 * Composition: DiscordTransport (send/edit I/O) → DiscordNotifier (notification policy), DiscordRoles
 * (role changes, serialized per guild), DiscordLookups (read-only lookups + diagnostics) and the slash
 * command dispatcher. Every piece reads the current client through `getClient`, so nothing holds a stale
 * reference across restarts.
 */
import {
  type ApplicationCommand,
  Client,
  type DMChannel,
  Events,
  GatewayIntentBits,
  type Guild,
  type GuildMember,
  type Interaction,
  type NonThreadGuildBasedChannel,
  Options,
  type Role,
} from 'discord.js';
import type { AppConfig } from '../config.js';
import type { DiscordApi, SessionServiceApi, StreamerServiceApi } from '../app/context.js';
import { ValidationError } from '../core/errors.js';
import type { AppEvents } from '../core/events.js';
import { childLogger } from '../core/logger.js';
import type { AuditLevel, GuildSettings, TemplateSpec } from '../db/models.js';
import type { Repositories } from '../db/repositories.js';
import type { AuditService } from '../services/audit.js';
import type {
  ContentView,
  DiscordChannelInfo,
  DiscordGuildInfo,
  DiscordMemberInfo,
  DiscordRoleInfo,
  EditOutcome,
  GuildDiagnostics,
  LiveView,
  MessageRef,
  RoleChangeOutcome,
  SummaryOutcome,
  SummaryView,
} from '../services/ports.js';
import type { MessagePreview } from '../shared/api.js';
import { describeDiscordError } from './apiErrors.js';
import { type CommandEnv, type CommandServices, commandDefinitions, dispatchCommand } from './commands/index.js';
import { DEFAULT_PLATFORM_EMOJIS, hasCustomEmojis, type PlatformEmojis, resolvePlatformEmojis } from './emojis.js';
import { DiscordLookups } from './gateway.js';
import { buildPing } from './mentions.js';
import { applyPing, buildMessage, toPreview } from './messages.js';
import { asTestMessage, DiscordNotifier, failureMessageAr } from './notifier.js';
import { buildInviteUrl } from './permissions.js';
import { DiscordRoles } from './roles.js';
import { SAMPLE_AVATAR, type SampleIdentity, sampleView } from './samples.js';
import type { TemplateType } from './templates.js';
import { DiscordTransport } from './transport.js';
import { TimeoutError, WarnThrottle, withTimeout } from './util.js';

const log = childLogger('discord');

export interface DiscordServiceDeps {
  config: AppConfig;
  repos: Repositories;
  audit: AuditService;
  events: AppEvents;
}

export interface DiscordServiceOptions {
  /** How long start() waits for the gateway READY event. */
  readyTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const SHUTDOWN_FLUSH_MS = 3_000;
const MEMBER_WARMUP_RETRY_MS = 10 * 60_000;
/** Shard resume/ready events arriving close together trigger one recovery pass. */
const GATEWAY_RECOVERY_DEBOUNCE_MS = 5_000;

/** Turns gateway login failures into actionable operator messages (logs are English). */
/** Startup failure; `permanent` errors (bad token, missing intent) won't fix themselves by retrying. */
export class DiscordStartupError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DiscordStartupError';
  }
}

export function startupError(err: unknown, timeoutMs: number): DiscordStartupError {
  const code = (err as { code?: unknown })?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof TimeoutError) {
    return new DiscordStartupError(`Discord did not become ready within ${Math.round(timeoutMs / 1000)}s (network problem or Discord outage?)`, false, {
      cause: err,
    });
  }
  if (code === 'TokenInvalid' || code === 'TokenMissing' || /invalid token|401/i.test(message)) {
    return new DiscordStartupError('DISCORD_TOKEN is invalid. Copy the bot token again from Discord Developer Portal → Bot → Reset Token.', true, { cause: err });
  }
  if (code === 'DisallowedIntents' || code === 4014 || /disallowed intent|privileged intent/i.test(message)) {
    return new DiscordStartupError(
      'The privileged "Server Members Intent" is not enabled. Enable it in Discord Developer Portal → Bot → Privileged Gateway Intents → SERVER MEMBERS INTENT, then restart the bot.',
      true,
      { cause: err },
    );
  }
  return new DiscordStartupError(`Discord login failed: ${message}`, false, { cause: err });
}

export class DiscordService implements DiscordApi {
  private readonly config: AppConfig;
  private readonly repos: Repositories;
  private readonly audit: AuditService;
  private readonly readyTimeoutMs: number;

  private client: Client | null = null;
  private starting: Promise<void> | null = null;
  private emojis: PlatformEmojis = DEFAULT_PLATFORM_EMOJIS;
  private commandEnv: CommandEnv | null = null;
  private readonly membersIntent = new Map<string, boolean>();
  private readonly memberWarmups = new Map<string, number>();
  private readonly startedAt = Date.now();
  private readonly throttle = new WarnThrottle();
  private readonly recoveryListeners: Array<() => void> = [];
  private recoveryTimer: NodeJS.Timeout | null = null;
  /** Set once the first READY of the current client arrived (later shard READY events are reconnects). */
  private initialReady = false;

  private readonly notifier: DiscordNotifier;
  private readonly roleManager: DiscordRoles;
  private readonly lookups: DiscordLookups;

  constructor(deps: DiscordServiceDeps, options: DiscordServiceOptions = {}) {
    this.config = deps.config;
    this.repos = deps.repos;
    this.audit = deps.audit;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

    const getClient = () => this.client;
    this.lookups = new DiscordLookups({ getClient, membersIntentOk: (guildId) => this.membersIntent.get(guildId) ?? null });
    this.notifier = new DiscordNotifier({
      transport: new DiscordTransport(getClient),
      repos: this.repos,
      audit: this.audit,
      emojis: () => this.emojis,
      onCustomEmojisRejected: () => {
        if (hasCustomEmojis(this.emojis)) log.warn('Custom platform emojis were rejected by Discord; using unicode emojis from now on');
        this.emojis = DEFAULT_PLATFORM_EMOJIS;
      },
      avatarFor: (guildId, userId) => this.avatarFor(guildId, userId),
      warnThrottle: this.throttle,
    });
    this.roleManager = new DiscordRoles({
      getClient,
      repos: this.repos,
      audit: this.audit,
      warnThrottle: this.throttle,
      onMembersFetch: (guildId, ok) => this.membersIntent.set(guildId, ok),
    });
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  start(): Promise<void> {
    if (this.client?.isReady()) return Promise.resolve();
    this.starting ??= this.connect().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    await withTimeout(this.notifier.close(), SHUTDOWN_FLUSH_MS, 'log flush timed out').catch(() => {});
    const client = this.client;
    this.client = null;
    if (client) {
      await client.destroy().catch((err) => log.warn({ err }, 'Destroying Discord client failed'));
      log.info('Discord client stopped');
    }
  }

  attachServices(services: { streamers: StreamerServiceApi; sessions: SessionServiceApi; repos: Repositories; audit: AuditService }): void {
    const commandServices: CommandServices = services;
    this.commandEnv = {
      services: commandServices,
      gateway: this.lookups,
      sendTest: (guildId, type) => this.sendTest(guildId, type),
      messageUrl: (guildId, ref) => this.messageUrl(guildId, ref),
      emojis: () => this.emojis,
      wsPing: () => this.client?.ws.ping ?? -1,
      startedAt: this.startedAt,
      clock: Date.now,
    };
  }

  /**
   * Registers a callback for when the gateway comes back after a disconnect (shard resumed or re-identified).
   * Role changes may have failed while it was away, so the wiring reconciles live roles from here.
   */
  onGatewayRecovered(listener: () => void): void {
    this.recoveryListeners.push(listener);
  }

  private gatewayRecovered(shardId: number, how: 'resume' | 'ready'): void {
    if (!this.initialReady) return;
    log.info({ shardId, how }, 'Discord gateway recovered');
    if (this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      for (const listener of this.recoveryListeners) {
        try {
          listener();
        } catch (err) {
          log.warn({ err }, 'Gateway recovery listener failed');
        }
      }
    }, GATEWAY_RECOVERY_DEBOUNCE_MS);
    this.recoveryTimer.unref();
  }

  private async connect(): Promise<void> {
    const client = this.createClient();
    this.client = client;
    this.initialReady = false;
    const ready = new Promise<void>((resolve) =>
      client.once(Events.ClientReady, () => {
        this.initialReady = true;
        resolve();
      }),
    );
    try {
      await withTimeout(Promise.all([client.login(this.config.DISCORD_TOKEN), ready]), this.readyTimeoutMs, 'Discord READY timeout');
    } catch (err) {
      this.client = null;
      await client.destroy().catch(() => {});
      throw startupError(err, this.readyTimeoutMs);
    }
    log.info({ user: client.user?.tag, guilds: client.guilds.cache.size }, 'Discord client ready');
    await Promise.allSettled([this.loadApplicationEmojis(client), this.registerCommands(client)]);
  }

  private createClient(): Client {
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
      // Safety net: anything sent without explicit allowedMentions pings nobody.
      allowedMentions: { parse: [], repliedUser: false },
      makeCache: Options.cacheWithLimits({
        ...Options.DefaultMakeCacheSettings,
        // Messages are edited by id; caching them would only cost memory.
        MessageManager: 0,
        GuildMessageManager: 0,
        DMMessageManager: 0,
        ReactionManager: 0,
        ReactionUserManager: 0,
        PresenceManager: 0,
        VoiceStateManager: 0,
        StageInstanceManager: 0,
        GuildStickerManager: 0,
        GuildScheduledEventManager: 0,
        GuildInviteManager: 0,
        GuildBanManager: 0,
        AutoModerationRuleManager: 0,
        ThreadMemberManager: 0,
      }),
      rest: { invalidRequestWarningInterval: 250 },
    });

    client.on(Events.InteractionCreate, (interaction) => void this.onInteraction(interaction));
    client.on(Events.GuildCreate, (guild) => void this.onGuildJoin(guild));
    client.on(Events.GuildDelete, (guild) => this.onGuildLeave(guild));
    client.on(Events.GuildMemberAdd, (member) => void this.onMemberJoin(member));
    client.on(Events.GuildRoleDelete, (role) => this.onRoleDelete(role));
    client.on(Events.ChannelDelete, (channel) => this.onChannelDelete(channel));
    client.on(Events.Error, (err) => log.error({ err }, 'Discord client error'));
    client.on(Events.Warn, (message) => log.warn(message));
    client.on(Events.ShardDisconnect, (event, shardId) => log.warn({ shardId, code: event.code }, 'Discord gateway disconnected'));
    client.on(Events.ShardReconnecting, (shardId) => log.info({ shardId }, 'Discord gateway reconnecting'));
    client.on(Events.ShardResume, (shardId, replayed) => {
      log.info({ shardId, replayed }, 'Discord gateway resumed');
      this.gatewayRecovered(shardId, 'resume');
    });
    client.on(Events.ShardReady, (shardId) => this.gatewayRecovered(shardId, 'ready'));
    client.on(Events.ShardError, (err, shardId) => log.warn({ err, shardId }, 'Discord gateway error'));
    client.rest.on('invalidRequestWarning', (info) =>
      log.warn({ count: info.count, remainingMs: info.remainingTime }, 'Many invalid Discord requests (403/401/429); check permissions to avoid a temporary ban'),
    );
    client.rest.on('rateLimited', (info) => log.debug({ route: info.route, retryAfter: info.retryAfter, global: info.global }, 'Discord rate limit hit'));
    return client;
  }

  /** Guild-scoped when DISCORD_GUILD_ID is set (instant updates), otherwise global. */
  private async registerCommands(client: Client): Promise<void> {
    const application = client.application;
    if (!application) return;
    const definitions = commandDefinitions();
    const guildId = this.config.DISCORD_GUILD_ID;
    try {
      if (!guildId) {
        await application.commands.set(definitions);
        log.info({ count: definitions.length }, 'Registered global slash commands (may take a while to appear)');
        return;
      }
      if (client.guilds.cache.has(guildId)) {
        await application.commands.set(definitions, guildId);
        log.info({ guildId, count: definitions.length }, 'Registered guild slash commands');
      } else {
        log.warn({ guildId }, 'Bot is not in DISCORD_GUILD_ID yet; slash commands will be registered when it joins');
      }
      // A previous global registration would show every command twice in this guild.
      const names = new Set(definitions.map((d) => d.name));
      const globals = await application.commands.fetch();
      const duplicates = [...globals.values()].filter((cmd: ApplicationCommand) => names.has(cmd.name));
      for (const cmd of duplicates) await application.commands.delete(cmd.id);
      if (duplicates.length > 0) log.info({ removed: duplicates.length }, 'Removed duplicate global slash commands');
    } catch (err) {
      log.error({ err: describeDiscordError(err) }, 'Registering slash commands failed');
    }
  }

  private async loadApplicationEmojis(client: Client): Promise<void> {
    try {
      const emojis = await client.application?.emojis.fetch();
      if (!emojis) return;
      this.emojis = resolvePlatformEmojis([...emojis.values()].map((e) => ({ id: e.id, name: e.name, animated: e.animated })));
      if (hasCustomEmojis(this.emojis)) log.info('Using custom application emojis for platforms');
    } catch (err) {
      log.debug({ err: describeDiscordError(err) }, 'Could not load application emojis; using unicode');
    }
  }

  // ───────────────────────────── gateway events ─────────────────────────────

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;
    try {
      await dispatchCommand(interaction, this.commandEnv);
    } catch (err) {
      log.error({ err, command: interaction.commandName }, 'Interaction handling failed');
    }
  }

  private async onGuildJoin(guild: Guild): Promise<void> {
    try {
      this.repos.settings.get(guild.id);
      this.audit.record({ guildId: guild.id, action: 'discord.guild.join', message: `البوت انضم للسيرفر ${guild.name}`, mirror: false });
      const client = this.client;
      if (client && guild.id === this.config.DISCORD_GUILD_ID) await this.registerCommands(client);
    } catch (err) {
      log.warn({ err, guildId: guild.id }, 'Handling guild join failed');
    }
  }

  private onGuildLeave(guild: Guild): void {
    // An unavailable guild is a Discord outage, not a kick.
    if (!guild.available) return;
    this.audit.record({ guildId: guild.id, action: 'discord.guild.leave', level: 'warn', message: `البوت طلع أو انطرد من السيرفر ${guild.name}`, mirror: false });
  }

  /** A registered streamer who rejoins the server gets their roles back right away. */
  private async onMemberJoin(member: GuildMember): Promise<void> {
    try {
      if (member.user.bot) return;
      const guildId = member.guild.id;
      const streamer = this.repos.streamers.getByDiscordId(guildId, member.id);
      if (!streamer?.enabled) return;
      const settings = this.repos.settings.get(guildId);
      if (settings.options.autoStreamerRole && settings.streamerRoleId) await this.setStreamer(guildId, member.id, true, 'رجع للسيرفر');
      if (this.repos.sessions.getActive(streamer.id)) await this.setLive(guildId, member.id, true, 'رجع للسيرفر وهو يبث');
    } catch (err) {
      log.warn({ err, guildId: member.guild.id, userId: member.id }, 'Restoring roles for returning member failed');
    }
  }

  private onRoleDelete(role: Role): void {
    try {
      const settings = this.repos.settings.get(role.guild.id);
      const uses = [
        settings.streamerRoleId === role.id ? 'Streamer' : null,
        settings.liveRoleId === role.id ? 'Streaming Now' : null,
        settings.pingRoleId === role.id && settings.pingMode === 'role' ? 'المنشن' : null,
      ].filter((u): u is string => u !== null);
      if (uses.length === 0) return;
      this.audit.record({
        guildId: role.guild.id,
        action: 'discord.role.deleted',
        level: 'warn',
        message: `رتبة ${uses.join(' و ')} (${role.name}) انحذفت من السيرفر — حدد رتبة جديدة من الإعدادات`,
        details: { roleId: role.id },
      });
    } catch (err) {
      log.warn({ err }, 'Handling role delete failed');
    }
  }

  private onChannelDelete(channel: DMChannel | NonThreadGuildBasedChannel): void {
    try {
      if (channel.isDMBased()) return;
      const settings = this.repos.settings.get(channel.guildId);
      const uses = [
        settings.liveChannelId === channel.id ? 'إشعارات البث' : null,
        settings.contentChannelId === channel.id ? 'إشعارات المقاطع' : null,
        settings.logChannelId === channel.id ? 'اللوق' : null,
      ].filter((u): u is string => u !== null);
      if (uses.length === 0) return;
      this.audit.record({
        guildId: channel.guildId,
        action: 'discord.channel.deleted',
        level: 'warn',
        message: `روم ${uses.join(' و ')} (#${channel.name}) انحذف — حدد روم جديد من الإعدادات`,
        details: { channelId: channel.id },
        mirror: settings.logChannelId !== channel.id,
      });
    } catch (err) {
      log.warn({ err }, 'Handling channel delete failed');
    }
  }

  // ───────────────────────────── DiscordGateway ─────────────────────────────

  isReady(): boolean {
    return this.lookups.isReady();
  }

  botUser(): { id: string; username: string; avatarUrl: string | null } | null {
    return this.lookups.botUser();
  }

  guilds(): DiscordGuildInfo[] {
    return this.lookups.guilds();
  }

  guild(guildId: string): DiscordGuildInfo | null {
    return this.lookups.guild(guildId);
  }

  fetchMember(guildId: string, userId: string): Promise<DiscordMemberInfo | null> {
    return this.lookups.fetchMember(guildId, userId);
  }

  roles(guildId: string): Promise<DiscordRoleInfo[]> {
    return this.lookups.roles(guildId);
  }

  textChannels(guildId: string): Promise<DiscordChannelInfo[]> {
    return this.lookups.textChannels(guildId);
  }

  diagnose(guildId: string, settings: GuildSettings): Promise<GuildDiagnostics> {
    return this.lookups.diagnose(guildId, settings);
  }

  // ───────────────────────────── Notifier ─────────────────────────────

  postLive(view: LiveView): Promise<MessageRef | null> {
    return this.notifier.postLive(view);
  }

  updateLive(ref: MessageRef, view: LiveView): Promise<EditOutcome> {
    return this.notifier.updateLive(ref, view);
  }

  postSummary(ref: MessageRef | null, view: SummaryView): Promise<SummaryOutcome> {
    return this.notifier.postSummary(ref, view);
  }

  postContent(view: ContentView): Promise<MessageRef | null> {
    return this.notifier.postContent(view);
  }

  log(guildId: string, level: AuditLevel, message: string): Promise<void> {
    return this.notifier.log(guildId, level, message);
  }

  // ───────────────────────────── RoleManager ─────────────────────────────

  setLive(guildId: string, userId: string, live: boolean, reason: string): Promise<RoleChangeOutcome> {
    return this.roleManager.setLive(guildId, userId, live, reason);
  }

  setStreamer(guildId: string, userId: string, isStreamer: boolean, reason: string): Promise<RoleChangeOutcome> {
    return this.roleManager.setStreamer(guildId, userId, isStreamer, reason);
  }

  removeRoleFrom(guildId: string, roleId: string, userIds: string[], reason: string): Promise<void> {
    return this.roleManager.removeRoleFrom(guildId, roleId, userIds, reason);
  }

  reconcile(guildId: string, liveUserIds: Set<string>, streamerUserIds: Set<string>): Promise<{ added: number; removed: number }> {
    return this.roleManager.reconcile(guildId, liveUserIds, streamerUserIds);
  }

  // ───────────────────────────── previews & tools ─────────────────────────────

  async preview(guildId: string, type: TemplateType, template?: TemplateSpec): Promise<MessagePreview> {
    const settings = this.repos.settings.get(guildId);
    const now = Date.now();
    const identity = this.sampleIdentity();
    // Unicode emojis: the dashboard renders text, it cannot show custom emoji markup.
    const message = buildMessage(type, sampleView(type, settings, now, identity), {
      emojis: DEFAULT_PLATFORM_EMOJIS,
      avatarUrl: identity.avatarUrl,
      template,
      now,
    });
    return toPreview(type === 'summary' ? message : applyPing(message, buildPing(settings)));
  }

  async sendTest(guildId: string, type: TemplateType): Promise<MessageRef | null> {
    const settings = this.repos.settings.get(guildId);
    const channelId = type === 'content' ? settings.contentChannelId : settings.liveChannelId;
    if (!channelId) {
      throw new ValidationError(type === 'content' ? 'حدد روم إشعارات المقاطع أول من الإعدادات' : 'حدد روم إشعارات البث أول من الإعدادات', type === 'content' ? 'contentChannelId' : 'liveChannelId');
    }
    if (!this.isReady()) throw new ValidationError('البوت غير متصل بديسكورد حالياً، جرّب بعد شوي');

    const now = Date.now();
    const identity = this.sampleIdentity();
    const view = sampleView(type, settings, now, identity);
    const purpose = type === 'content' ? 'content' : 'live';
    const result = await this.notifier.send(guildId, channelId, purpose, (emojis) =>
      asTestMessage(buildMessage(type, view, { emojis, avatarUrl: identity.avatarUrl, now })),
    );
    if (!result.ok) {
      throw new ValidationError(failureMessageAr(result, purpose, channelId) ?? 'ما قدرت أرسل الرسالة التجريبية، جرّب بعد شوي');
    }
    // Callers audit with their own actor (dashboard route, /bot test).
    return result.ref;
  }

  messageUrl(guildId: string, ref: MessageRef): string {
    return `https://discord.com/channels/${guildId}/${ref.channelId}/${ref.messageId}`;
  }

  inviteUrl(): string {
    return buildInviteUrl(this.config.DISCORD_CLIENT_ID);
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private sampleIdentity(): SampleIdentity {
    const bot = this.botUser();
    return { displayName: 'ستريمر تجريبي', discordUserId: bot?.id ?? '', avatarUrl: SAMPLE_AVATAR };
  }

  /** Cached Discord avatar; a cache miss warms the member in the background for the next edit. */
  private avatarFor(guildId: string, userId: string): string | null {
    const url = this.lookups.avatarFor(guildId, userId);
    if (url || !this.isReady()) return url;
    const key = `${guildId}:${userId}`;
    const now = Date.now();
    const last = this.memberWarmups.get(key);
    if (last === undefined || now - last > MEMBER_WARMUP_RETRY_MS) {
      this.memberWarmups.set(key, now);
      if (this.memberWarmups.size > 5_000) this.memberWarmups.clear();
      void this.lookups.fetchMember(guildId, userId).catch(() => null);
    }
    return null;
  }
}
