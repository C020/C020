/**
 * DiscordService — the bot's Discord layer (DiscordApi): gateway lifecycle, notifications, roles,
 * dashboard lookups/diagnostics, previews, slash commands, buttons/modals and the v2 Discord actions.
 *
 * Gateway intents: Guilds + GuildMembers, plus GuildPresences when DISCORD_PRESENCE_INTENT=true (#15).
 * GuildMembers and GuildPresences are PRIVILEGED: enable "SERVER MEMBERS INTENT" (and "PRESENCE INTENT" for #15)
 * in the Discord Developer Portal (Bot → Privileged Gateway Intents) or login fails with a clear error. Members are
 * needed to list members for role reconciliation and to restore roles when a streamer rejoins the server.
 *
 * Composition: DiscordTransport (send/edit I/O) → DiscordNotifier (notification policy), DiscordRoles
 * (role changes, serialized per guild), DiscordLookups (read-only lookups + diagnostics), PanelPublisher
 * (interactive panels), DiscordActionsImpl (renames, DMs, review messages, presences) and the slash command /
 * component dispatchers. Every piece reads the current client through `getClient`, so nothing holds a stale
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
import type { DiscordApi, DiscordServices, StreamingActivity } from '../app/context.js';
import type { AppConfig } from '../config.js';
import { ValidationError } from '../core/errors.js';
import type { AppEvents } from '../core/events.js';
import { childLogger } from '../core/logger.js';
import type { AuditLevel, GuildSettings, PanelKind, Streamer, StreamerApplication, TemplateSpec } from '../db/models.js';
import type { Repositories } from '../db/repositories.js';
import type { AuditService } from '../services/audit.js';
import type {
  ContentView,
  DigestView,
  DiscordChannelInfo,
  DiscordGuildInfo,
  DiscordMemberInfo,
  DiscordRoleInfo,
  EditOutcome,
  GuildDiagnostics,
  LiveView,
  MessageRef,
  PresenceLiveView,
  RenameOutcome,
  RoleChangeOutcome,
  SummaryOutcome,
  SummaryView,
} from '../services/ports.js';
import { allNotificationChannelIds, resolveContentChannelId, resolveLiveChannelId } from '../services/routing.js';
import type { MessagePreview } from '../shared/api.js';
import { describeDiscordError, shouldRejectRateLimit } from './apiErrors.js';
import { type CommandEnv, commandDefinitions, dispatchCommand } from './commands/index.js';
import { DEFAULT_PLATFORM_EMOJIS, hasCustomEmojis, type PlatformEmojis, resolvePlatformEmojis } from './emojis.js';
import { DiscordLookups } from './gateway.js';
import { guildLanguage, ti } from './i18n/interactions.js';
import { DiscordActionsImpl } from './interactions/actions.js';
import { dispatchComponent, isOwnComponent } from './interactions/dispatch.js';
import { DiscordInteractiveMessenger } from './interactions/messenger.js';
import { PanelPublisher } from './interactions/panels.js';
import { PresenceTracker } from './interactions/presence.js';
import type { ComponentInteraction, InteractionEnv } from './interactions/types.js';
import { buildMessage, buildPreviewMessage } from './messages.js';
import { asTestMessage, DiscordNotifier, failureMessage } from './notifier.js';
import { buildInviteUrl } from './permissions.js';
import { DiscordRoles } from './roles.js';
import { sampleIdentityFor, sampleView } from './samples.js';
import type { TemplateType } from './templates.js';
import { DiscordTransport } from './transport.js';
import { KeyedQueue, TimeoutError, WarnThrottle, withTimeout } from './util.js';

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

/** Turns gateway login failures into actionable operator messages (logs are English). */
export function startupError(err: unknown, timeoutMs: number, presenceIntent = false): DiscordStartupError {
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
    const intents = presenceIntent ? 'SERVER MEMBERS INTENT and PRESENCE INTENT' : 'SERVER MEMBERS INTENT';
    const hint = presenceIntent ? ' (or set DISCORD_PRESENCE_INTENT=false to run without Discord streaming detection)' : '';
    return new DiscordStartupError(
      `A privileged gateway intent is not enabled. Enable ${intents} in Discord Developer Portal → Bot → Privileged Gateway Intents, then restart the bot${hint}.`,
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
  /** #15 — log in with the privileged GuildPresences intent. */
  private readonly presenceIntent: boolean;

  private client: Client | null = null;
  private starting: Promise<void> | null = null;
  private emojis: PlatformEmojis = DEFAULT_PLATFORM_EMOJIS;
  private services: DiscordServices | null = null;
  private commandEnv: CommandEnv | null = null;
  private interactionEnv: InteractionEnv | null = null;
  private readonly membersIntent = new Map<string, boolean>();
  private readonly memberWarmups = new Map<string, number>();
  private readonly startedAt = Date.now();
  private readonly throttle = new WarnThrottle();
  private readonly recoveryListeners: Array<() => void> = [];
  private recoveryTimer: NodeJS.Timeout | null = null;
  /** Set once the first READY of the current client arrived (later shard READY events are reconnects). */
  private initialReady = false;
  /** Presence changes are forwarded in order per member. */
  private readonly presenceQueue = new KeyedQueue();

  private readonly notifier: DiscordNotifier;
  private readonly roleManager: DiscordRoles;
  private readonly lookups: DiscordLookups;
  private readonly presences = new PresenceTracker();
  private readonly actions: DiscordActionsImpl;
  private readonly panels: PanelPublisher;

  constructor(deps: DiscordServiceDeps, options: DiscordServiceOptions = {}) {
    this.config = deps.config;
    this.repos = deps.repos;
    this.audit = deps.audit;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.presenceIntent = deps.config.DISCORD_PRESENCE_INTENT === true;

    const getClient = () => this.client;
    this.lookups = new DiscordLookups({
      getClient,
      membersIntentOk: (guildId) => this.membersIntent.get(guildId) ?? null,
      presenceIntent: () => this.presenceIntent,
    });
    const transport = new DiscordTransport(getClient);
    this.notifier = new DiscordNotifier({
      transport,
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
    const messenger = new DiscordInteractiveMessenger(getClient, transport);
    this.actions = new DiscordActionsImpl({
      getClient,
      repos: this.repos,
      audit: this.audit,
      messenger,
      presences: this.presences,
      presenceIntent: () => this.presenceIntent,
      emojis: () => this.emojis,
      warnThrottle: this.throttle,
    });
    this.panels = new PanelPublisher({
      repos: this.repos,
      messenger,
      isReady: () => this.isReady(),
      checkRole: (guildId, roleId, lang) => this.lookups.checkRole(guildId, roleId, lang),
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
    this.presences.clear();
    if (client) {
      await client.destroy().catch((err) => log.warn({ err }, 'Destroying Discord client failed'));
      log.info('Discord client stopped');
    }
  }

  /** Gives slash commands and buttons/modals access to the services (v2 services are optional). */
  attachServices(services: DiscordServices): void {
    this.services = services;
    this.commandEnv = {
      services,
      gateway: this.lookups,
      sendTest: (guildId, type) => this.sendTest(guildId, type),
      postPanel: (guildId, kind) => this.postPanel(guildId, kind),
      messageUrl: (guildId, ref) => this.messageUrl(guildId, ref),
      emojis: () => this.emojis,
      wsPing: () => this.client?.ws.ping ?? -1,
      startedAt: this.startedAt,
      clock: Date.now,
    };
    this.interactionEnv = {
      services,
      toggleRole: (guildId, userId, roleId, reason) => this.roleManager.toggleMemberRole(guildId, userId, roleId, reason),
      upsertApplicationReview: (application, settings) => this.upsertApplicationReview(application, settings),
      emojis: () => this.emojis,
      clock: Date.now,
    };
  }

  /**
   * Registers a callback for when the gateway comes back after a disconnect (shard resumed or re-identified).
   * Role changes may have failed while it was away, so the wiring reconciles live roles (and presences) from here.
   */
  onGatewayRecovered(listener: () => void): void {
    this.recoveryListeners.push(listener);
  }

  /** #15 — the client logs in with the privileged Presence intent (DISCORD_PRESENCE_INTENT=true). */
  presenceIntentEnabled(): boolean {
    return this.presenceIntent;
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
      this.presences.clear();
      await client.destroy().catch(() => {});
      throw startupError(err, this.readyTimeoutMs, this.presenceIntent);
    }
    log.info({ user: client.user?.tag, guilds: client.guilds.cache.size, presenceIntent: this.presenceIntent }, 'Discord client ready');
    await Promise.allSettled([this.loadApplicationEmojis(client), this.registerCommands(client)]);
  }

  private createClient(): Client {
    const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers];
    if (this.presenceIntent) intents.push(GatewayIntentBits.GuildPresences);
    const client = new Client({
      intents,
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
        // Presences: only Streaming members are tracked, from raw packets (PresenceTracker).
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
      rest: {
        invalidRequestWarningInterval: 250,
        // Channel renames (#8 counter) report "rate limited" instead of blocking for up to 10 minutes.
        rejectOnRateLimit: (data) => shouldRejectRateLimit(data),
      },
    });

    client.on(Events.InteractionCreate, (interaction) => void this.onInteraction(interaction));
    client.on(Events.GuildCreate, (guild) => void this.onGuildJoin(guild));
    client.on(Events.GuildDelete, (guild) => this.onGuildLeave(guild));
    client.on(Events.GuildMemberAdd, (member) => void this.onMemberJoin(member));
    client.on(Events.GuildRoleDelete, (role) => this.onRoleDelete(role));
    client.on(Events.ChannelDelete, (channel) => this.onChannelDelete(channel));
    if (this.presenceIntent) client.on(Events.Raw, (packet: unknown) => this.onRawPacket(packet));
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
    try {
      if (interaction.isChatInputCommand()) {
        await dispatchCommand(interaction, this.commandEnv);
        return;
      }
      if ((interaction.isButton() || interaction.isModalSubmit()) && isOwnComponent(interaction.customId)) {
        await dispatchComponent(interaction as unknown as ComponentInteraction, this.interactionEnv);
      }
    } catch (err) {
      log.error({ err, type: interaction.type }, 'Interaction handling failed');
    }
  }

  /** #15 — raw gateway packets keep the Streaming presence map; real changes go to the presence service. */
  private onRawPacket(packet: unknown): void {
    let changes;
    try {
      changes = this.presences.handlePacket(packet as { t?: unknown; d?: unknown });
    } catch (err) {
      log.warn({ err }, 'Presence packet handling failed');
      return;
    }
    if (changes.length === 0) return;
    const presence = this.services?.presence;
    if (!presence) return;
    for (const change of changes) {
      if (this.client?.users.cache.get(change.userId)?.bot) continue;
      void this.presenceQueue
        .run(`${change.guildId}:${change.userId}`, () => presence.onPresence(change.guildId, change.userId, change.activity))
        .catch((err) => log.warn({ err, guildId: change.guildId, userId: change.userId }, 'Presence update handling failed'));
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
        settings.features.notifyRole.roleId === role.id ? 'الإشعارات' : null,
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
      const f = settings.features;
      const routed = allNotificationChannelIds(settings).filter((id) => id !== settings.liveChannelId && id !== settings.contentChannelId);
      const uses = [
        settings.liveChannelId === channel.id ? 'إشعارات البث' : null,
        settings.contentChannelId === channel.id ? 'إشعارات المقاطع' : null,
        settings.logChannelId === channel.id ? 'اللوق' : null,
        routed.includes(channel.id) ? 'توجيه الإشعارات' : null,
        f.notifyRole.panelChannelId === channel.id ? 'رسالة رتبة الإشعارات' : null,
        f.applications.panelChannelId === channel.id ? 'رسالة التقديم' : null,
        f.applications.reviewChannelId === channel.id ? 'مراجعة الطلبات' : null,
        f.counter.channelId === channel.id ? 'العداد' : null,
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

  postDigest(view: DigestView): Promise<MessageRef | null> {
    return this.notifier.postDigest(view);
  }

  postPresenceLive(view: PresenceLiveView): Promise<MessageRef | null> {
    return this.notifier.postPresenceLive(view);
  }

  endPresenceLive(ref: MessageRef, view: PresenceLiveView): Promise<boolean> {
    return this.notifier.endPresenceLive(ref, view);
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

  // ───────────────────────────── DiscordActions (v2) ─────────────────────────────

  renameChannel(guildId: string, channelId: string, name: string): Promise<{ outcome: RenameOutcome; retryAfterMs?: number }> {
    return this.actions.renameChannel(guildId, channelId, name);
  }

  sendDirectMessage(userId: string, message: { content: string; embedTitle?: string; embedDescription?: string; color?: number }): Promise<boolean> {
    return this.actions.sendDirectMessage(userId, message);
  }

  upsertApplicationReview(application: StreamerApplication, settings: GuildSettings): Promise<MessageRef | null> {
    return this.actions.upsertApplicationReview(application, settings);
  }

  streamingPresences(guildId: string): Promise<Map<string, StreamingActivity> | null> {
    return this.actions.streamingPresences(guildId);
  }

  /** Posts or refreshes an interactive panel (#1 notify / #9 apply). Throws ValidationError in the guild language. */
  postPanel(guildId: string, kind: PanelKind): Promise<MessageRef> {
    return this.panels.post(guildId, kind);
  }

  // ───────────────────────────── previews & tools ─────────────────────────────

  async preview(guildId: string, type: TemplateType, template?: TemplateSpec, streamerId?: number): Promise<MessagePreview> {
    const settings = this.repos.settings.get(guildId);
    const lang = guildLanguage(settings);
    let streamer: Streamer | null = null;
    if (streamerId !== undefined && streamerId !== null) {
      streamer = this.repos.streamers.get(streamerId);
      if (!streamer || streamer.guildId !== guildId) throw new ValidationError(ti(lang, 'preview.streamerMissing'), 'streamerId');
    }
    const avatarUrl = streamer ? this.lookups.avatarFor(guildId, streamer.discordUserId) : null;
    // Unicode emojis (the default): the dashboard renders text, it cannot show custom emoji markup.
    return buildPreviewMessage(settings, type, {
      template,
      streamer,
      now: Date.now(),
      identity: sampleIdentityFor(lang, this.botUser()?.id ?? ''),
      ...(avatarUrl ? { avatarUrl } : {}),
    });
  }

  async sendTest(guildId: string, type: TemplateType): Promise<MessageRef | null> {
    const settings = this.repos.settings.get(guildId);
    const lang = guildLanguage(settings);
    const now = Date.now();
    const identity = sampleIdentityFor(lang, this.botUser()?.id ?? '');
    const view = sampleView(type, settings, now, identity);
    // The sample goes where a real post of that platform/kind would go (#4 routing).
    const channelId =
      type === 'content'
        ? resolveContentChannelId(settings, (view as ContentView).channel.platform, (view as ContentView).item.kind)
        : resolveLiveChannelId(settings, type === 'live' ? ((view as LiveView).platforms[0]?.platform ?? null) : ((view as SummaryView).segments[0]?.platform ?? null));
    if (!channelId) {
      throw new ValidationError(ti(lang, type === 'content' ? 'test.noContentChannel' : 'test.noLiveChannel'), type === 'content' ? 'contentChannelId' : 'liveChannelId');
    }
    if (!this.isReady()) throw new ValidationError(ti(lang, 'common.notReady'));

    const purpose = type === 'content' ? 'content' : 'live';
    const result = await this.notifier.send(guildId, channelId, purpose, (emojis) =>
      asTestMessage(buildMessage(type, view, { emojis, avatarUrl: identity.avatarUrl, now }), lang),
    );
    if (!result.ok) throw new ValidationError(failureMessage(result, purpose, channelId, lang) ?? ti(lang, 'test.failed'));
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
