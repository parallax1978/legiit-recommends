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
# You can also skip this script: import the repository in the Vercel dashboard, add the two
# variables above for Production, and deploy from Git.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env.operator ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.operator
  set +a
fi

: "${NEXT_PUBLIC_SUPABASE_URL:?Set NEXT_PUBLIC_SUPABASE_URL (https://<project-ref>.supabase.co)}"
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
