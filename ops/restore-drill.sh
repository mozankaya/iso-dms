#!/usr/bin/env bash
# The restore drill: proves that a backup can really be restored. It builds a throw-away database and storage next to
# the production stack (own network and containers, nothing shared), restores the backup into them, and checks that
#   - the checksums of the backup's own files hold,
#   - the row counts equal the ones recorded when the backup was made,
#   - every revision file and PDF copy is there with the SHA-256 the database recorded,
#   - the guards that keep the audit trail and the feedback unchangeable came back with the database.
# Production is not touched, so it is safe to run at any time (and should be, now and then: a backup nobody has
# restored is a hope, not a backup).
#
#   ops/restore-drill.sh                       the newest backup in BACKUP_DIR
#   ops/restore-drill.sh backups/2026-10-09_020000
#
# Needs the application image (docker image ls iso-dms-api): it has the checking program in it.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
cd "$ROOT"

BACKUP="${1:-$(newest_backup "$(envval BACKUP_DIR ./backups)")}"
[ -n "$BACKUP" ] && [ -d "$BACKUP" ] || die "no backup found (give a directory: ops/restore-drill.sh backups/<date>)"
BACKUP="$(cd "$BACKUP" && pwd)"
API_IMAGE="${API_IMAGE:-iso-dms-api:$(envval APP_VERSION latest)}"
docker image inspect "$API_IMAGE" >/dev/null 2>&1 || die "the image $API_IMAGE does not exist (ops/dc build api)"

ID="drill-$$"
DRILL_NET="iso-dms-$ID"
PG="$ID-postgres"
ST="$ID-storage"
PG_PASSWORD="drill-$(date +%s)-pw"
ST_KEY="drillkey"; ST_SECRET="drillsecret-$(date +%s)"
WORK="$(mktemp -d)"

cleanup() {
  docker rm -f "$PG" "$ST" >/dev/null 2>&1 || true
  docker network rm "$DRILL_NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

log "backup: $BACKUP"
verify_backup_files "$BACKUP"
EXPECTED="$(grep -o '"counts":{[^}]*}' "$BACKUP/MANIFEST.json" | sed 's/^"counts"://')"
[ -n "$EXPECTED" ] || die "the backup's manifest has no row counts"
BUCKET="$(grep -o '"bucket":"[^"]*"' "$BACKUP/MANIFEST.json" | cut -d'"' -f4)"

log "starting a scratch database and storage"
docker network create "$DRILL_NET" >/dev/null
docker run -d --name "$PG" --network "$DRILL_NET" -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB=drill postgres:16 >/dev/null
docker run -d --name "$ST" --network "$DRILL_NET" -e RUSTFS_ACCESS_KEY="$ST_KEY" -e RUSTFS_SECRET_KEY="$ST_SECRET" \
  -e RUSTFS_ADDRESS=":9000" -e RUSTFS_CONSOLE_ENABLE=false rustfs/rustfs:latest >/dev/null
for _ in $(seq 1 40); do docker exec "$PG" pg_isready -U postgres -d drill >/dev/null 2>&1 && break; sleep 2; done
for _ in $(seq 1 40); do docker exec "$ST" curl -sf http://127.0.0.1:9000/health >/dev/null 2>&1 && break; sleep 2; done
docker exec "$PG" pg_isready -U postgres -d drill >/dev/null || die "the scratch database did not start"
docker exec "$ST" curl -sf http://127.0.0.1:9000/health >/dev/null || die "the scratch storage did not start"

log "restoring the database"
docker exec -i "$PG" pg_restore -U postgres -d drill --no-owner --exit-on-error < "$BACKUP/db.dump"

log "restoring the files"
tar -xzf "$BACKUP/files.tar.gz" -C "$WORK"
AWS_KEY="$ST_KEY"; AWS_SECRET="$ST_SECRET"; AWS_ENDPOINT="http://$ST:9000"; AWS_NETWORK="$DRILL_NET"
AWS_MOUNT="$WORK/files" aws_s3 s3 mb "s3://$BUCKET" >/dev/null
AWS_MOUNT="$WORK/files" aws_s3 s3 sync /data "s3://$BUCKET" --no-progress --only-show-errors

FAILED=0

log "comparing the row counts with the backup's manifest"
ACTUAL="$(docker exec "$PG" psql -U postgres -d drill -tA -c "$COUNTS_SQL" | tr -d '\r\n ')"
if [ "$ACTUAL" = "$EXPECTED" ]; then
  log "  counts equal: $ACTUAL"
else
  log "  COUNTS DIFFER"; log "    backup:   $EXPECTED"; log "    restored: $ACTUAL"; FAILED=1
fi

log "checking every file against the checksums in the database"
if ! docker run --rm --network "$DRILL_NET" \
  -e DATABASE_URL="postgresql://postgres:$PG_PASSWORD@$PG:5432/drill" \
  -e S3_ENDPOINT="$ST" -e S3_PORT=9000 -e S3_USE_SSL=false -e S3_ACCESS_KEY="$ST_KEY" -e S3_SECRET_KEY="$ST_SECRET" -e S3_BUCKET="$BUCKET" \
  "$API_IMAGE" pnpm exec tsx prisma/verify-storage.ts; then
  FAILED=1
fi

echo
if [ "$FAILED" -eq 0 ]; then
  log "DRILL PASSED: $BACKUP can be restored"
else
  log "DRILL FAILED: $BACKUP could not be restored completely (details above)"
  exit 1
fi
