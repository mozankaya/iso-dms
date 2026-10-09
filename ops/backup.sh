#!/usr/bin/env bash
# Backs up the running production stack: the database (pg_dump) and every file in the storage, into one directory
# that is complete or not there at all. Run it from cron / Task Scheduler (see ops/README.md); it can run while the
# application is in use.
#
#   ops/backup.sh
#
# Settings (environment, or .env.production):
#   BACKUP_DIR        where backups go                         (default ./backups)
#   BACKUP_KEEP_DAYS  older backups are deleted                (default 30)
#   BACKUP_KEEP_MIN   but at least this many are always kept   (default 3)
#   BACKUP_COPY_TO    a second place (mounted network share, other disk); the finished backup is copied there too
#
# What is NOT in a backup: .env.production (secrets: keep it somewhere safe, apart), Redis (rebuilds itself),
# the search index and queue (rebuilt from the database and files).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
cd "$ROOT"
umask 077

BACKUP_DIR="$(envval BACKUP_DIR ./backups)"
KEEP_DAYS="$(envval BACKUP_KEEP_DAYS 30)"
KEEP_MIN="$(envval BACKUP_KEEP_MIN 3)"
COPY_TO="$(envval BACKUP_COPY_TO)"
[[ "$KEEP_DAYS" =~ ^[0-9]+$ && "$KEEP_MIN" =~ ^[0-9]+$ ]] || die "BACKUP_KEEP_DAYS and BACKUP_KEEP_MIN have to be numbers"

AWS_KEY="$(envval S3_ACCESS_KEY)"; AWS_SECRET="$(envval S3_SECRET_KEY)"; BUCKET="$(envval S3_BUCKET documents)"
AWS_ENDPOINT="http://storage:9000"
[ -n "$AWS_KEY" ] && [ -n "$AWS_SECRET" ] || die "S3_ACCESS_KEY / S3_SECRET_KEY not found (.env.production?)"

mkdir -p "$BACKUP_DIR"
# What a backup that was killed (power cut, reboot) left behind; a running backup's own directory is minutes old
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '.partial-*' -mtime +0 -exec rm -rf {} + 2>/dev/null || true
STAMP="$(date '+%Y-%m-%d_%H%M%S')"
PARTIAL="$BACKUP_DIR/.partial-$STAMP"
FINAL="$BACKUP_DIR/$STAMP"
[ -e "$FINAL" ] && die "$FINAL exists already (two backups in the same second?)"

# A backup that did not finish must not look like one: it is removed, and only a rename makes it complete
cleanup() { [ -d "$PARTIAL" ] && rm -rf "$PARTIAL"; }
trap cleanup EXIT
mkdir -p "$PARTIAL/files"

dc ps --status running --services | grep -qx postgres || die "the stack is not running (ops/dc ps)"
dc ps --status running --services | grep -qx storage || die "the storage is not running (ops/dc ps)"

# The database first: files are never changed once published, so the files taken afterwards include everything the
# database points to (a file added in between is only an unused extra). Only a draft saved while the backup runs can
# differ from its recorded checksum: run it at night.
log "database"
dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner' > "$PARTIAL/db.dump"
[ -s "$PARTIAL/db.dump" ] || die "the database dump is empty"
# The query goes in on standard input: it has quotes of its own that would break a command line
COUNTS="$(printf '%s;\n' "$COUNTS_SQL" | dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA' | tr -d '\r\n ')"
[ -n "$COUNTS" ] || die "could not read the row counts"

log "files"
AWS_MOUNT="$PARTIAL/files" aws_s3 s3 sync "s3://$BUCKET" /data --no-progress --only-show-errors
OBJECTS="$(find "$PARTIAL/files" -type f | wc -l | tr -d ' ')"
tar -czf "$PARTIAL/files.tar.gz" -C "$PARTIAL" files
rm -rf "$PARTIAL/files"

printf '{"createdAt":"%s","appVersion":"%s","bucket":"%s","objects":%s,"counts":%s}\n' \
  "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$(envval APP_VERSION latest)" "$BUCKET" "$OBJECTS" "$COUNTS" > "$PARTIAL/MANIFEST.json"
(cd "$PARTIAL" && sha256sum db.dump files.tar.gz MANIFEST.json > SHA256SUMS)
verify_backup_files "$PARTIAL"

mv "$PARTIAL" "$FINAL"
trap - EXIT
log "backup complete: $FINAL ($(du -sh "$FINAL" | cut -f1), $OBJECTS file(s))"

# Retention: delete what is older than KEEP_DAYS, but never go under KEEP_MIN backups
prune() {
  local dir="$1" total index=0
  total="$(find "$dir" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??_??????' | wc -l | tr -d ' ')"
  find "$dir" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??_??????' -mtime "+$KEEP_DAYS" | sort | while read -r old; do
    # Oldest first: stop when only KEEP_MIN would be left
    if [ $((total - index)) -le "$KEEP_MIN" ]; then break; fi
    rm -rf "$old" && log "removed old backup $old"
    index=$((index + 1))
  done
}
prune "$BACKUP_DIR"

if [ -n "$COPY_TO" ]; then
  mkdir -p "$COPY_TO"
  cp -r "$FINAL" "$COPY_TO/.partial-$STAMP" && mv "$COPY_TO/.partial-$STAMP" "$COPY_TO/$STAMP"
  verify_backup_files "$COPY_TO/$STAMP"
  log "copied to $COPY_TO/$STAMP"
  prune "$COPY_TO"
fi
