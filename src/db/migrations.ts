/**
 * Ordered schema migrations. Never edit a shipped migration — append a new one.
 * All timestamps are ISO-8601 strings (UTC). JSON columns are TEXT.
 */
export const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'initial',
    sql: /* sql */ `
      CREATE TABLE guild_settings (
        guild_id            TEXT PRIMARY KEY,
        streamer_role_id    TEXT,
        live_role_id        TEXT,
        live_channel_id     TEXT,
        content_channel_id  TEXT,
        log_channel_id      TEXT,
        ping_mode           TEXT NOT NULL DEFAULT 'none',      -- none | everyone | here | role
        ping_role_id        TEXT,
        platforms_enabled   TEXT NOT NULL DEFAULT '["twitch","kick","youtube","tiktok"]',
        content_kinds       TEXT NOT NULL DEFAULT '["video","short","vod","highlight","clip"]',
        templates           TEXT NOT NULL DEFAULT '{}',
        options             TEXT NOT NULL DEFAULT '{}',
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );

      CREATE TABLE streamers (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id         TEXT NOT NULL,
        discord_user_id  TEXT NOT NULL,
        display_name     TEXT NOT NULL,
        notes            TEXT,
        color            INTEGER,
        enabled          INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        UNIQUE (guild_id, discord_user_id)
      );

      -- Platform channels, deduplicated across guilds/streamers.
      CREATE TABLE channels (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        platform               TEXT NOT NULL,
        platform_id            TEXT NOT NULL,
        handle                 TEXT NOT NULL,
        display_name           TEXT NOT NULL,
        avatar_url             TEXT,
        url                    TEXT NOT NULL,
        meta                   TEXT NOT NULL DEFAULT '{}',
        is_live                INTEGER NOT NULL DEFAULT 0,
        live_snapshot          TEXT,
        live_since             TEXT,
        offline_since          TEXT,
        miss_count             INTEGER NOT NULL DEFAULT 0,
        last_live_check_at     TEXT,
        content_seeded         INTEGER NOT NULL DEFAULT 0,
        last_content_check_at  TEXT,
        last_error             TEXT,
        error_count            INTEGER NOT NULL DEFAULT 0,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL,
        UNIQUE (platform, platform_id)
      );

      CREATE TABLE streamer_accounts (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        streamer_id     INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
        channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        notify_live     INTEGER NOT NULL DEFAULT 1,
        notify_content  INTEGER NOT NULL DEFAULT 1,
        content_kinds   TEXT,                         -- NULL = inherit guild setting
        created_at      TEXT NOT NULL,
        UNIQUE (streamer_id, channel_id)
      );
      CREATE INDEX idx_accounts_channel ON streamer_accounts(channel_id);

      -- One aggregated live session per streamer (across all platforms) per guild.
      CREATE TABLE live_sessions (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id            TEXT NOT NULL,
        streamer_id         INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
        status              TEXT NOT NULL DEFAULT 'live',  -- live | ended
        started_at          TEXT NOT NULL,
        ended_at            TEXT,
        message_channel_id  TEXT,
        message_id          TEXT,
        peak_viewers        INTEGER NOT NULL DEFAULT 0,
        viewer_sum          INTEGER NOT NULL DEFAULT 0,
        viewer_samples      INTEGER NOT NULL DEFAULT 0,
        categories          TEXT NOT NULL DEFAULT '[]',  -- [{name, imageUrl, firstSeenAt, seconds}]
        titles              TEXT NOT NULL DEFAULT '[]',  -- distinct titles in order
        last_message_update TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_streamer ON live_sessions(streamer_id, status);
      CREATE INDEX idx_sessions_guild ON live_sessions(guild_id, started_at);

      -- Per-platform segment inside a session.
      CREATE TABLE live_segments (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        channel_id    INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        platform      TEXT NOT NULL,
        stream_id     TEXT,
        started_at    TEXT NOT NULL,
        ended_at      TEXT,
        peak_viewers  INTEGER NOT NULL DEFAULT 0,
        last_viewers  INTEGER,
        vod_url       TEXT
      );
      CREATE INDEX idx_segments_session ON live_segments(session_id);

      CREATE TABLE content_items (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id     INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        content_id     TEXT NOT NULL,
        kind           TEXT NOT NULL,
        title          TEXT NOT NULL,
        url            TEXT NOT NULL,
        thumbnail_url  TEXT,
        published_at   TEXT NOT NULL,
        first_seen_at  TEXT NOT NULL,
        announced      INTEGER NOT NULL DEFAULT 0,      -- 0 = seeded silently / filtered, 1 = announced somewhere
        UNIQUE (channel_id, content_id)
      );

      CREATE TABLE content_notifications (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        content_item_id     INTEGER NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
        guild_id            TEXT NOT NULL,
        streamer_id         INTEGER,
        message_channel_id  TEXT,
        message_id          TEXT,
        created_at          TEXT NOT NULL,
        UNIQUE (content_item_id, guild_id)
      );

      CREATE TABLE audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT,
        actor       TEXT NOT NULL,          -- 'system' | 'user:<discordId>'
        action      TEXT NOT NULL,          -- e.g. 'streamer.create', 'live.start', 'role.add'
        level       TEXT NOT NULL DEFAULT 'info', -- info | warn | error
        message     TEXT NOT NULL,
        details     TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_audit_guild ON audit_log(guild_id, id);

      CREATE TABLE web_sessions (
        id           TEXT PRIMARY KEY,      -- sha256(token)
        user_id      TEXT NOT NULL,
        username     TEXT NOT NULL,
        avatar_url   TEXT,
        guilds       TEXT NOT NULL DEFAULT '[]', -- [{id, name, icon, permissions}]
        guilds_refreshed_at TEXT NOT NULL,
        access_token TEXT,
        created_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL
      );

      CREATE TABLE kv (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `,
  },
];
