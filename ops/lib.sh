#!/usr/bin/env bash
# Shared by the backup scripts (source it, do not run it).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env.production"
# The compose project of docker-compose.prod.yml; its network is where the services find each other
COMPOSE_PROJECT="${COMPOSE_PROJECT:-iso-dms-prod}"
NETWORK="${COMPOSE_PROJECT}_default"
# The S3 command line client that reads and writes the file storage (any S3 compatible store speaks to it)
AWS_CLI_IMAGE="${AWS_CLI_IMAGE:-amazon/aws-cli:latest}"

# Git Bash on Windows rewrites paths that look like Unix ones when it starts Docker; this switches that off
export MSYS_NO_PATHCONV=1

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# A setting: the environment first, then .env.production (read as text, never executed), then the default.
envval() {
  local key="$1" default="${2:-}" value="${!1:-}"
  if [ -z "$value" ] && [ -f "$ENV_FILE" ]; then
    value="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')" || true
  fi
  printf '%s' "${value:-$default}"
}

# The path of a directory as Docker wants it: a Windows path under Git Bash, the same path elsewhere.
hostpath() {
  if (cd "$1" && pwd -W) 2>/dev/null; then return; fi
  (cd "$1" && pwd)
}

# aws <args...> against an S3 endpoint; the directory mounted at /data is $AWS_MOUNT.
# Checksums only when the store asks for them: not every store accepts the client's newer default headers.
aws_s3() {
  local mount_args=()
  [ -n "${AWS_MOUNT:-}" ] && mount_args=(-v "$(hostpath "$AWS_MOUNT"):/data")
  docker run --rm --network "${AWS_NETWORK:-$NETWORK}" "${mount_args[@]}" \
    --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -e AWS_ACCESS_KEY_ID="$AWS_KEY" -e AWS_SECRET_ACCESS_KEY="$AWS_SECRET" -e AWS_DEFAULT_REGION=us-east-1 \
    -e AWS_REQUEST_CHECKSUM_CALCULATION=when_required -e AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
    "$AWS_CLI_IMAGE" --endpoint-url "$AWS_ENDPOINT" "$@"
}

dc() { "$ROOT/ops/dc" "$@"; }

# The counts a backup records and the drill compares after restoring (one line, same query on both sides)
COUNTS_SQL="select json_build_object('organizations',(select count(*) from \"Organization\"),'users',(select count(*) from \"User\"),'documents',(select count(*) from \"Document\"),'revisions',(select count(*) from \"Revision\"),'auditLogs',(select count(*) from \"AuditLog\"),'feedback',(select count(*) from \"Feedback\"),'templates',(select count(*) from \"Template\"))"

# The newest complete backup in a directory (partial ones start with a dot and are never taken)
newest_backup() {
  find "$1" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??_??????' 2>/dev/null | sort | tail -n1
}

# Checks a backup directory against its SHA256SUMS
verify_backup_files() {
  [ -f "$1/SHA256SUMS" ] || die "$1 has no SHA256SUMS: not a complete backup"
  (cd "$1" && sha256sum -c SHA256SUMS >/dev/null) || die "$1: a file does not match its checksum (damaged or changed backup)"
}
