/**
 * #9 — streamer applications in Discord: the apply modal, the reviewers' message (approve/reject buttons) and
 * the reject-reason modal. Validation and state changes belong to ApplicationService; this module only renders
 * and routes. Reviewer buttons are re-checked here (Manage Server, plus Manage Roles to approve when the guild
 * hands out a Streamer role) because anybody who can see the review channel can click them.
 */
import type { APIEmbed, APIEmbedField, APIModalInteractionResponseCallbackData } from 'discord.js';
import { ButtonStyle, ComponentType, PermissionFlagsBits, TextInputStyle } from 'discord.js';
import { childLogger } from '../../core/logger.js';
import { type Platform, PLATFORM_LABELS, PLATFORMS } from '../../core/types.js';
import type { ApplicationStatus, GuildSettings, Language, StreamerApplication } from '../../db/models.js';
import { COLORS, embed } from '../commands/replies.js';
import { DEFAULT_PLATFORM_EMOJIS, type PlatformEmojis } from '../emojis.js';
import { cleanText, discordTimestamp, escapeMarkdown, safeUrl, truncate } from '../format.js';
import { guildLanguage, ti } from '../i18n/interactions.js';
import { DISCORD_LIMITS } from '../templates.js';
import { CustomIds, ModalFields } from './ids.js';
import { deferEphemeral, failureEmbed, memberDisplayName, replyEphemeral, replyError, warnEmbed } from './reply.js';
import type { ComponentInteraction, InteractionEnv, InteractiveMessage } from './types.js';

const log = childLogger('discord.applications');

export const ACCOUNT_INPUT_MAX = 200;
export const NOTE_MAX = 500;
const MODAL_TITLE_MAX = 45;

const STATUS_COLORS: Record<ApplicationStatus, number> = {
  pending: COLORS.warn,
  approved: COLORS.success,
  rejected: COLORS.error,
  cancelled: 0x80848e,
};

const PLACEHOLDERS: Record<Platform, string> = {
  twitch: 'twitch.tv/username',
  kick: 'kick.com/username',
  youtube: 'youtube.com/@channel',
  tiktok: 'tiktok.com/@username',
};

export function statusLabel(status: ApplicationStatus, lang: Language): string {
  return ti(lang, `review.status.${status}`);
}

// ───────────────────────────── modals ─────────────────────────────

function textInputLabel(label: string, description: string, input: { id: string; style: TextInputStyle; max: number; placeholder?: string }) {
  return {
    type: ComponentType.Label as const,
    label: truncate(label, 45),
    description: truncate(description, 100),
    component: {
      type: ComponentType.TextInput as const,
      custom_id: input.id,
      style: input.style,
      required: false,
      max_length: input.max,
      ...(input.placeholder ? { placeholder: truncate(input.placeholder, 100) } : {}),
    },
  };
}

/** The application form: one optional field per platform (handle or URL) + an optional note. */
export function buildApplyModal(lang: Language): APIModalInteractionResponseCallbackData {
  return {
    custom_id: CustomIds.applySubmit,
    title: truncate(ti(lang, 'apply.modal.title'), MODAL_TITLE_MAX),
    components: [
      ...PLATFORMS.map((platform) =>
        textInputLabel(PLATFORM_LABELS[platform], ti(lang, 'apply.modal.account.desc'), {
          id: ModalFields[platform],
          style: TextInputStyle.Short,
          max: ACCOUNT_INPUT_MAX,
          placeholder: PLACEHOLDERS[platform],
        }),
      ),
      textInputLabel(ti(lang, 'apply.modal.note'), ti(lang, 'apply.modal.note.desc'), { id: ModalFields.note, style: TextInputStyle.Paragraph, max: NOTE_MAX }),
    ],
  };
}

export function buildRejectModal(lang: Language, applicationId: number): APIModalInteractionResponseCallbackData {
  return {
    custom_id: CustomIds.applyRejectReason(applicationId),
    title: truncate(ti(lang, 'review.rejectModal.title'), MODAL_TITLE_MAX),
    components: [
      textInputLabel(ti(lang, 'review.rejectModal.reason'), ti(lang, 'review.rejectModal.reason.desc'), {
        id: ModalFields.reason,
        style: TextInputStyle.Paragraph,
        max: NOTE_MAX,
      }),
    ],
  };
}

/** A modal text value: trimmed, cut to `max`, null when empty or missing. */
export function modalValue(interaction: Pick<ComponentInteraction, 'fields'>, id: string, max: number): string | null {
  try {
    const value = interaction.fields?.getTextInputValue(id);
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : null;
  } catch {
    return null;
  }
}

// ───────────────────────────── review message ─────────────────────────────

const HANDLE_RE = /^@?[A-Za-z0-9_.-]{1,100}$/;
const YOUTUBE_CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

/** Best-effort profile link for what the applicant typed (a URL or a handle). */
export function accountUrl(platform: Platform, input: string): string | null {
  const raw = input.trim();
  if (/^https?:\/\//i.test(raw)) return safeUrl(raw);
  if (!HANDLE_RE.test(raw)) return null;
  const handle = raw.replace(/^@/, '');
  switch (platform) {
    case 'twitch':
      return `https://www.twitch.tv/${handle}`;
    case 'kick':
      return `https://kick.com/${handle}`;
    case 'youtube':
      return YOUTUBE_CHANNEL_ID_RE.test(handle) ? `https://www.youtube.com/channel/${handle}` : `https://www.youtube.com/@${handle}`;
    case 'tiktok':
      return `https://www.tiktok.com/@${handle}`;
    default:
      return null;
  }
}

function accountLine(account: { platform: Platform; input: string }, emojis: PlatformEmojis): string {
  const emoji = (emojis[account.platform] ?? DEFAULT_PLATFORM_EMOJIS[account.platform]).text;
  const label = escapeMarkdown(truncate(cleanText(account.input), 80)) || '—';
  const url = accountUrl(account.platform, account.input);
  const link = url ? `[${label}](${url.replace(/\(/g, '%28').replace(/\)/g, '%29')})` : label;
  return `${emoji} **${PLATFORM_LABELS[account.platform]}:** ${link}`;
}

export function accountLines(accounts: StreamerApplication['accounts'], emojis: PlatformEmojis = DEFAULT_PLATFORM_EMOJIS): string {
  return accounts.map((a) => accountLine(a, emojis)).join('\n');
}

/** The reviewers' message: applicant, accounts, note, status; approve/reject buttons while pending. */
export function buildApplicationReviewMessage(
  application: StreamerApplication,
  settings: GuildSettings,
  emojis: PlatformEmojis = DEFAULT_PLATFORM_EMOJIS,
): InteractiveMessage {
  const lang = guildLanguage(settings);
  const status = statusLabel(application.status, lang);
  const fields: APIEmbedField[] = [
    {
      name: ti(lang, 'review.applicant'),
      value: truncate(`<@${application.userId}>\n${escapeMarkdown(application.username) || application.userId}`, DISCORD_LIMITS.fieldValue),
      inline: true,
    },
  ];
  const decided = application.status !== 'pending';
  const when = discordTimestamp(application.decidedAt ?? application.updatedAt, 'R') ?? '';
  const statusValue =
    decided && application.reviewerId && application.status !== 'cancelled'
      ? ti(lang, 'review.decidedBy', { status, reviewer: `<@${application.reviewerId}>`, when }).trim()
      : decided && when
        ? `${status} ${when}`
        : status;
  fields.push({ name: ti(lang, 'review.status'), value: truncate(statusValue, DISCORD_LIMITS.fieldValue), inline: true });
  fields.push({ name: ti(lang, 'review.accounts'), value: truncate(accountLines(application.accounts, emojis) || '—', DISCORD_LIMITS.fieldValue), inline: false });
  if (application.note) {
    fields.push({ name: ti(lang, 'review.note'), value: truncate(escapeMarkdown(application.note) || '—', DISCORD_LIMITS.fieldValue), inline: false });
  }
  if (application.reviewNote && decided) {
    fields.push({
      name: ti(lang, application.status === 'rejected' ? 'review.reason' : 'review.reviewNote'),
      value: truncate(escapeMarkdown(application.reviewNote) || '—', DISCORD_LIMITS.fieldValue),
      inline: false,
    });
  }
  const card: APIEmbed = {
    color: STATUS_COLORS[application.status],
    title: ti(lang, 'review.title'),
    fields,
    footer: { text: ti(lang, 'review.footer', { id: application.id }) },
  };
  const created = Date.parse(application.createdAt);
  if (Number.isFinite(created)) card.timestamp = new Date(created).toISOString();

  return {
    content: '',
    embeds: [card],
    components: decided
      ? []
      : [
          {
            type: ComponentType.ActionRow,
            components: [
              { type: ComponentType.Button, style: ButtonStyle.Success, custom_id: CustomIds.applyApprove(application.id), label: ti(lang, 'review.approve'), emoji: { name: '✅' } },
              { type: ComponentType.Button, style: ButtonStyle.Danger, custom_id: CustomIds.applyReject(application.id), label: ti(lang, 'review.reject'), emoji: { name: '❌' } },
            ],
          },
        ],
  };
}

// ───────────────────────────── handlers ─────────────────────────────

const actorOf = (interaction: ComponentInteraction): string => `user:${interaction.user.id}`;

/** Re-renders the review message from the stored application (best effort, never throws). */
async function refreshReview(env: InteractionEnv, application: StreamerApplication, settings: GuildSettings): Promise<void> {
  try {
    const current = env.services.repos.applications.get(application.id) ?? application;
    await env.upsertApplicationReview(current, settings);
  } catch (err) {
    log.warn({ err, applicationId: application.id }, 'Refreshing the review message failed');
  }
}

/** Button sb:apply:open → explanation or the application modal (must answer within 3s: no I/O before showModal). */
export async function handleApplyOpen(interaction: ComponentInteraction, env: InteractionEnv, guildId: string): Promise<void> {
  const { repos, applications } = env.services;
  const settings = repos.settings.get(guildId);
  const lang = guildLanguage(settings);
  if (!settings.features.applications.enabled) {
    await replyEphemeral(interaction, { embeds: [warnEmbed(ti(lang, 'apply.disabled'))] });
    return;
  }
  if (!applications) {
    await replyEphemeral(interaction, { embeds: [warnEmbed(ti(lang, 'common.unavailable'))] });
    return;
  }
  const userId = interaction.user.id;
  if (repos.streamers.getByDiscordId(guildId, userId)) {
    await replyEphemeral(interaction, { embeds: [embed(COLORS.info, 'ℹ️', ti(lang, 'apply.registered'))] });
    return;
  }
  const pending = repos.applications.pendingFor(guildId, userId);
  if (pending) {
    await replyEphemeral(interaction, { embeds: [embed(COLORS.info, '⏳', ti(lang, 'apply.pending', { when: discordTimestamp(pending.createdAt, 'R') ?? '' }))] });
    return;
  }
  if (!interaction.showModal) {
    await replyEphemeral(interaction, { embeds: [warnEmbed(ti(lang, 'common.expired'))] });
    return;
  }
  try {
    await interaction.showModal(buildApplyModal(lang));
  } catch (err) {
    log.warn({ err, guildId, userId }, 'Could not open the application modal');
  }
}

/** Modal sb:apply:submit → ApplicationService.submit → ephemeral confirmation (+ review message). */
export async function handleApplySubmit(interaction: ComponentInteraction, env: InteractionEnv, guildId: string): Promise<void> {
  const { repos, applications } = env.services;
  const settings = repos.settings.get(guildId);
  const lang = guildLanguage(settings);
  if (!applications) {
    await replyEphemeral(interaction, { embeds: [warnEmbed(ti(lang, 'common.unavailable'))] });
    return;
  }
  // Applications may have been closed while the member was typing.
  if (!settings.features.applications.enabled) {
    await replyEphemeral(interaction, { embeds: [warnEmbed(ti(lang, 'apply.disabled'))] });
    return;
  }
  const accounts = PLATFORMS.flatMap((platform) => {
    const input = modalValue(interaction, ModalFields[platform], ACCOUNT_INPUT_MAX);
    return input ? [{ platform, input }] : [];
  });
  const note = modalValue(interaction, ModalFields.note, NOTE_MAX);
  if (accounts.length === 0) {
    await replyEphemeral(interaction, { embeds: [warnEmbed(ti(lang, 'apply.noAccounts'))] });
    return;
  }
  if (!(await deferEphemeral(interaction))) return;

  let application: StreamerApplication;
  try {
    application = await applications.submit(guildId, { userId: interaction.user.id, username: memberDisplayName(interaction), accounts, note });
  } catch (err) {
    await replyError(interaction, err, lang);
    return;
  }

  const parts = [ti(lang, 'apply.received.body')];
  if (settings.features.applications.dmApplicant) parts.push(ti(lang, 'apply.received.dm'));
  parts.push('', ti(lang, 'apply.received.accounts'), accountLines(application.accounts.length > 0 ? application.accounts : accounts, env.emojis()));
  await replyEphemeral(interaction, { embeds: [embed(COLORS.success, ti(lang, 'apply.received.title'), parts.join('\n'))] });

  // ApplicationService posts the review message; make sure reviewers see it even when that did not happen.
  const stored = repos.applications.get(application.id);
  if (stored && stored.status === 'pending' && !stored.reviewMessageId && settings.features.applications.reviewChannelId) {
    await refreshReview(env, stored, settings);
  }
}

type ReviewerCheck = { ok: true } | { ok: false; message: string };

function checkReviewer(interaction: ComponentInteraction, settings: GuildSettings, lang: Language, approving: boolean): ReviewerCheck {
  const perms = interaction.memberPermissions;
  if (!perms?.has(PermissionFlagsBits.ManageGuild)) return { ok: false, message: ti(lang, 'review.noPermission') };
  if (approving && settings.streamerRoleId && !perms.has(PermissionFlagsBits.ManageRoles)) return { ok: false, message: ti(lang, 'review.needManageRoles') };
  return { ok: true };
}

/** Loads the application of this guild; replies with the reason and returns null when it cannot be handled. */
async function loadPending(
  interaction: ComponentInteraction,
  env: InteractionEnv,
  guildId: string,
  applicationId: number,
  settings: GuildSettings,
  lang: Language,
): Promise<StreamerApplication | null> {
  const applications = env.services.applications!;
  let application: StreamerApplication;
  try {
    application = applications.get(guildId, applicationId);
  } catch (err) {
    await replyError(interaction, err, lang);
    return null;
  }
  if (application.status !== 'pending') {
    await replyEphemeral(interaction, { embeds: [warnEmbed(ti(lang, 'review.alreadyDecided', { status: statusLabel(application.status, lang) }))] });
    // The message may still show buttons (e.g. decided in the dashboard while Discord was unreachable).
    await refreshReview(env, application, settings);
    return null;
  }
  return application;
}

/** Button sb:apply:approve:<id>. */
export async function handleApprove(interaction: ComponentInteraction, env: InteractionEnv, guildId: string, applicationId: number): Promise<void> {
  const settings = env.services.repos.settings.get(guildId);
  const lang = guildLanguage(settings);
  const applications = env.services.applications;
  if (!applications) {
    await replyEphemeral(interaction, { embeds: [warnEmbed(ti(lang, 'common.unavailable'))] });
    return;
  }
  const check = checkReviewer(interaction, settings, lang, true);
  if (!check.ok) {
    await replyEphemeral(interaction, { embeds: [failureEmbed(check.message, lang)] });
    return;
  }
  // Approving resolves every account on its platform: always slower than 3 seconds' worth of safety.
  if (!(await deferEphemeral(interaction))) return;
  const pending = await loadPending(interaction, env, guildId, applicationId, settings, lang);
  if (!pending) return;

  let result: Awaited<ReturnType<typeof applications.approve>>;
  try {
    result = await applications.approve(guildId, applicationId, actorOf(interaction));
  } catch (err) {
    await replyError(interaction, err, lang);
    return;
  }
  await refreshReview(env, result.application, settings);

  const lines = [ti(lang, 'review.approved.body')];
  if (result.skipped.length > 0) {
    lines.push('', ti(lang, 'review.approved.skipped'));
    for (const skipped of result.skipped) {
      lines.push(`• **${PLATFORM_LABELS[skipped.platform] ?? skipped.platform}** (${escapeMarkdown(truncate(skipped.input, 80))}): ${escapeMarkdown(truncate(skipped.reason, 200))}`);
    }
  }
  const name = cleanText(result.streamer.displayName) || pending.username;
  await replyEphemeral(interaction, {
    embeds: [embed(result.skipped.length > 0 ? COLORS.warn : COLORS.success, ti(lang, 'review.approved.title', { name }), lines.join('\n'))],
  });
}

/** Button sb:apply:reject:<id> → the reject-reason modal (no I/O before showModal). */
export async function handleReject(interaction: ComponentInteraction, env: InteractionEnv, guildId: string, applicationId: number): Promise<void> {
  const settings = env.services.repos.settings.get(guildId);
  const lang = guildLanguage(settings);
  const applications = env.services.applications;
  if (!applications) {
    await replyEphemeral(interaction, { embeds: [warnEmbed(ti(lang, 'common.unavailable'))] });
    return;
  }
  const check = checkReviewer(interaction, settings, lang, false);
  if (!check.ok) {
    await replyEphemeral(interaction, { embeds: [failureEmbed(check.message, lang)] });
    return;
  }
  let application: StreamerApplication;
  try {
    application = applications.get(guildId, applicationId);
  } catch (err) {
    await replyError(interaction, err, lang);
    return;
  }
  if (application.status !== 'pending') {
    await replyEphemeral(interaction, { embeds: [warnEmbed(ti(lang, 'review.alreadyDecided', { status: statusLabel(application.status, lang) }))] });
    await refreshReview(env, application, settings);
    return;
  }
  if (!interaction.showModal) {
    await replyEphemeral(interaction, { embeds: [warnEmbed(ti(lang, 'common.expired'))] });
    return;
  }
  try {
    await interaction.showModal(buildRejectModal(lang, applicationId));
  } catch (err) {
    log.warn({ err, guildId, applicationId }, 'Could not open the reject modal');
  }
}

/** Modal sb:apply:rejectreason:<id> → ApplicationService.reject. */
export async function handleRejectReason(interaction: ComponentInteraction, env: InteractionEnv, guildId: string, applicationId: number): Promise<void> {
  const settings = env.services.repos.settings.get(guildId);
  const lang = guildLanguage(settings);
  const applications = env.services.applications;
  if (!applications) {
    await replyEphemeral(interaction, { embeds: [warnEmbed(ti(lang, 'common.unavailable'))] });
    return;
  }
  // Permissions may have changed while the modal was open.
  const check = checkReviewer(interaction, settings, lang, false);
  if (!check.ok) {
    await replyEphemeral(interaction, { embeds: [failureEmbed(check.message, lang)] });
    return;
  }
  if (!(await deferEphemeral(interaction))) return;
  const pending = await loadPending(interaction, env, guildId, applicationId, settings, lang);
  if (!pending) return;
  const reason = modalValue(interaction, ModalFields.reason, NOTE_MAX);
  let rejected: StreamerApplication;
  try {
    rejected = await applications.reject(guildId, applicationId, actorOf(interaction), reason);
  } catch (err) {
    await replyError(interaction, err, lang);
    return;
  }
  await refreshReview(env, rejected, settings);
  await replyEphemeral(interaction, {
    embeds: [embed(COLORS.error, ti(lang, 'review.rejected.title'), reason ? ti(lang, 'review.rejected.reason', { reason: escapeMarkdown(reason) }) : undefined)],
  });
}
