/**
 * Classification of Discord REST errors. Duck-typed on `code`/`status` (DiscordAPIError shape) so it works
 * with plain objects in tests and never depends on instanceof across package copies.
 */

export const DiscordErrorCodes = {
  UnknownChannel: 10003,
  UnknownGuild: 10004,
  UnknownMember: 10007,
  UnknownMessage: 10008,
  UnknownRole: 10011,
  UnknownUser: 10013,
  UnknownInteraction: 10062,
  InteractionAlreadyAcknowledged: 40060,
  MissingAccess: 50001,
  MissingPermissions: 50013,
  InvalidFormBody: 50035,
  ThreadArchived: 50083,
  ThreadLocked: 160005,
} as const;

export type DiscordErrorKind =
  /** The message no longer exists. */
  | 'unknown_message'
  /** The channel (or the whole guild) no longer exists / is unreachable. */
  | 'unknown_channel'
  | 'unknown_member'
  | 'unknown_role'
  /** Missing access / permissions (403). */
  | 'forbidden'
  /** Discord rejected the payload (bad URL, emoji, length...). */
  | 'invalid'
  /** Anything else: network, 5xx, timeouts. Usually transient. */
  | 'transient';

export function discordErrorCode(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}

function httpStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

export function classifyDiscordError(err: unknown): DiscordErrorKind {
  switch (discordErrorCode(err)) {
    case DiscordErrorCodes.UnknownMessage:
      return 'unknown_message';
    case DiscordErrorCodes.UnknownChannel:
    case DiscordErrorCodes.UnknownGuild:
      return 'unknown_channel';
    case DiscordErrorCodes.UnknownMember:
    case DiscordErrorCodes.UnknownUser:
      return 'unknown_member';
    case DiscordErrorCodes.UnknownRole:
      return 'unknown_role';
    case DiscordErrorCodes.MissingAccess:
    case DiscordErrorCodes.MissingPermissions:
    case DiscordErrorCodes.ThreadArchived:
    case DiscordErrorCodes.ThreadLocked:
      return 'forbidden';
    case DiscordErrorCodes.InvalidFormBody:
      return 'invalid';
    default:
      break;
  }
  const status = httpStatus(err);
  if (status === 403) return 'forbidden';
  if (status === 400) return 'invalid';
  return 'transient';
}

/** Short text for logs (never shown to users). */
export function describeDiscordError(err: unknown): string {
  const code = discordErrorCode(err);
  const message = err instanceof Error ? err.message : String(err);
  return code !== null ? `${code}: ${message}` : message;
}
