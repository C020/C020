/** Discord-specific pure helpers (IDs, avatars, links). */

export const SNOWFLAKE_RE = /^\d{17,20}$/;

export function isSnowflake(value: string): boolean {
  return SNOWFLAKE_RE.test(value.trim());
}

/**
 * Pulls a user/role/channel ID out of whatever the admin pasted: a raw ID, a mention (<@123>, <@!123>,
 * <@&123>, <#123>) or a discord.com/users/123 link. Returns the trimmed input when nothing matches.
 */
export function extractSnowflake(input: string): string {
  const value = input.trim();
  const mention = /^<(?:@[!&]?|#)(\d{17,20})>$/.exec(value);
  if (mention?.[1]) return mention[1];
  const link = /discord(?:app)?\.com\/users\/(\d{17,20})/i.exec(value);
  if (link?.[1]) return link[1];
  const digits = value.replace(/[\s‎‏‪-‮]/g, '');
  return /^\d+$/.test(digits) ? digits : value;
}

/** Discord's default avatar for users without one (new username system: (id >> 22) % 6). */
export function defaultAvatarUrl(userId: string | null | undefined): string {
  let index = 0;
  if (userId && /^\d+$/.test(userId)) {
    try {
      index = Number((BigInt(userId) >> 22n) % 6n);
    } catch {
      index = 0;
    }
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/** Account creation time encoded in a snowflake. */
export function snowflakeDate(id: string): Date | null {
  if (!SNOWFLAKE_RE.test(id)) return null;
  try {
    return new Date(Number((BigInt(id) >> 22n) + 1_420_070_400_000n));
  } catch {
    return null;
  }
}

export function customEmojiUrl(id: string, animated: boolean): string {
  return `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'webp'}?size=48&quality=lossless`;
}

/** Developer Portal page where the bot's privileged intents are toggled. */
export const DEVELOPER_PORTAL_URL = 'https://discord.com/developers/applications';
