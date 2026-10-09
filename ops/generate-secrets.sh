#!/usr/bin/env bash
# Makes .env.production from .env.production.example with a random value for every __GENERATE__.
# Hex only: the values end up in a database address, where other characters would need escaping.
# It will not overwrite an existing file. Edit APP_HOST, DOCS_HOST and the SEED_ values afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.production ] && { echo ".env.production exists already; remove it first if you really want new secrets" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is needed" >&2; exit 1; }

umask 077
while IFS= read -r line || [ -n "$line" ]; do
  while [[ "$line" == *__GENERATE__* ]]; do
    line="${line/__GENERATE__/$(openssl rand -hex 24)}"
  done
  printf '%s\n' "$line"
done < .env.production.example > .env.production

echo ".env.production made (readable by you only). Now set APP_HOST, DOCS_HOST, SEED_* and, if you want mail, SMTP_*."
echo "The first administrator password is SEED_ADMIN_PASSWORD in that file."
