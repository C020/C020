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
  {
    id: 2,
    name: 'summary_pending',
    sql: /* sql */ `
      -- 1 while a post-stream summary still has to be published (a Discord failure must not leave the LIVE message up).
      ALTER TABLE live_sessions ADD COLUMN summary_pending INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE live_sessions ADD COLUMN summary_attempts INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 3,
    name: 'features_v2',
    sql: /* sql */ `
      ALTER TABLE guild_settings ADD COLUMN features TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE streamers ADD COLUMN templates TEXT NOT NULL DEFAULT '{}';

      -- #13 viewer samples per session
      CREATE TABLE live_samples (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id     INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        at             TEXT NOT NULL,
        total_viewers  INTEGER,
        platforms      TEXT NOT NULL DEFAULT '{}',
        category       TEXT
      );
      CREATE INDEX idx_samples_session ON live_samples(session_id, at);

      -- #9 streamer applications
      CREATE TABLE applications (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id           TEXT NOT NULL,
        user_id            TEXT NOT NULL,
        username           TEXT NOT NULL,
        accounts           TEXT NOT NULL DEFAULT '[]',
        note               TEXT,
        status             TEXT NOT NULL DEFAULT 'pending',
        reviewer_id        TEXT,
        review_note        TEXT,
        streamer_id        INTEGER,
        review_channel_id  TEXT,
        review_message_id  TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        decided_at         TEXT
      );
      CREATE INDEX idx_applications_guild ON applications(guild_id, status, id);
      -- at most one pending application per member and guild
      CREATE UNIQUE INDEX idx_applications_pending ON applications(guild_id, user_id) WHERE status = 'pending';

      -- #11 official account links
      CREATE TABLE account_links (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_user_id     TEXT NOT NULL,
        platform            TEXT NOT NULL,
        platform_user_id    TEXT NOT NULL,
        platform_login      TEXT,
        display_name        TEXT,
        access_token_enc    TEXT,
        refresh_token_enc   TEXT,
        scopes              TEXT NOT NULL DEFAULT '[]',
        access_expires_at   TEXT,
        refresh_expires_at  TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        UNIQUE (discord_user_id, platform)
      );
      CREATE INDEX idx_links_platform_user ON account_links(platform, platform_user_id);

      -- interactive panels posted by the bot
      CREATE TABLE panels (
        guild_id    TEXT NOT NULL,
        kind        TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        message_id  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (guild_id, kind)
      );

      -- #15 roles given because of a Discord Streaming presence
      CREATE TABLE presence_grants (
        guild_id            TEXT NOT NULL,
        user_id             TEXT NOT NULL,
        started_at          TEXT NOT NULL,
        url                 TEXT,
        platform            TEXT,
        title               TEXT,
        game                TEXT,
        message_channel_id  TEXT,
        message_id          TEXT,
        PRIMARY KEY (guild_id, user_id)
      );

      -- #6 daily clip digest queue
      CREATE TABLE digest_queue (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id         TEXT NOT NULL,
        content_item_id  INTEGER NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
        streamer_id      INTEGER,
        queued_at        TEXT NOT NULL,
        posted_at        TEXT,
        UNIQUE (guild_id, content_item_id)
      );
      CREATE INDEX idx_digest_pending ON digest_queue(guild_id, posted_at);
    `,
  },
];
