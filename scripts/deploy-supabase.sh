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
#   ALLOW_UNCOMMITTED=1     deploy although supabase/ or scripts/ has uncommitted changes
#   ENV_FILE                read operator values from this file instead of .env.operator
#
# The migrations, functions and email templates are taken from this checkout, not from GitHub.
# Deploy from the commit you are about to push (or have pushed), so the database and functions
# in production always correspond to a commit; the script names that commit and refuses a
# checkout whose backend files differ from it.
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

# Say which commit this is, and refuse backend files nobody committed: otherwise production can
# end up running migrations or functions that exist only on this machine.
here="$(pwd -P)"
# "Does git track this very script?" is what tells this checkout apart from a copy that merely
# sits inside some other repository, and it also works for a project kept in a subdirectory.
if git ls-files --error-unmatch -- scripts/deploy-supabase.sh >/dev/null 2>&1; then
  commit="$(git rev-parse --short HEAD)"
  # --untracked-files=all: a new migration that was never added must be seen whatever the
  # operator's own git settings say about untracked files.
  uncommitted="$(git status --porcelain --untracked-files=all -- supabase scripts)"
  if [ -n "$uncommitted" ]; then
    if [ "${ALLOW_UNCOMMITTED:-0}" != "1" ]; then
      echo "These backend files differ from commit $commit:" >&2
      printf '%s\n' "$uncommitted" >&2
      echo "Commit them first, so that what runs in production corresponds to a commit," >&2
      echo "or set ALLOW_UNCOMMITTED=1 to deploy them as they are." >&2
      exit 1
    fi
    echo "==> Deploying the backend from commit $commit PLUS uncommitted changes (ALLOW_UNCOMMITTED=1)"
  else
    echo "==> Deploying the backend from commit $commit"
  fi
elif [ -e .git ] || git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # There is a repository here, or around this directory, but git cannot say what this
  # directory holds (git is missing, the checkout belongs to another user, or this is a copy
  # inside another repository). Not checking would be the same as claiming it is clean.
  if [ "${ALLOW_UNCOMMITTED:-0}" != "1" ]; then
    echo "git cannot tell which commit the backend files in $here correspond to." >&2
    echo "Run this from the repository's own checkout with a working git, or set" >&2
    echo "ALLOW_UNCOMMITTED=1 to deploy the files as they are." >&2
    exit 1
  fi
  echo "==> Deploying the backend files in this directory, not checked against a commit (ALLOW_UNCOMMITTED=1)"
else
  echo "==> Not a git checkout: deploying the backend files in this directory"
fi

# Later commands must name the same env file, or they act on whatever .env.operator holds.
run_prefix=""
if [ -n "${ENV_FILE:-}" ]; then
  run_prefix="ENV_FILE=$ENV_FILE "
fi

supabase() { npx --no-install supabase "$@"; }
tsx() { npx --no-install tsx "$@"; }

# Auth first: public sign-up is open on a new Supabase project, and it should be closed before
# the application's tables and functions exist.
if [ "${SKIP_AUTH_CONFIG:-0}" != "1" ]; then
  echo "==> 1/5 Setting Auth settings and email templates (site URL: $site)"
  tsx scripts/configure-auth.ts
else
  echo "==> 1/5 Skipping Auth settings (SKIP_AUTH_CONFIG=1). Set them by hand: see README, 'Auth settings'."
  # The Data API's row limit is checked all the same: the web app depends on it.
  tsx scripts/configure-auth.ts --data-api-only
fi

echo "==> 2/5 Applying database migrations to $ref"
if [ -n "${SUPABASE_DB_PASSWORD:-}" ]; then
  supabase db push --remote="$ref" --password "$SUPABASE_DB_PASSWORD" --yes
else
  tsx scripts/apply-migrations.ts
fi

echo "==> 3/5 Installing the worker secret on both sides"
# First prove that this machine can write the database's copy (it needs the project's service
# key, which the access token may not be allowed to read). Replacing the function's copy and
# then failing here would leave the two sides with different secrets, and every wake-up refused.
tsx scripts/activate-queues.ts --preflight
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

echo "==> 5/5 Checking the schedules and that the database can wake the worker"
tsx scripts/activate-queues.ts --status

if [ "$rotated" -eq 1 ]; then
  echo "A new worker secret was generated and installed as a function secret and in Vault."
  echo "Nobody needs to keep it: running this script again without WORKER_SECRET rotates it."
fi

cat <<DONE

Backend deployed to $ref.

Next:
  1. Bootstrap the first owner:   ${run_prefix}npm run bootstrap:owner -- --email you@example.com --link
                                  (prints a one-time link; no email delivery needed)
  2. Deploy the web app:          connect the repository in Vercel (README, "Vercel"); for a
                                  project that is already connected, push this commit
  3. Sign in at $site/sign-in, name the workspace, then add the OpenAI key under Settings.
No campaign runs until an owner or admin launches one.
DONE
