#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .env.supabase ]]; then
  echo "Missing .env.supabase file"
  exit 1
fi

# shellcheck disable=SC1091
source .env.supabase

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" || -z "${SUPABASE_PROJECT_REF:-}" || -z "${SUPABASE_DB_PASSWORD:-}" ]]; then
  echo "Please fill SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, and SUPABASE_DB_PASSWORD in .env.supabase"
  exit 1
fi

# Allow either raw project ref (abcd...) or full URL (https://abcd.supabase.co)
project_ref="${SUPABASE_PROJECT_REF}"
if [[ "${project_ref}" =~ ^https?://([a-z0-9-]+)\.supabase\.co/?$ ]]; then
  project_ref="${BASH_REMATCH[1]}"
fi

if [[ ! "${project_ref}" =~ ^[a-z0-9-]+$ ]]; then
  echo "SUPABASE_PROJECT_REF must be a project ref (or valid Supabase URL)."
  exit 1
fi

if [[ "${SUPABASE_ACCESS_TOKEN}" != sbp_* ]]; then
  echo "SUPABASE_ACCESS_TOKEN should be a Supabase personal access token (starts with sbp_)."
  exit 1
fi

export SUPABASE_ACCESS_TOKEN

echo "Linking project ${project_ref}..."
supabase link --project-ref "${project_ref}" --password "${SUPABASE_DB_PASSWORD}"

echo "Pushing migrations to linked project..."
supabase db push --linked

echo "Done: migrations applied successfully."
