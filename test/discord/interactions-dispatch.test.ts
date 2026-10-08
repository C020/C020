import { describe, expect, it } from 'vitest';
import { dispatchComponent, isOwnComponent } from '../../src/discord/interactions/dispatch.js';
import { CustomIds } from '../../src/discord/interactions/ids.js';
import { FakeInteraction, GUILD, interactionContext, setFeatures, USER } from './interactionHelpers.js';

const ROLE = '700000000000000060';

describe('dispatchComponent', () => {
  it('ignores components that are not ours (no response at all)', async () => {
    const ctx = interactionContext();
    const i = new FakeInteraction('poll:vote:1', 'button');
    await dispatchComponent(i, ctx.env);
    expect(i.calls).toEqual([]);
    expect(isOwnComponent('sb:notify:toggle')).toBe(true);
    expect(isOwnComponent(null)).toBe(false);
  });

  it('answers outside servers, before services are attached and for outdated buttons', async () => {
    const ctx = interactionContext();
    const dm = new FakeInteraction(CustomIds.notifyToggle, 'button', { guildId: null });
    await dispatchComponent(dm, ctx.env);
    expect(dm.lastEmbed().description).toContain('داخل السيرفر');

    const early = new FakeInteraction(CustomIds.notifyToggle, 'button');
    await dispatchComponent(early, null);
    expect(early.lastEmbed().title).toBe('⏳ البوت لسا يجهز');

    setFeatures(ctx.repos, { language: 'en' });
    const outdated = new FakeInteraction('sb:old:thing', 'button');
    await dispatchComponent(outdated, ctx.env);
    expect(outdated.lastEmbed().description).toBe('This button is outdated and no longer works');

    // A modal id arriving as a button (forged/odd client) is not routed.
    const mismatch = new FakeInteraction(CustomIds.applySubmit, 'button');
    await dispatchComponent(mismatch, ctx.env);
    expect(mismatch.lastEmbed().description).toBe('This button is outdated and no longer works');
  });

  it('routes the notify toggle and application buttons/modals', async () => {
    const ctx = interactionContext({ toggle: { status: 'added', roleName: 'Alerts' } });
    setFeatures(ctx.repos, { notifyRole: { roleId: ROLE }, applications: { enabled: true } });
    const toggle = new FakeInteraction(CustomIds.notifyToggle, 'button');
    await dispatchComponent(toggle, ctx.env);
    expect(ctx.toggle).toHaveBeenCalledWith(GUILD, USER, ROLE, expect.any(String));

    const open = new FakeInteraction(CustomIds.applyOpen, 'button');
    await dispatchComponent(open, ctx.env);
    expect(open.ops()).toEqual(['showModal']);

    const submit = new FakeInteraction(CustomIds.applySubmit, 'modal', { fields: { kick: 'abufahad' } });
    await dispatchComponent(submit, ctx.env);
    expect(ctx.repos.applications.list(GUILD)).toHaveLength(1);
  });

  it('turns an unexpected handler error into a generic ephemeral error', async () => {
    const ctx = interactionContext();
    ctx.env.toggleRole = async () => {
      throw new Error('SQLITE_BUSY');
    };
    setFeatures(ctx.repos, { notifyRole: { roleId: ROLE } });
    const i = new FakeInteraction(CustomIds.notifyToggle, 'button');
    await dispatchComponent(i, ctx.env);
    expect(i.lastEmbed().description).toContain('صار خطأ غير متوقع');
    expect(i.lastEmbed().description).not.toContain('SQLITE');
  });
});
