import { ButtonStyle, ComponentType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import type { MessageRef } from '../../src/services/ports.js';
import type { TransportResult } from '../../src/discord/transport.js';
import { CustomIds } from '../../src/discord/interactions/ids.js';
import type { DeleteOutcome, InteractiveMessenger } from '../../src/discord/interactions/messenger.js';
import { buildApplyPanel, buildNotifyPanel, PanelPublisher, type RoleCheck } from '../../src/discord/interactions/panels.js';
import type { InteractiveMessage } from '../../src/discord/interactions/types.js';
import { db, GUILD, settings } from './helpers.js';

const ROLE = '700000000000000050';
const PANEL_CHANNEL = '300000000000000050';
const OTHER_CHANNEL = '300000000000000051';

class FakeMessenger implements InteractiveMessenger {
  readonly calls: Array<{ op: 'send' | 'edit' | 'delete'; channelId: string; messageId?: string; message?: InteractiveMessage }> = [];
  sendResults: TransportResult[] = [];
  editResults: TransportResult[] = [];
  deleteResult: DeleteOutcome = 'ok';
  private seq = 0;

  async send(_guildId: string, channelId: string, message: InteractiveMessage): Promise<TransportResult> {
    this.calls.push({ op: 'send', channelId, message });
    return this.sendResults.shift() ?? { ok: true, ref: { channelId, messageId: `98000000000000000${++this.seq}` } };
  }

  async edit(_guildId: string, ref: MessageRef, message: InteractiveMessage): Promise<TransportResult> {
    this.calls.push({ op: 'edit', channelId: ref.channelId, messageId: ref.messageId, message });
    return this.editResults.shift() ?? { ok: true, ref };
  }

  async delete(_guildId: string, ref: MessageRef): Promise<DeleteOutcome> {
    this.calls.push({ op: 'delete', channelId: ref.channelId, messageId: ref.messageId });
    return this.deleteResult;
  }
}

function setup(opts: { ready?: boolean; roleCheck?: RoleCheck | null } = {}) {
  const { repos } = db();
  const messenger = new FakeMessenger();
  const checks: string[] = [];
  const publisher = new PanelPublisher({
    repos,
    messenger,
    isReady: () => opts.ready ?? true,
    checkRole: async (_guildId, roleId) => {
      checks.push(roleId);
      return opts.roleCheck === undefined ? { exists: true, name: 'Alerts', elevated: false, decision: { ok: true } } : opts.roleCheck;
    },
  });
  return { repos, messenger, publisher, checks };
}

describe('panel builders', () => {
  it('builds the notify panel with one toggle button and a default text per ping setting (Arabic)', () => {
    const s = settings();
    s.features.notifyRole = { ...s.features.notifyRole, roleId: ROLE };
    const panel = buildNotifyPanel(s);
    expect(panel.embeds[0]!.title).toBe('🔔 إشعارات البثوث');
    expect(panel.embeds[0]!.description).toContain(`<@&${ROLE}>`);
    expect(panel.embeds[0]!.description).toContain('يبدأ أحد من الستريمرز بث');
    const button = panel.components[0]!.components[0]!;
    expect(button).toMatchObject({ type: ComponentType.Button, style: ButtonStyle.Primary, custom_id: CustomIds.notifyToggle, label: 'إشعارات البثوث' });

    s.features.notifyRole.pingOnContent = true;
    expect(buildNotifyPanel(s).embeds[0]!.description).toContain('أو ينزل مقطع جديد');
    s.features.notifyRole.pingOnLive = false;
    expect(buildNotifyPanel(s).embeds[0]!.description).toContain('أول ما ينزل مقطع جديد');
  });

  it('uses English defaults and custom texts ({role} placeholder, limits)', () => {
    const s = settings();
    s.features.language = 'en';
    s.features.notifyRole = { ...s.features.notifyRole, roleId: ROLE };
    const panel = buildNotifyPanel(s);
    expect(panel.embeds[0]!.title).toBe('🔔 Stream alerts');
    expect((panel.components[0]!.components[0] as { label: string }).label).toBe('Stream alerts');

    s.features.notifyRole.panelTitle = '  تنبيهات  ‮';
    s.features.notifyRole.panelDescription = 'خذ {role} وتابعنا\n' + 'x'.repeat(5000);
    const custom = buildNotifyPanel(s);
    expect(custom.embeds[0]!.title).toBe('تنبيهات');
    expect(custom.embeds[0]!.description!.startsWith(`خذ <@&${ROLE}> وتابعنا\n`)).toBe(true);
    expect(custom.embeds[0]!.description!.length).toBeLessThanOrEqual(4096);
  });

  it('builds the apply panel with the apply button', () => {
    const s = settings();
    const panel = buildApplyPanel(s);
    expect(panel.embeds[0]!.title).toBe('📝 قدّم كستريمر');
    expect(panel.components[0]!.components[0]).toMatchObject({ style: ButtonStyle.Success, custom_id: CustomIds.applyOpen });
    s.features.language = 'en';
    s.features.applications.panelTitle = 'Join the team';
    expect(buildApplyPanel(s).embeds[0]!.title).toBe('Join the team');
    expect(buildApplyPanel(s).embeds[0]!.description).toContain('Do you stream on Twitch');
  });
});

describe('PanelPublisher', () => {
  it('explains what is missing before posting (guild language)', async () => {
    const { publisher, repos } = setup();
    await expect(publisher.post(GUILD, 'notify')).rejects.toThrow('حدد رتبة الإشعارات');
    repos.settings.update(GUILD, { features: { notifyRole: { roleId: ROLE } } });
    await expect(publisher.post(GUILD, 'notify')).rejects.toThrow('حدد روم رسالة الإشعارات');
    await expect(publisher.post(GUILD, 'apply')).rejects.toThrow('فعّل طلبات الستريمرز');
    repos.settings.update(GUILD, { features: { applications: { enabled: true }, language: 'en' } });
    await expect(publisher.post(GUILD, 'apply')).rejects.toThrow('Choose the channel for the application panel');
    const err = await publisher.post(GUILD, 'apply').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).field).toBe('features.applications.panelChannelId');
  });

  it('refuses a notify role that conflicts, is missing, elevated or not assignable', async () => {
    const base = { features: { notifyRole: { roleId: ROLE, panelChannelId: PANEL_CHANNEL } } };
    const conflict = setup();
    conflict.repos.settings.update(GUILD, { ...base, liveRoleId: ROLE });
    await expect(conflict.publisher.post(GUILD, 'notify')).rejects.toThrow('نفس رتبة Streamer أو Streaming Now');

    const missing = setup({ roleCheck: { exists: false } });
    missing.repos.settings.update(GUILD, base);
    await expect(missing.publisher.post(GUILD, 'notify')).rejects.toThrow('غير موجودة');

    const elevated = setup({ roleCheck: { exists: true, name: 'Mods', elevated: true, decision: { ok: true } } });
    elevated.repos.settings.update(GUILD, base);
    await expect(elevated.publisher.post(GUILD, 'notify')).rejects.toThrow('صلاحيات إدارية');

    const above = setup({ roleCheck: { exists: true, name: 'Alerts', elevated: false, decision: { ok: false, code: 'role_above_bot', message: 'رتبة البوت لازم تكون فوق رتبة Alerts' } } });
    above.repos.settings.update(GUILD, base);
    await expect(above.publisher.post(GUILD, 'notify')).rejects.toThrow('رتبة البوت لازم تكون فوق رتبة Alerts');
    expect(above.messenger.calls).toEqual([]);
  });

  it('refuses while Discord is offline (role check unknown is not an error by itself)', async () => {
    const { publisher, repos, messenger } = setup({ ready: false, roleCheck: null });
    repos.settings.update(GUILD, { features: { notifyRole: { roleId: ROLE, panelChannelId: PANEL_CHANNEL } } });
    await expect(publisher.post(GUILD, 'notify')).rejects.toThrow('غير متصل');
    expect(messenger.calls).toEqual([]);
  });

  it('posts once, then refreshes the same message in place', async () => {
    const { publisher, repos, messenger } = setup();
    repos.settings.update(GUILD, { features: { notifyRole: { roleId: ROLE, panelChannelId: PANEL_CHANNEL } } });
    const first = await publisher.post(GUILD, 'notify');
    expect(messenger.calls.map((c) => c.op)).toEqual(['send']);
    expect(repos.panels.get(GUILD, 'notify')).toMatchObject({ channelId: PANEL_CHANNEL, messageId: first.messageId });

    repos.settings.update(GUILD, { features: { notifyRole: { panelTitle: 'جديد' } } });
    const second = await publisher.post(GUILD, 'notify');
    expect(second).toEqual(first);
    expect(messenger.calls.map((c) => c.op)).toEqual(['send', 'edit']);
    expect(messenger.calls[1]!.message!.embeds[0]!.title).toBe('جديد');
  });

  it('reposts when the old panel was deleted, and moves it (deleting the old one) when the channel changed', async () => {
    const { publisher, repos, messenger } = setup();
    repos.settings.update(GUILD, { features: { applications: { enabled: true, panelChannelId: PANEL_CHANNEL } } });
    const first = await publisher.post(GUILD, 'apply');
    messenger.editResults.push({ ok: false, reason: 'gone', detail: '10008' });
    const reposted = await publisher.post(GUILD, 'apply');
    expect(reposted.messageId).not.toBe(first.messageId);
    expect(messenger.calls.map((c) => c.op)).toEqual(['send', 'edit', 'send']);

    repos.settings.update(GUILD, { features: { applications: { panelChannelId: OTHER_CHANNEL } } });
    const moved = await publisher.post(GUILD, 'apply');
    expect(moved.channelId).toBe(OTHER_CHANNEL);
    expect(messenger.calls.slice(3)).toEqual([
      expect.objectContaining({ op: 'send', channelId: OTHER_CHANNEL }),
      { op: 'delete', channelId: PANEL_CHANNEL, messageId: reposted.messageId },
    ]);
    expect(repos.panels.get(GUILD, 'apply')).toMatchObject({ channelId: OTHER_CHANNEL, messageId: moved.messageId });
  });

  it('does not post a second panel when the old one is only unreachable, and explains send failures', async () => {
    const { publisher, repos, messenger } = setup();
    repos.settings.update(GUILD, { features: { applications: { enabled: true, panelChannelId: PANEL_CHANNEL } } });
    await publisher.post(GUILD, 'apply');
    messenger.editResults.push({ ok: false, reason: 'forbidden', detail: '50001', channelName: 'apply' });
    await expect(publisher.post(GUILD, 'apply')).rejects.toThrow('#apply');
    expect(messenger.calls.map((c) => c.op)).toEqual(['send', 'edit']);

    repos.panels.delete(GUILD, 'apply');
    repos.settings.update(GUILD, { features: { language: 'en' } });
    messenger.sendResults.push({ ok: false, reason: 'forbidden', detail: 'missing', missing: ['SendMessages', 'EmbedLinks'], channelName: 'apply' });
    await expect(publisher.post(GUILD, 'apply')).rejects.toThrow('missing permissions: Send Messages, Embed Links');
    expect(repos.panels.get(GUILD, 'apply')).toBeNull();
  });

  it('serializes concurrent posts of the same panel (no duplicate messages)', async () => {
    const { publisher, repos, messenger } = setup();
    repos.settings.update(GUILD, { features: { applications: { enabled: true, panelChannelId: PANEL_CHANNEL } } });
    const [a, b] = await Promise.all([publisher.post(GUILD, 'apply'), publisher.post(GUILD, 'apply')]);
    expect(a).toEqual(b);
    expect(messenger.calls.map((c) => c.op)).toEqual(['send', 'edit']);
  });
});
