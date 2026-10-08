import { MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { CustomIds } from '../../src/discord/interactions/ids.js';
import { handleNotifyToggle } from '../../src/discord/interactions/notifyRole.js';
import { embedText, FakeInteraction, GUILD, interactionContext, setFeatures, USER } from './interactionHelpers.js';

const ROLE = '700000000000000060';

function click(opts: { nick?: string } = {}) {
  return new FakeInteraction(CustomIds.notifyToggle, 'button', opts);
}

describe('#1 notification role toggle', () => {
  it('explains (without deferring) when the feature is off', async () => {
    const ctx = interactionContext();
    const i = click();
    await handleNotifyToggle(i, ctx.env, GUILD);
    expect(i.ops()).toEqual(['reply']);
    expect(i.last().flags).toBe(MessageFlags.Ephemeral);
    expect(i.lastEmbed().description).toContain('رتبة الإشعارات مو مفعّلة');
    expect(ctx.toggle).not.toHaveBeenCalled();
  });

  it('defers, adds the role, answers ephemerally and audits notify.subscribe (not mirrored)', async () => {
    const ctx = interactionContext({ toggle: { status: 'added', roleName: 'Alerts' } });
    setFeatures(ctx.repos, { notifyRole: { roleId: ROLE, pingOnLive: true, pingOnContent: true } });
    const i = click({ nick: 'فهودي' });
    await handleNotifyToggle(i, ctx.env, GUILD);
    expect(i.ops()).toEqual(['deferReply', 'editReply']);
    expect(i.calls[0]!.payload).toEqual({ flags: MessageFlags.Ephemeral });
    expect(ctx.toggle).toHaveBeenCalledWith(GUILD, USER, ROLE, 'زر إشعارات البثوث');
    const text = embedText(i.lastEmbed());
    expect(text).toContain('🔔 تم تفعيل الإشعارات');
    expect(text).toContain(`<@&${ROLE}>`);
    expect(text).toContain('أو ينزل مقطع جديد');
    expect(i.last().allowedMentions).toEqual({ parse: [], repliedUser: false });
    const audit = ctx.audits('notify.')[0]!;
    expect(audit).toMatchObject({ action: 'notify.subscribe', actor: `user:${USER}`, level: 'info' });
    expect(audit.message).toContain('فهودي');
  });

  it('removes the role and audits notify.unsubscribe (English guild)', async () => {
    const ctx = interactionContext({ toggle: { status: 'removed', roleName: 'Alerts' } });
    setFeatures(ctx.repos, { notifyRole: { roleId: ROLE }, language: 'en' });
    const i = click();
    await handleNotifyToggle(i, ctx.env, GUILD);
    expect(ctx.toggle).toHaveBeenCalledWith(GUILD, USER, ROLE, 'Stream alerts button');
    expect(i.lastEmbed().title).toBe('🔕 Alerts off');
    expect(i.lastEmbed().description).toContain('Press the same button any time');
    expect(ctx.audits('notify.').map((a) => a.action)).toEqual(['notify.unsubscribe']);
  });

  it('turns every failure into a clear message and never audits a change that did not happen', async () => {
    for (const [status, expected] of [
      ['config', 'إعدادات الرتبة فيها مشكلة'],
      ['transient', 'ديسكورد ما رد علينا'],
      ['not_member', 'ما لقيتك في السيرفر'],
    ] as const) {
      const ctx = interactionContext({ toggle: { status } });
      setFeatures(ctx.repos, { notifyRole: { roleId: ROLE } });
      const i = click();
      await handleNotifyToggle(i, ctx.env, GUILD);
      expect(i.lastEmbed().description).toContain(expected);
      expect(i.lastEmbed().title).toBe('⚠️ ما تمت العملية');
      expect(ctx.audits('notify.')).toEqual([]);
    }
  });

  it('gives up quietly when the interaction expired before it could be deferred', async () => {
    const ctx = interactionContext();
    setFeatures(ctx.repos, { notifyRole: { roleId: ROLE } });
    const i = click();
    i.failDefer = true;
    await handleNotifyToggle(i, ctx.env, GUILD);
    expect(ctx.toggle).not.toHaveBeenCalled();
    expect(i.calls).toEqual([]);
  });

  it('refuses to toggle the Streamer / Streaming Now role (misconfiguration guard)', async () => {
    const ctx = interactionContext();
    setFeatures(ctx.repos, { notifyRole: { roleId: ROLE } }, { liveRoleId: ROLE });
    const i = click();
    await handleNotifyToggle(i, ctx.env, GUILD);
    expect(ctx.toggle).not.toHaveBeenCalled();
    expect(i.lastEmbed().description).toContain('مو مضبوطة صح');
  });

  it('describes a role-only toggle when no pings are configured', async () => {
    const ctx = interactionContext({ toggle: { status: 'added', roleName: 'Alerts' } });
    setFeatures(ctx.repos, { notifyRole: { roleId: ROLE, pingOnLive: false, pingOnContent: false } });
    const i = click();
    await handleNotifyToggle(i, ctx.env, GUILD);
    expect(i.lastEmbed().description).toContain(`أخذت رتبة <@&${ROLE}>.`);
  });
});
