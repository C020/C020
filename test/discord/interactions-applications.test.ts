import { ButtonStyle, ComponentType, MessageFlags, TextInputStyle } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import type { StreamerApplication } from '../../src/db/models.js';
import {
  accountUrl,
  buildApplicationReviewMessage,
  buildApplyModal,
  buildRejectModal,
  handleApplyOpen,
  handleApplySubmit,
  handleApprove,
  handleReject,
  handleRejectReason,
} from '../../src/discord/interactions/applications.js';
import { CustomIds, parseCustomId } from '../../src/discord/interactions/ids.js';
import { settings as baseSettings } from './helpers.js';
import {
  addStreamer,
  embedText,
  FakeInteraction,
  GUILD,
  interactionContext,
  MANAGE_GUILD,
  MANAGE_ROLES,
  REVIEWER,
  setFeatures,
  T0,
  USER,
} from './interactionHelpers.js';

const REVIEW_CHANNEL = '300000000000000070';

function application(patch: Partial<StreamerApplication> = {}): StreamerApplication {
  return {
    id: 12,
    guildId: GUILD,
    userId: USER,
    username: 'فهد',
    accounts: [
      { platform: 'twitch', input: 'abufahad' },
      { platform: 'kick', input: 'https://kick.com/abufahad' },
      { platform: 'youtube', input: 'UCabcdefghijklmnopqrstuv' },
      { platform: 'tiktok', input: 'not a handle!' },
    ],
    note: 'أبث فالورانت *كل* يوم',
    status: 'pending',
    reviewerId: null,
    reviewNote: null,
    streamerId: null,
    reviewChannelId: null,
    reviewMessageId: null,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    decidedAt: null,
    ...patch,
  };
}

function enableApplications(ctx: ReturnType<typeof interactionContext>, extra: Record<string, unknown> = {}) {
  return setFeatures(ctx.repos, { applications: { enabled: true, reviewChannelId: REVIEW_CHANNEL, ...extra } });
}

describe('custom ids', () => {
  it('round-trips application ids and rejects foreign or malformed ids', () => {
    expect(parseCustomId(CustomIds.applyApprove(12))).toEqual({ action: 'apply.approve', applicationId: 12 });
    expect(parseCustomId(CustomIds.applyReject(7))).toEqual({ action: 'apply.reject', applicationId: 7 });
    expect(parseCustomId(CustomIds.applyRejectReason(7))).toEqual({ action: 'apply.rejectReason', applicationId: 7 });
    expect(parseCustomId(CustomIds.notifyToggle)).toEqual({ action: 'notify.toggle' });
    expect(parseCustomId('sb:apply:approve:abc')).toBeNull();
    expect(parseCustomId('sb:apply:approve:0')).toBeNull();
    expect(parseCustomId('sb:apply:approve:')).toBeNull();
    expect(parseCustomId('other:button')).toBeNull();
    expect(parseCustomId(`sb:${'x'.repeat(200)}`)).toBeNull();
  });
});

describe('application modals', () => {
  it('has five optional labelled inputs within Discord limits', () => {
    const modal = buildApplyModal('ar');
    expect(modal.custom_id).toBe(CustomIds.applySubmit);
    expect(modal.title.length).toBeLessThanOrEqual(45);
    expect(modal.components).toHaveLength(5);
    const inputs = modal.components.map((c) => c as unknown as { type: number; label: string; description: string; component: Record<string, unknown> });
    expect(inputs.map((c) => c.component.custom_id)).toEqual(['twitch', 'kick', 'youtube', 'tiktok', 'note']);
    for (const c of inputs) {
      expect(c.type).toBe(ComponentType.Label);
      expect(c.label.length).toBeLessThanOrEqual(45);
      expect(c.description.length).toBeLessThanOrEqual(100);
      expect(c.component).toMatchObject({ type: ComponentType.TextInput, required: false });
      expect(c.component.label).toBeUndefined();
    }
    expect(inputs[0]!.component).toMatchObject({ style: TextInputStyle.Short, max_length: 200 });
    expect(inputs[4]!.component).toMatchObject({ style: TextInputStyle.Paragraph, max_length: 500 });
    expect(buildApplyModal('en').title).toBe('Streamer application');
  });

  it('builds the reject-reason modal for one application', () => {
    const modal = buildRejectModal('en', 9);
    expect(modal.custom_id).toBe('sb:apply:rejectreason:9');
    expect(modal.title).toBe('Reject application');
    expect(modal.components).toHaveLength(1);
  });
});

describe('review message', () => {
  it('shows applicant, linked accounts, note and the approve/reject buttons while pending', () => {
    const msg = buildApplicationReviewMessage(application(), baseSettings());
    const embed = msg.embeds[0]!;
    expect(embed.title).toBe('📝 طلب ستريمر');
    expect(embed.footer?.text).toBe('طلب رقم 12');
    const text = embedText(embed);
    expect(text).toContain(`<@${USER}>`);
    expect(text).toContain('⏳ قيد المراجعة');
    expect(text).toContain('[abufahad](https://www.twitch.tv/abufahad)');
    expect(text).toContain('(https://kick.com/abufahad)');
    expect(text).toContain('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv');
    // Not a valid handle: shown as escaped text without a link.
    expect(text).toContain('**TikTok:** not a handle!');
    expect(text).toContain('أبث فالورانت \\*كل\\* يوم');
    const buttons = msg.components[0]!.components;
    expect(buttons).toEqual([
      expect.objectContaining({ style: ButtonStyle.Success, custom_id: 'sb:apply:approve:12' }),
      expect.objectContaining({ style: ButtonStyle.Danger, custom_id: 'sb:apply:reject:12' }),
    ]);
  });

  it('removes the buttons and shows the decision, reviewer and reason after a decision (English)', () => {
    const s = baseSettings();
    s.features.language = 'en';
    const msg = buildApplicationReviewMessage(
      application({ status: 'rejected', reviewerId: REVIEWER, reviewNote: 'Not enough streams yet', decidedAt: new Date(T0).toISOString() }),
      s,
    );
    expect(msg.components).toEqual([]);
    const text = embedText(msg.embeds[0]!);
    expect(text).toContain(`❌ Rejected — by <@${REVIEWER}>`);
    expect(text).toContain('📝 Reason');
    expect(text).toContain('Not enough streams yet');
    expect(msg.embeds[0]!.color).toBe(0xed4245);
  });

  it('respects field limits for huge notes', () => {
    const msg = buildApplicationReviewMessage(application({ note: 'ك'.repeat(3000) }), baseSettings());
    for (const field of msg.embeds[0]!.fields ?? []) expect(field.value.length).toBeLessThanOrEqual(1024);
  });

  it('builds profile links only for plausible handles', () => {
    expect(accountUrl('tiktok', '@abu.fahad')).toBe('https://www.tiktok.com/@abu.fahad');
    expect(accountUrl('youtube', '@abufahad')).toBe('https://www.youtube.com/@abufahad');
    expect(accountUrl('twitch', 'javascript:alert(1)')).toBeNull();
    expect(accountUrl('kick', 'ftp://kick.com/x')).toBeNull();
    expect(accountUrl('kick', 'https://kick.com/x')).toBe('https://kick.com/x');
  });
});

describe('apply button', () => {
  it('explains when applications are closed, already registered or pending', async () => {
    const ctx = interactionContext();
    const closed = new FakeInteraction(CustomIds.applyOpen, 'button');
    await handleApplyOpen(closed, ctx.env, GUILD);
    expect(closed.lastEmbed().description).toContain('مقفل');

    enableApplications(ctx);
    ctx.repos.applications.create({ guildId: GUILD, userId: USER, username: 'فهد', accounts: [{ platform: 'kick', input: 'x' }], note: null });
    const pending = new FakeInteraction(CustomIds.applyOpen, 'button');
    await handleApplyOpen(pending, ctx.env, GUILD);
    expect(pending.lastEmbed().description).toContain('قيد المراجعة');
    expect(pending.lastEmbed().description).toMatch(/<t:\d+:R>/);

    addStreamer(ctx.repos);
    const registered = new FakeInteraction(CustomIds.applyOpen, 'button');
    await handleApplyOpen(registered, ctx.env, GUILD);
    expect(registered.lastEmbed().description).toContain('مسجّل كستريمر من قبل');
    expect(registered.last().flags).toBe(MessageFlags.Ephemeral);
  });

  it('opens the modal as the first response (in the guild language)', async () => {
    const ctx = interactionContext();
    enableApplications(ctx);
    setFeatures(ctx.repos, { language: 'en' });
    const i = new FakeInteraction(CustomIds.applyOpen, 'button');
    await handleApplyOpen(i, ctx.env, GUILD);
    expect(i.ops()).toEqual(['showModal']);
    expect(i.modal().title).toBe('Streamer application');
  });

  it('says the feature is unavailable when the application service is not wired', async () => {
    const ctx = interactionContext({ withApplications: false });
    enableApplications(ctx);
    const i = new FakeInteraction(CustomIds.applyOpen, 'button');
    await handleApplyOpen(i, ctx.env, GUILD);
    expect(i.lastEmbed().description).toContain('مو جاهزة');
  });
});

describe('application modal submit', () => {
  const fields = { twitch: '  abufahad ', kick: '', youtube: '', tiktok: '@abu', note: ' أبث كل يوم ' };

  it('requires at least one account before calling the service', async () => {
    const ctx = interactionContext();
    enableApplications(ctx);
    const i = new FakeInteraction(CustomIds.applySubmit, 'modal', { fields: { twitch: ' ', note: 'x' } });
    await handleApplySubmit(i, ctx.env, GUILD);
    expect(i.ops()).toEqual(['reply']);
    expect(i.lastEmbed().description).toContain('حساب واحد على الأقل');
    expect(ctx.repos.applications.list(GUILD)).toEqual([]);
  });

  it('submits trimmed inputs, confirms ephemerally and posts the review message when the service did not', async () => {
    const ctx = interactionContext();
    enableApplications(ctx);
    const i = new FakeInteraction(CustomIds.applySubmit, 'modal', { fields, nick: 'فهودي' });
    await handleApplySubmit(i, ctx.env, GUILD);
    expect(i.ops()).toEqual(['deferReply', 'editReply']);
    const [stored] = ctx.repos.applications.list(GUILD);
    expect(stored).toMatchObject({
      userId: USER,
      username: 'فهودي',
      accounts: [
        { platform: 'twitch', input: 'abufahad' },
        { platform: 'tiktok', input: '@abu' },
      ],
      note: 'أبث كل يوم',
    });
    const text = embedText(i.lastEmbed());
    expect(text).toContain('✅ تم استلام طلبك');
    expect(text).toContain('على الخاص');
    expect(ctx.upsert).toHaveBeenCalledTimes(1);
    expect(ctx.repos.applications.get(stored!.id)!.reviewChannelId).toBe(REVIEW_CHANNEL);
  });

  it('does not post a second review message when the service already did', async () => {
    const ctx = interactionContext();
    enableApplications(ctx, { dmApplicant: false });
    ctx.applications.onSubmit = async (app) => {
      ctx.repos.applications.update(app.id, { reviewChannelId: REVIEW_CHANNEL, reviewMessageId: '950000000000000099' });
    };
    const i = new FakeInteraction(CustomIds.applySubmit, 'modal', { fields });
    await handleApplySubmit(i, ctx.env, GUILD);
    expect(ctx.upsert).not.toHaveBeenCalled();
    expect(embedText(i.lastEmbed())).not.toContain('على الخاص');
  });

  it('shows the service validation message', async () => {
    const ctx = interactionContext();
    enableApplications(ctx);
    ctx.applications.submitError = new ValidationError('رابط تويتش غير صحيح', 'twitch');
    const i = new FakeInteraction(CustomIds.applySubmit, 'modal', { fields });
    await handleApplySubmit(i, ctx.env, GUILD);
    expect(i.lastEmbed().description).toBe('رابط تويتش غير صحيح');
    expect(ctx.upsert).not.toHaveBeenCalled();
  });

  it('refuses when applications were closed while the modal was open', async () => {
    const ctx = interactionContext();
    const i = new FakeInteraction(CustomIds.applySubmit, 'modal', { fields });
    await handleApplySubmit(i, ctx.env, GUILD);
    expect(i.lastEmbed().description).toContain('مقفل');
  });
});

describe('review buttons', () => {
  function pendingApp(ctx: ReturnType<typeof interactionContext>) {
    return ctx.repos.applications.create({ guildId: GUILD, userId: USER, username: 'فهد', accounts: [{ platform: 'kick', input: 'abufahad' }], note: null });
  }

  it('only lets members with Manage Server review (and Manage Roles to approve when a Streamer role is set)', async () => {
    const ctx = interactionContext();
    enableApplications(ctx);
    const app = pendingApp(ctx);
    const member = new FakeInteraction(CustomIds.applyApprove(app.id), 'button', { userId: REVIEWER, permissions: [] });
    await handleApprove(member, ctx.env, GUILD, app.id);
    expect(member.lastEmbed().description).toContain('للإدارة بس');

    ctx.repos.settings.update(GUILD, { streamerRoleId: '700000000000000001' });
    const manager = new FakeInteraction(CustomIds.applyApprove(app.id), 'button', { userId: REVIEWER, permissions: [MANAGE_GUILD] });
    await handleApprove(manager, ctx.env, GUILD, app.id);
    expect(manager.lastEmbed().description).toContain('Manage Roles');

    const rejecter = new FakeInteraction(CustomIds.applyReject(app.id), 'button', { userId: REVIEWER, permissions: [] });
    await handleReject(rejecter, ctx.env, GUILD, app.id);
    expect(rejecter.lastEmbed().description).toContain('للإدارة بس');
    expect(ctx.applications.approveCalls).toEqual([]);
  });

  it('approves, refreshes the review message and reports skipped accounts', async () => {
    const ctx = interactionContext();
    enableApplications(ctx);
    const app = pendingApp(ctx);
    ctx.applications.skipped = [{ platform: 'kick', input: 'abufahad', reason: 'الحساب غير موجود' }];
    const i = new FakeInteraction(CustomIds.applyApprove(app.id), 'button', { userId: REVIEWER, permissions: [MANAGE_GUILD, MANAGE_ROLES] });
    await handleApprove(i, ctx.env, GUILD, app.id);
    expect(ctx.applications.approveCalls).toEqual([{ applicationId: app.id, actor: `user:${REVIEWER}` }]);
    expect(ctx.upsert).toHaveBeenCalledTimes(1);
    expect(ctx.upsert.mock.calls[0]![0]).toMatchObject({ id: app.id, status: 'approved' });
    const text = embedText(i.lastEmbed());
    expect(text).toContain('✅ تم قبول فهد');
    expect(text).toContain('**Kick** (abufahad): الحساب غير موجود');
    expect(i.ops()[0]).toBe('deferReply');
  });

  it('answers "already decided" (and refreshes the message) instead of deciding twice', async () => {
    const ctx = interactionContext();
    enableApplications(ctx);
    const app = pendingApp(ctx);
    ctx.repos.applications.update(app.id, { status: 'rejected', reviewerId: REVIEWER, decidedAt: new Date(T0).toISOString() });
    const approve = new FakeInteraction(CustomIds.applyApprove(app.id), 'button', { userId: REVIEWER, permissions: [MANAGE_GUILD] });
    await handleApprove(approve, ctx.env, GUILD, app.id);
    expect(approve.lastEmbed().description).toContain('انتهت مراجعته: ❌ مرفوض');
    expect(ctx.applications.approveCalls).toEqual([]);
    expect(ctx.upsert).toHaveBeenCalledTimes(1);

    const reject = new FakeInteraction(CustomIds.applyReject(app.id), 'button', { userId: REVIEWER, permissions: [MANAGE_GUILD] });
    await handleReject(reject, ctx.env, GUILD, app.id);
    expect(reject.ops()).toEqual(['reply']);
  });

  it('refuses applications of another guild', async () => {
    const ctx = interactionContext();
    enableApplications(ctx);
    const other = ctx.repos.applications.create({ guildId: '999999999999999999', userId: USER, username: 'x', accounts: [{ platform: 'kick', input: 'x' }], note: null });
    const i = new FakeInteraction(CustomIds.applyApprove(other.id), 'button', { userId: REVIEWER, permissions: [MANAGE_GUILD] });
    await handleApprove(i, ctx.env, GUILD, other.id);
    expect(i.lastEmbed().description).toBe('الطلب غير موجود');
    expect(ctx.applications.approveCalls).toEqual([]);
  });

  it('opens the reject modal, then rejects with the reason', async () => {
    const ctx = interactionContext();
    enableApplications(ctx);
    const app = pendingApp(ctx);
    const click = new FakeInteraction(CustomIds.applyReject(app.id), 'button', { userId: REVIEWER, permissions: [MANAGE_GUILD] });
    await handleReject(click, ctx.env, GUILD, app.id);
    expect(click.ops()).toEqual(['showModal']);
    expect(click.modal().custom_id).toBe(CustomIds.applyRejectReason(app.id));

    const submit = new FakeInteraction(CustomIds.applyRejectReason(app.id), 'modal', {
      userId: REVIEWER,
      permissions: [MANAGE_GUILD],
      fields: { reason: '  ما فيه بثوث كافية  ' },
    });
    await handleRejectReason(submit, ctx.env, GUILD, app.id);
    expect(ctx.applications.rejectCalls).toEqual([{ applicationId: app.id, actor: `user:${REVIEWER}`, note: 'ما فيه بثوث كافية' }]);
    expect(ctx.upsert.mock.calls.at(-1)![0]).toMatchObject({ status: 'rejected' });
    expect(embedText(submit.lastEmbed())).toContain('السبب: ما فيه بثوث كافية');
  });

  it('rejects without a reason when the field is empty, re-checking permissions on submit', async () => {
    const ctx = interactionContext();
    enableApplications(ctx);
    const app = pendingApp(ctx);
    const noPerms = new FakeInteraction(CustomIds.applyRejectReason(app.id), 'modal', { userId: REVIEWER, permissions: [], fields: { reason: '' } });
    await handleRejectReason(noPerms, ctx.env, GUILD, app.id);
    expect(ctx.applications.rejectCalls).toEqual([]);

    const ok = new FakeInteraction(CustomIds.applyRejectReason(app.id), 'modal', { userId: REVIEWER, permissions: [MANAGE_GUILD], fields: {} });
    await handleRejectReason(ok, ctx.env, GUILD, app.id);
    expect(ctx.applications.rejectCalls).toEqual([{ applicationId: app.id, actor: `user:${REVIEWER}`, note: null }]);
    expect(ok.lastEmbed().title).toBe('❌ تم رفض الطلب');
    expect(ok.lastEmbed().description).toBeUndefined();
  });
});
