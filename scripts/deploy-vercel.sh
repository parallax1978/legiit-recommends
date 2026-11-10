#!/usr/bin/env bash
# Deploys the web app to Vercel with the Vercel CLI.
#
# The web app needs exactly two environment variables, both safe for browsers:
#   NEXT_PUBLIC_SUPABASE_URL
#   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
# It must never be given the Supabase secret key, the worker secret or an OpenAI key.
#
# Required (environment, or .env.operator in the repository root):
#   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
# The Vercel CLI must be signed in (`npx vercel login`) or VERCEL_TOKEN must be set. The first
# run links the directory to a Vercel project (set VERCEL_ORG_ID and VERCEL_PROJECT_ID to skip
# the prompt in CI).
#
# You do not need this script when the Vercel project is connected to the Git repository (the
# usual setup: import the repository in the Vercel dashboard and add the two variables above for
# Production, or let Vercel's Supabase integration add them). Pushes to the production branch
# are then built and deployed by Vercel, and a deployment made from here would simply be
# replaced by the next push.
#
# ENV_FILE selects the operator env file to read instead of .env.operator.
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

if [ -z "${NEXT_PUBLIC_SUPABASE_URL:-}" ] && [ -n "${SUPABASE_PROJECT_REF:-}" ]; then
  NEXT_PUBLIC_SUPABASE_URL="https://$SUPABASE_PROJECT_REF.supabase.co"
fi
: "${NEXT_PUBLIC_SUPABASE_URL:?Set NEXT_PUBLIC_SUPABASE_URL (https://<project-ref>.supabase.co)}"
case "$NEXT_PUBLIC_SUPABASE_URL" in
  *127.0.0.1* | *localhost*)
    echo "NEXT_PUBLIC_SUPABASE_URL points at a local stack. Deploy with the hosted project's URL." >&2
    exit 1
    ;;
esac
: "${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:?Set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (the publishable key, not the secret key)}"

case "$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" in
  sb_secret_*)
    echo "That is a secret key. The web app must only receive the publishable key." >&2
    exit 1
    ;;
esac

vercel() {
  if [ -n "${VERCEL_TOKEN:-}" ]; then
    npx --yes vercel@latest "$@" --token "$VERCEL_TOKEN"
  else
    npx --yes vercel@latest "$@"
  fi
}

echo "==> Linking the project"
vercel link --yes

echo "==> Setting production environment variables"
printf '%s' "$NEXT_PUBLIC_SUPABASE_URL" | vercel env add NEXT_PUBLIC_SUPABASE_URL production --force
printf '%s' "$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" | vercel env add NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY production --force

echo "==> Building and deploying to production"
vercel pull --yes --environment=production
vercel build --prod
vercel deploy --prebuilt --prod

cat <<'DONE'

Web app deployed.

Make sure the URL Vercel printed (or your custom domain) is the SITE_URL you used for
`npm run deploy:supabase`: invitation and password-reset links point there. If it changed,
run `npm run deploy:supabase` again with the new SITE_URL.
DONE
