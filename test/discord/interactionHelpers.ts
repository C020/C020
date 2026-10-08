/** Fakes for the button/modal/slash-command handlers (no discord.js client involved). */
import type { APIEmbed, APIModalInteractionResponseCallbackData } from 'discord.js';
import { vi } from 'vitest';
import type {
  ApplicationServiceApi,
  DiscordServices,
  LinkServiceApi,
  ManualPostServiceApi,
  SessionServiceApi,
  StreamerServiceApi,
} from '../../src/app/context.js';
import { ValidationError } from '../../src/core/errors.js';
import type { GuildFeaturesPatch, GuildSettings, Streamer, StreamerApplication } from '../../src/db/models.js';
import type { Repositories } from '../../src/db/repositories.js';
import type { CommandEnv } from '../../src/discord/commands/types.js';
import { DEFAULT_PLATFORM_EMOJIS } from '../../src/discord/emojis.js';
import type { ComponentInteraction, InteractionEnv, InteractionSendOptions } from '../../src/discord/interactions/types.js';
import type { ToggleRoleResult } from '../../src/discord/roles.js';
import type { MessageRef } from '../../src/services/ports.js';
import { db, GUILD, T0, USER } from './helpers.js';

export { GUILD, T0, USER };

export const REVIEWER = '200000000000000777';
export const MANAGE_GUILD = 1n << 5n;
export const MANAGE_ROLES = 1n << 28n;
export const ADMINISTRATOR = 1n << 3n;

export interface RecordedCall {
  op: 'reply' | 'deferReply' | 'editReply' | 'showModal';
  payload: unknown;
}

/** Imitates discord.js' acknowledgement rules: one initial response, editReply only after it. */
export class FakeInteraction implements ComponentInteraction {
  readonly calls: RecordedCall[] = [];
  deferred = false;
  replied = false;
  readonly user: { id: string; username: string; globalName: string | null; bot: boolean };
  readonly member: unknown;
  memberPermissions: { has(permission: bigint): boolean } | null;
  showModal?: (modal: APIModalInteractionResponseCallbackData) => Promise<unknown>;
  readonly fields?: { getTextInputValue(customId: string): string };
  failDefer = false;

  constructor(
    readonly customId: string,
    private readonly kind: 'button' | 'modal',
    opts: { guildId?: string | null; userId?: string; username?: string; nick?: string | null; permissions?: bigint[]; fields?: Record<string, string> } = {},
  ) {
    this.guildId = opts.guildId === undefined ? GUILD : opts.guildId;
    this.user = { id: opts.userId ?? USER, username: opts.username ?? 'fahad', globalName: null, bot: false };
    this.member = opts.nick ? { nick: opts.nick } : null;
    const perms = new Set(opts.permissions ?? []);
    this.memberPermissions = { has: (flag: bigint) => perms.has(ADMINISTRATOR) || perms.has(flag) };
    if (kind === 'button') {
      this.showModal = async (modal) => {
        this.acknowledge();
        this.replied = true;
        this.calls.push({ op: 'showModal', payload: modal });
      };
    } else {
      const values = opts.fields ?? {};
      this.fields = {
        getTextInputValue: (id: string) => {
          if (!(id in values)) throw new Error(`No text input with id ${id}`);
          return values[id]!;
        },
      };
    }
  }

  readonly guildId: string | null;

  inGuild(): boolean {
    return this.guildId !== null;
  }

  isButton(): boolean {
    return this.kind === 'button';
  }

  isModalSubmit(): boolean {
    return this.kind === 'modal';
  }

  private acknowledge(): void {
    if (this.deferred || this.replied) throw Object.assign(new Error('Interaction has already been acknowledged.'), { code: 40060 });
  }

  async reply(options: InteractionSendOptions): Promise<unknown> {
    this.acknowledge();
    this.replied = true;
    this.calls.push({ op: 'reply', payload: options });
    return undefined;
  }

  async deferReply(options?: { flags?: number }): Promise<unknown> {
    if (this.failDefer) throw Object.assign(new Error('Unknown interaction'), { code: 10062 });
    this.acknowledge();
    this.deferred = true;
    this.calls.push({ op: 'deferReply', payload: options });
    return undefined;
  }

  async editReply(options: InteractionSendOptions): Promise<unknown> {
    if (!this.deferred && !this.replied) throw new Error('The reply to this interaction has not been sent or deferred.');
    this.calls.push({ op: 'editReply', payload: options });
    return undefined;
  }

  /** The last visible response (reply or editReply). */
  last(): InteractionSendOptions {
    const call = [...this.calls].reverse().find((c) => c.op === 'reply' || c.op === 'editReply');
    if (!call) throw new Error('no response');
    return call.payload as InteractionSendOptions;
  }

  lastEmbed(): APIEmbed {
    const embed = this.last().embeds?.[0];
    if (!embed) throw new Error('no embed');
    return embed;
  }

  modal(): APIModalInteractionResponseCallbackData {
    const call = this.calls.find((c) => c.op === 'showModal');
    if (!call) throw new Error('no modal');
    return call.payload as APIModalInteractionResponseCallbackData;
  }

  ops(): string[] {
    return this.calls.map((c) => c.op);
  }
}

/** Text of an embed (title + description + fields) for loose assertions. */
export function embedText(embed: APIEmbed): string {
  return [embed.title, embed.description, ...(embed.fields ?? []).flatMap((f) => [f.name, f.value]), embed.footer?.text].filter(Boolean).join('\n');
}

/** In-memory ApplicationService with the documented validation rules (enough for the Discord handlers). */
export class FakeApplications implements ApplicationServiceApi {
  readonly approveCalls: Array<{ applicationId: number; actor: string }> = [];
  readonly rejectCalls: Array<{ applicationId: number; actor: string; note: string | null | undefined }> = [];
  skipped: Array<{ platform: 'twitch' | 'kick' | 'youtube' | 'tiktok'; input: string; reason: string }> = [];
  submitError: Error | null = null;
  /** Simulates the real service posting the review message on submit. */
  onSubmit: ((application: StreamerApplication) => Promise<void>) | null = null;

  constructor(private readonly repos: Repositories) {}

  async submit(guildId: string, input: { userId: string; username: string; accounts: StreamerApplication['accounts']; note: string | null }): Promise<StreamerApplication> {
    if (this.submitError) throw this.submitError;
    if (input.accounts.length === 0) throw new ValidationError('لازم حساب واحد على الأقل');
    if (this.repos.applications.pendingFor(guildId, input.userId)) throw new ValidationError('عندك طلب قيد المراجعة');
    const created = this.repos.applications.create({ guildId, ...input });
    if (this.onSubmit) await this.onSubmit(created);
    return this.repos.applications.get(created.id)!;
  }

  list(guildId: string): StreamerApplication[] {
    return this.repos.applications.list(guildId);
  }

  get(guildId: string, applicationId: number): StreamerApplication {
    const app = this.repos.applications.get(applicationId);
    if (!app || app.guildId !== guildId) throw new ValidationError('الطلب غير موجود');
    return app;
  }

  async approve(guildId: string, applicationId: number, actor: string) {
    this.approveCalls.push({ applicationId, actor });
    const app = this.get(guildId, applicationId);
    const streamer = this.repos.streamers.create({ guildId, discordUserId: app.userId, displayName: app.username });
    const application = this.repos.applications.update(applicationId, {
      status: 'approved',
      reviewerId: actor.replace('user:', ''),
      streamerId: streamer.id,
      decidedAt: new Date(T0).toISOString(),
    })!;
    return { application, streamer: { ...streamer, accounts: [] }, skipped: this.skipped };
  }

  async reject(guildId: string, applicationId: number, actor: string, note?: string | null): Promise<StreamerApplication> {
    this.rejectCalls.push({ applicationId, actor, note });
    this.get(guildId, applicationId);
    return this.repos.applications.update(applicationId, {
      status: 'rejected',
      reviewerId: actor.replace('user:', ''),
      reviewNote: note ?? null,
      decidedAt: new Date(T0).toISOString(),
    })!;
  }

  async cancel(): Promise<boolean> {
    return false;
  }
}

export function stubStreamers(): StreamerServiceApi {
  return {} as unknown as StreamerServiceApi;
}

export function stubSessions(): SessionServiceApi {
  return { liveViews: () => [], syncRoles: async () => ({ added: 0, removed: 0 }) } as unknown as SessionServiceApi;
}

export function setFeatures(repos: Repositories, features: GuildFeaturesPatch, patch: Partial<Omit<GuildSettings, 'features' | 'options'>> = {}): GuildSettings {
  return repos.settings.update(GUILD, { ...patch, features });
}

export interface InteractionContext {
  repos: Repositories;
  env: InteractionEnv;
  services: DiscordServices;
  applications: FakeApplications;
  toggle: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  audits: (prefix?: string) => ReturnType<Repositories['audit']['list']>;
}

export function interactionContext(opts: { toggle?: ToggleRoleResult; withApplications?: boolean } = {}): InteractionContext {
  const { repos, audit } = db();
  const applications = new FakeApplications(repos);
  const services: DiscordServices = {
    streamers: stubStreamers(),
    sessions: stubSessions(),
    repos,
    audit,
    ...(opts.withApplications === false ? {} : { applications }),
  };
  const toggle = vi.fn(async (): Promise<ToggleRoleResult> => opts.toggle ?? { status: 'added', roleName: 'Alerts' });
  let seq = 0;
  const upsert = vi.fn(async (application: StreamerApplication, settings: GuildSettings): Promise<MessageRef | null> => {
    const channelId = settings.features.applications.reviewChannelId;
    if (!channelId) return null;
    const ref = { channelId, messageId: application.reviewMessageId ?? `95000000000000000${++seq}` };
    repos.applications.update(application.id, { reviewChannelId: ref.channelId, reviewMessageId: ref.messageId });
    return ref;
  });
  const env: InteractionEnv = { services, toggleRole: toggle, upsertApplicationReview: upsert, emojis: () => DEFAULT_PLATFORM_EMOJIS, clock: () => T0 };
  return {
    repos,
    env,
    services,
    applications,
    toggle,
    upsert,
    audits: (prefix?: string) => repos.audit.list({ guildId: GUILD, ...(prefix ? { actionPrefix: prefix } : {}) }),
  };
}

export function addStreamer(repos: Repositories, discordUserId = USER, displayName = 'أبو فهد'): Streamer {
  return repos.streamers.create({ guildId: GUILD, discordUserId, displayName });
}

// ───────────────────────────── slash commands ─────────────────────────────

/** Imitates a ChatInputCommandInteraction for dispatchCommand (options by name). */
export class FakeCommandInteraction {
  readonly calls: RecordedCall[] = [];
  deferred = false;
  replied = false;
  readonly user: { id: string; username: string; bot: boolean };

  constructor(
    readonly commandName: string,
    private readonly opts: {
      subcommand?: string;
      strings?: Record<string, string | null>;
      users?: Record<string, { id: string; bot?: boolean } | null>;
      guildId?: string | null;
      userId?: string;
    } = {},
  ) {
    this.user = { id: opts.userId ?? USER, username: 'fahad', bot: false };
  }

  get guildId(): string | null {
    return this.opts.guildId === undefined ? GUILD : this.opts.guildId;
  }

  inGuild(): boolean {
    return this.guildId !== null;
  }

  readonly options = {
    getSubcommand: (_required?: boolean) => this.opts.subcommand ?? '',
    getString: (name: string, required?: boolean) => {
      const value = this.opts.strings?.[name] ?? null;
      if (required && value === null) throw new Error(`missing option ${name}`);
      return value;
    },
    getUser: (name: string, required?: boolean) => {
      const value = this.opts.users?.[name] ?? null;
      if (required && value === null) throw new Error(`missing option ${name}`);
      return value ? { bot: false, ...value } : null;
    },
  };

  async deferReply(options?: { flags?: number }): Promise<void> {
    this.deferred = true;
    this.calls.push({ op: 'deferReply', payload: options });
  }

  async reply(options: unknown): Promise<void> {
    this.replied = true;
    this.calls.push({ op: 'reply', payload: options });
  }

  async editReply(options: unknown): Promise<void> {
    this.calls.push({ op: 'editReply', payload: options });
  }

  last(): { embeds?: APIEmbed[]; components?: Array<{ components: Array<Record<string, unknown>> }>; content?: string } {
    const call = [...this.calls].reverse().find((c) => c.op === 'reply' || c.op === 'editReply');
    if (!call) throw new Error('no response');
    return call.payload as never;
  }

  lastEmbed(): APIEmbed {
    const embed = this.last().embeds?.[0];
    if (!embed) throw new Error('no embed');
    return embed;
  }
}

export interface CommandContext {
  repos: Repositories;
  env: CommandEnv;
  postPanel: ReturnType<typeof vi.fn>;
  audits: (prefix?: string) => ReturnType<Repositories['audit']['list']>;
}

export function commandContext(services: Partial<Pick<DiscordServices, 'links' | 'manualPosts' | 'applications'>> = {}): CommandContext {
  const { repos, audit } = db();
  const postPanel = vi.fn(async (): Promise<MessageRef> => ({ channelId: '300000000000000010', messageId: '960000000000000001' }));
  const env: CommandEnv = {
    services: { streamers: stubStreamers(), sessions: stubSessions(), repos, audit, ...services },
    gateway: {} as CommandEnv['gateway'],
    sendTest: async () => null,
    postPanel,
    messageUrl: (guildId, ref) => `https://discord.com/channels/${guildId}/${ref.channelId}/${ref.messageId}`,
    emojis: () => DEFAULT_PLATFORM_EMOJIS,
    wsPing: () => 42,
    startedAt: T0,
    clock: () => T0,
  };
  return { repos, env, postPanel, audits: (prefix?: string) => repos.audit.list({ guildId: GUILD, ...(prefix ? { actionPrefix: prefix } : {}) }) };
}

export function fakeLinks(overrides: Partial<LinkServiceApi> = {}): LinkServiceApi & { unlinkCalls: Array<[string, string, string]> } {
  const unlinkCalls: Array<[string, string, string]> = [];
  return {
    unlinkCalls,
    isAvailable: () => true,
    startUrl: (guildId, userId, platform) => `https://bot.example.com/link/start?t=${guildId}.${userId}.${platform}`,
    linksFor: () => [],
    unlink: async (userId, platform, actor) => {
      unlinkCalls.push([userId, platform, actor]);
      return true;
    },
    tiktokAccessToken: async () => null,
    ...overrides,
  } as LinkServiceApi & { unlinkCalls: Array<[string, string, string]> };
}

export function fakeManualPosts(overrides: Partial<ManualPostServiceApi> = {}): ManualPostServiceApi & { posts: unknown[] } {
  const posts: unknown[] = [];
  return {
    posts,
    inspect: async (_guildId, url) => ({
      platform: 'kick',
      kind: 'clip',
      contentId: 'clip_01',
      url,
      title: 'لقطة خرافية',
      thumbnailUrl: null,
      streamer: { id: 1, displayName: 'أبو فهد' },
      channelId: '300000000000000020',
      alreadyPosted: false,
    }),
    post: async (_guildId, input) => {
      posts.push(input);
      return { messageRef: { channelId: '300000000000000020', messageId: '970000000000000001' }, contentItemId: 5 };
    },
    ...overrides,
  } as ManualPostServiceApi & { posts: unknown[] };
}
