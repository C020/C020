/**
 * A minimal in-memory imitation of the discord.js objects the Discord layer touches (client, guilds,
 * roles, members, channels). Only the members/methods our code uses are implemented.
 */
import { ChannelType, Collection, DiscordjsErrorCodes, PermissionFlagsBits, type Client } from 'discord.js';

export class FakeRole {
  constructor(
    readonly guild: FakeGuild,
    readonly id: string,
    public name: string,
    public position: number,
    public managed = false,
    public mentionable = true,
  ) {}

  get members(): Collection<string, FakeMember> {
    return this.guild.members.cache.filter((m) => m.roles.cache.has(this.id));
  }

  get color(): number {
    return 0;
  }

  get colors() {
    return { primaryColor: 0x123456, secondaryColor: null, tertiaryColor: null };
  }
}

export class FakeMember {
  readonly roleCalls: Array<{ op: 'add' | 'remove'; roleId: string; reason?: string }> = [];
  failNext: { code: number } | null = null;
  readonly roles: {
    cache: Collection<string, FakeRole>;
    readonly highest: FakeRole;
    add: (role: FakeRole, reason?: string) => Promise<void>;
    remove: (role: FakeRole, reason?: string) => Promise<void>;
  };
  readonly user: { id: string; bot: boolean; username: string };
  permissionSet = new Set<bigint>();

  constructor(
    readonly guild: FakeGuild,
    readonly id: string,
    public displayName: string,
    bot = false,
  ) {
    this.user = { id, bot, username: displayName.toLowerCase() };
    const cache = new Collection<string, FakeRole>();
    const self = this;
    this.roles = {
      cache,
      get highest(): FakeRole {
        return [...cache.values()].sort((a, b) => b.position - a.position)[0] ?? guild.everyone;
      },
      async add(role: FakeRole, reason?: string) {
        self.consumeFailure();
        self.roleCalls.push({ op: 'add', roleId: role.id, reason });
        cache.set(role.id, role);
      },
      async remove(role: FakeRole, reason?: string) {
        self.consumeFailure();
        self.roleCalls.push({ op: 'remove', roleId: role.id, reason });
        cache.delete(role.id);
      },
    };
  }

  get permissions() {
    return { has: (flag: bigint) => this.permissionSet.has(PermissionFlagsBits.Administrator) || this.permissionSet.has(flag) };
  }

  displayAvatarURL(): string {
    return `https://cdn.discordapp.com/avatars/${this.id}/a.png`;
  }

  private consumeFailure(): void {
    if (this.failNext) {
      const err = Object.assign(new Error('Discord API error'), this.failNext);
      this.failNext = null;
      throw err;
    }
  }
}

export class FakeChannel {
  readonly sent: Array<Record<string, unknown>> = [];
  readonly edits: Array<{ id: string; payload: Record<string, unknown> }> = [];
  sendError: unknown = null;
  editError: unknown = null;
  /** Permissions the bot has here (null = same as guild-level). */
  allowed: Set<bigint> | null = null;
  parent: { name: string; rawPosition: number } | null = null;
  private seq = 0;

  constructor(
    readonly guild: FakeGuild,
    readonly id: string,
    public name: string,
    public type: ChannelType = ChannelType.GuildText,
    public rawPosition = 0,
  ) {}

  get guildId(): string {
    return this.guild.id;
  }

  isDMBased(): boolean {
    return false;
  }

  isTextBased(): boolean {
    return this.type === ChannelType.GuildText || this.type === ChannelType.GuildAnnouncement || this.type === ChannelType.PublicThread;
  }

  isSendable(): boolean {
    return this.isTextBased();
  }

  isThread(): boolean {
    return this.type === ChannelType.PublicThread;
  }

  permissionsFor(member: FakeMember) {
    const set = this.allowed ?? member.permissionSet;
    return { has: (flag: bigint) => set.has(PermissionFlagsBits.Administrator) || set.has(flag) };
  }

  async send(payload: Record<string, unknown>) {
    if (this.sendError) throw this.sendError;
    this.sent.push(payload);
    return { id: `90000000000000000${++this.seq}`, channelId: this.id };
  }

  readonly messages = {
    edit: async (id: string, payload: Record<string, unknown>) => {
      if (this.editError) throw this.editError;
      this.edits.push({ id, payload });
      return { id, channelId: this.id };
    },
  };
}

export class FakeGuild {
  readonly everyone: FakeRole;
  readonly memberCount = 100;
  available = true;
  membersFetchError: unknown = null;
  readonly roles: { cache: Collection<string, FakeRole>; fetch: (id: string) => Promise<FakeRole | null> };
  readonly members: {
    me: FakeMember | null;
    cache: Collection<string, FakeMember>;
    fetch: (id?: string) => Promise<FakeMember | Collection<string, FakeMember>>;
    fetchMe: () => Promise<FakeMember>;
  };
  readonly channels: { cache: Collection<string, FakeChannel>; fetch: (id: string) => Promise<FakeChannel | null> };
  /** Members known to Discord but not cached yet (fetchable). */
  readonly remote = new Collection<string, FakeMember>();

  constructor(
    readonly id: string,
    public name = 'سيرفر',
  ) {
    this.everyone = new FakeRole(this, id, '@everyone', 0);
    const roleCache = new Collection<string, FakeRole>([[id, this.everyone]]);
    this.roles = { cache: roleCache, fetch: async (rid) => roleCache.get(rid) ?? null };
    const memberCache = new Collection<string, FakeMember>();
    const guild = this;
    this.members = {
      me: null,
      cache: memberCache,
      async fetch(userId?: string) {
        if (userId === undefined) {
          if (guild.membersFetchError) throw guild.membersFetchError;
          for (const [mid, m] of guild.remote) memberCache.set(mid, m);
          return memberCache.clone();
        }
        const member = memberCache.get(userId) ?? guild.remote.get(userId);
        if (!member) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
        memberCache.set(userId, member);
        return member;
      },
      async fetchMe() {
        if (!guild.members.me) throw new Error('no me');
        return guild.members.me;
      },
    };
    const channelCache = new Collection<string, FakeChannel>();
    this.channels = { cache: channelCache, fetch: async (cid) => channelCache.get(cid) ?? null };
  }

  iconURL(): string | null {
    return null;
  }

  addRole(id: string, name: string, position: number, extra: { managed?: boolean; mentionable?: boolean } = {}): FakeRole {
    const role = new FakeRole(this, id, name, position, extra.managed, extra.mentionable);
    this.roles.cache.set(id, role);
    return role;
  }

  addMember(id: string, name: string, opts: { roles?: FakeRole[]; cached?: boolean; bot?: boolean } = {}): FakeMember {
    const member = new FakeMember(this, id, name, opts.bot);
    for (const role of opts.roles ?? []) member.roles.cache.set(role.id, role);
    if (opts.cached === false) this.remote.set(id, member);
    else this.members.cache.set(id, member);
    return member;
  }

  addBot(id: string, roles: FakeRole[], permissions: bigint[]): FakeMember {
    const me = this.addMember(id, 'Bot', { roles, bot: true });
    for (const p of permissions) me.permissionSet.add(p);
    this.members.me = me;
    return me;
  }

  addChannel(id: string, name: string, type: ChannelType = ChannelType.GuildText, rawPosition = 0): FakeChannel {
    const channel = new FakeChannel(this, id, name, type, rawPosition);
    this.channels.cache.set(id, channel);
    return channel;
  }
}

export class FakeClient {
  ready = true;
  readonly guilds = { cache: new Collection<string, FakeGuild>() };
  readonly users = { cache: new Collection<string, { displayAvatarURL: () => string }>() };
  channelFetchError: unknown = null;
  readonly channels = {
    cache: new Collection<string, FakeChannel>(),
    fetch: async (id: string): Promise<FakeChannel | null> => {
      if (this.channelFetchError) throw this.channelFetchError;
      for (const guild of this.guilds.cache.values()) {
        const channel = guild.channels.cache.get(id);
        if (channel) return channel;
      }
      throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
    },
  };
  readonly user = { id: '800000000000000000', username: 'StreamBot', tag: 'StreamBot#0000', displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/bot.png' };

  isReady(): boolean {
    return this.ready;
  }

  addGuild(guild: FakeGuild): FakeGuild {
    this.guilds.cache.set(guild.id, guild);
    return guild;
  }

  asClient(): Client {
    return this as unknown as Client;
  }
}

export const membersTimeoutError = () => Object.assign(new Error('Members didn’t arrive in time.'), { code: DiscordjsErrorCodes.GuildMembersTimeout });
