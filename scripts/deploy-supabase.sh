#!/usr/bin/env bash
# Deploys the backend to a hosted Supabase project: the Auth settings the app depends on,
# database migrations, the worker secret (Edge Function secret and Vault), the two Edge
# Functions, and a check that the database can wake the worker.
#
# Safe to run again. It never launches a campaign and never sends a provider request.
#
# Required (environment, or the operator env file — see ENV_FILE below):
#   SUPABASE_PROJECT_REF    project ref, e.g. abcdefghijklmnopqrst
#   SUPABASE_ACCESS_TOKEN   a Supabase access token (Dashboard → Account → Access Tokens)
#   SITE_URL                public https URL of the web app, e.g. https://recommends.example.com
#
# Optional:
#   SUPABASE_DB_PASSWORD    apply migrations with `supabase db push` over a direct database
#                           connection. Without it they are applied through the Management API,
#                           which needs HTTPS only and no database password.
#   WORKER_SECRET           shared secret for the queue consumer. Without it a new one is
#                           generated and installed on both sides (that is also how to rotate it).
#   SUPABASE_URL            defaults to https://<project-ref>.supabase.co
#   SUPABASE_SECRET_KEY     defaults to the project's secret key, read through the Management API
#   SKIP_AUTH_CONFIG=1      leave the project's Auth settings alone (see README, "Auth settings")
#   ENV_FILE                read operator values from this file instead of .env.operator
set -euo pipefail
cd "$(dirname "$0")/.."

env_file="${ENV_FILE:-.env.operator}"
if [ -n "${ENV_FILE:-}" ] && [ ! -f "$env_file" ]; then
  echo "ENV_FILE points at $env_file, which does not exist." >&2
  exit 1
fi
if [ -f "$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  case "$env_file" in
    /*) . "$env_file" ;;
    *) . "./$env_file" ;;
  esac
  set +a
fi

missing=0
for name in SUPABASE_PROJECT_REF SUPABASE_ACCESS_TOKEN SITE_URL; do
  if [ -z "${!name:-}" ]; then
    echo "Missing required value: $name" >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || exit 1

ref="$SUPABASE_PROJECT_REF"
export SUPABASE_URL="${SUPABASE_URL:-https://$ref.supabase.co}"
case "$SUPABASE_URL" in
  *127.0.0.1* | *localhost*)
    echo "SUPABASE_URL points at a local stack ($env_file holds local values?). This script deploys to a hosted project." >&2
    exit 1
    ;;
esac
case "$SITE_URL" in
  https://*) ;;
  *)
    echo "SITE_URL must be the https URL of the deployed web app." >&2
    exit 1
    ;;
esac
site="${SITE_URL%/}"

rotated=0
if [ -z "${WORKER_SECRET:-}" ]; then
  WORKER_SECRET="$(openssl rand -hex 32)"
  rotated=1
fi
if [ "${#WORKER_SECRET}" -lt 32 ]; then
  echo "WORKER_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32" >&2
  exit 1
fi
export WORKER_SECRET
export SITE_URL="$site"

supabase() { npx --no-install supabase "$@"; }
tsx() { npx --no-install tsx "$@"; }

# Auth first: public sign-up is open on a new Supabase project, and it should be closed before
# the application's tables and functions exist.
if [ "${SKIP_AUTH_CONFIG:-0}" != "1" ]; then
  echo "==> 1/5 Setting Auth settings and email templates (site URL: $site)"
  tsx scripts/configure-auth.ts
else
  echo "==> 1/5 Skipping Auth settings (SKIP_AUTH_CONFIG=1). Set them by hand: see README, 'Auth settings'."
fi

echo "==> 2/5 Applying database migrations to $ref"
if [ -n "${SUPABASE_DB_PASSWORD:-}" ]; then
  supabase db push --remote="$ref" --password "$SUPABASE_DB_PASSWORD" --yes
else
  tsx scripts/apply-migrations.ts
fi

echo "==> 3/5 Installing the worker secret on both sides"
# Passed in a private file rather than on the command line, where other users could read them.
secrets_file="$(mktemp)"
trap 'rm -f "$secrets_file"' EXIT
printf 'WORKER_SECRET=%s\nSITE_URL=%s\n' "$WORKER_SECRET" "$site" >"$secrets_file"
supabase secrets set --remote="$ref" --yes --env-file "$secrets_file"
# Straight away into Vault as well, so the function and the database never hold different
# values for longer than this line takes, whatever happens to the steps after it.
SUPABASE_FUNCTIONS_BASE_URL="${SUPABASE_URL%/}" tsx scripts/activate-queues.ts --no-check

echo "==> 4/5 Deploying Edge Functions (worker, ops)"
# --use-api bundles on Supabase's side, so no local Docker is needed.
supabase functions deploy --remote="$ref" --yes --use-api worker ops

echo "==> 5/5 Checking that the database can wake the worker"
tsx scripts/activate-queues.ts --status

if [ "$rotated" -eq 1 ]; then
  echo "A new worker secret was generated and installed as a function secret and in Vault."
  echo "Nobody needs to keep it: running this script again without WORKER_SECRET rotates it."
fi

cat <<DONE

Backend deployed to $ref.

Next:
  1. Bootstrap the first owner:   npm run bootstrap:owner -- --email you@example.com
                                  (add --link to get a one-time link when no SMTP is configured)
  2. Deploy the web app:          connect the repository in Vercel, or npm run deploy:vercel
  3. Sign in at $site/sign-in, name the workspace, then add the OpenAI key under Settings.
No campaign runs until an owner or admin launches one.
DONE
