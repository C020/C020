#!/usr/bin/env bash
# Online SQLite backup (safe while the bot runs). Usage: ./deploy/backup.sh [backup-dir]
# Cron example (daily 04:00):  0 4 * * * cd /opt/stream-bot && ./deploy/backup.sh >> backup.log 2>&1
set -euo pipefail
DIR="${1:-./backups}"
mkdir -p "$DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
docker compose exec -T bot node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/app/data/bot.db');
  db.exec(\"VACUUM INTO '/app/data/backup-$STAMP.db'\");
"
mv "./data/backup-$STAMP.db" "$DIR/bot-$STAMP.db"
# keep the last 14 backups
ls -1t "$DIR"/bot-*.db | tail -n +15 | xargs -r rm --
echo "Backup written to $DIR/bot-$STAMP.db"
