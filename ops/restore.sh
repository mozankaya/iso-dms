#!/usr/bin/env bash
# Puts a backup (made by ops/backup.sh) back into the production stack.
#
#   ops/restore.sh backups/2026-10-09_020000          asks before it does anything
#   ops/restore.sh backups/2026-10-09_020000 --yes    does not ask (for a script)
#
# It REPLACES the database with the one in the backup (what was added after that backup is gone from the database),
# and copies the backup's files into the storage. It deletes no file: files that are in the storage but not in the
# backup stay as unused extras. The application is stopped meanwhile and started again at the end, which also
# brings the database up to date if this version of the application is newer than the backup.
#
# To try a backup without touching production, use ops/restore-drill.sh.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
cd "$ROOT"

BACKUP="${1:-}"
[ -n "$BACKUP" ] && [ -d "$BACKUP" ] || die "usage: ops/restore.sh <backup directory> [--yes]"
BACKUP="$(cd "$BACKUP" && pwd)"
ASSUME_YES=false
[ "${2:-}" = "--yes" ] && ASSUME_YES=true

AWS_KEY="$(envval S3_ACCESS_KEY)"; AWS_SECRET="$(envval S3_SECRET_KEY)"; BUCKET="$(envval S3_BUCKET documents)"
AWS_ENDPOINT="http://storage:9000"

log "checking the backup"
verify_backup_files "$BACKUP"
[ -f "$BACKUP/db.dump" ] && [ -f "$BACKUP/files.tar.gz" ] || die "the backup lacks db.dump or files.tar.gz"

echo
echo "  Backup:   $BACKUP"
echo "  Made:     $(grep -o '"createdAt":"[^"]*"' "$BACKUP/MANIFEST.json" | cut -d'"' -f4)"
echo "  Content:  $(grep -o '"objects":[0-9]*' "$BACKUP/MANIFEST.json" | cut -d: -f2) file(s)"
echo
echo "  The DATABASE of this installation will be REPLACED by the one in the backup."
echo "  Everything done in the application after the backup is lost from the database."
echo
if [ "$ASSUME_YES" != true ]; then
  read -r -p "  Type RESTORE to go on: " answer
  [ "$answer" = "RESTORE" ] || die "cancelled, nothing was changed"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

log "stopping the application"
dc stop web api >/dev/null
dc up -d postgres storage >/dev/null
for _ in $(seq 1 30); do
  dc exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d postgres' >/dev/null 2>&1 && break
  sleep 2
done

log "files"
tar -xzf "$BACKUP/files.tar.gz" -C "$WORK"
AWS_MOUNT="$WORK/files" aws_s3 s3 mb "s3://$BUCKET" >/dev/null 2>&1 || true
AWS_MOUNT="$WORK/files" aws_s3 s3 sync /data "s3://$BUCKET" --no-progress --only-show-errors

log "database"
dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\" WITH (FORCE)" -c "CREATE DATABASE \"$POSTGRES_DB\""' >/dev/null
dc exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < "$BACKUP/db.dump"

log "starting the application"
dc up -d >/dev/null
for _ in $(seq 1 60); do
  [ "$(dc ps --format '{{.Health}}' api 2>/dev/null | head -n1)" = "healthy" ] && break
  sleep 3
done

log "checking what was restored"
if dc exec -T api pnpm exec tsx prisma/verify-storage.ts; then
  log "RESTORED from $BACKUP"
else
  die "restored, but the check found problems (above). The application is running; decide before people use it."
fi
