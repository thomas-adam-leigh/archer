#!/usr/bin/env bash
#
# Lint Postgres migrations with squawk (catches unsafe DDL: blocking locks,
# destructive drops, missing-concurrent index builds, etc.).
set -euo pipefail
DB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
shopt -s nullglob
files=("$DB_DIR"/supabase/migrations/*.sql)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "no migrations to lint"; exit 0
fi
exec npx --yes squawk-cli@latest "${files[@]}"
