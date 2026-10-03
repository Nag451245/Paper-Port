#!/bin/bash
# Nightly database backup (installed in cron by deploy-latest.sh).
#
#   ~/capital-guard/deploy/backup-db.sh
#
# Writes ~/backups/db-<date>-<time>.sql.gz and deletes backups older than
# KEEP_DAYS, so backups can never fill the disk. If BACKUP_BUCKET is set in
# server/.env (e.g. BACKUP_BUCKET=gs://my-capitalguard-backups), each backup is
# also copied there, so losing the VM does not lose the data.
set -euo pipefail
APP=~/capital-guard
KEEP_DAYS=14
mkdir -p ~/backups
DB_URL=$(grep -E '^DATABASE_URL=' "$APP/server/.env" | cut -d= -f2- | tr -d '"' | sed 's/?.*//')
FILE=~/backups/db-$(date +%F-%H%M).sql.gz
pg_dump "$DB_URL" | gzip > "$FILE"
# A dump that is suspiciously small means pg_dump failed part-way: keep the old ones.
if [ "$(stat -c %s "$FILE")" -lt 1024 ]; then
  echo "$(date) backup too small, kept older backups: $FILE" >&2
  exit 1
fi
find ~/backups -name 'db-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
BUCKET=$(grep -E '^BACKUP_BUCKET=' "$APP/server/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
if [ -n "${BUCKET:-}" ]; then
  gsutil -q cp "$FILE" "$BUCKET/" || echo "$(date) copy to $BUCKET failed" >&2
fi
echo "$(date) backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
