#!/usr/bin/env bash
# Deploys the backend to a hosted Supabase project: database migrations, Auth settings and
# email templates, Edge Function secrets, the two Edge Functions, and queue activation.
#
# Safe to run again. It never launches a campaign and never sends a provider request.
#
# Required (environment, or a .env.operator file in the repository root):
#   SUPABASE_PROJECT_REF   project ref, e.g. abcdefghijklmnopqrst
#   SUPABASE_DB_PASSWORD   database password of that project
#   SUPABASE_URL           https://<project-ref>.supabase.co
#   SUPABASE_SECRET_KEY    the project's secret (service role) key
#   SITE_URL               public URL of the web app, e.g. https://recommends.example.com
#   WORKER_SECRET          shared secret for the queue consumer (openssl rand -hex 32)
# The Supabase CLI must be signed in: run `npx supabase login` once, or set SUPABASE_ACCESS_TOKEN.
#
# Optional:
#   SKIP_CONFIG_PUSH=1     leave the project's Auth settings alone (configure them by hand)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env.operator ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.operator
  set +a
fi

missing=0
for name in SUPABASE_PROJECT_REF SUPABASE_DB_PASSWORD SUPABASE_URL SUPABASE_SECRET_KEY SITE_URL WORKER_SECRET; do
  if [ -z "${!name:-}" ]; then
    echo "Missing required value: $name" >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || exit 1

case "$SUPABASE_URL" in
  *127.0.0.1* | *localhost*)
    echo "SUPABASE_URL points at a local stack. This script deploys to a hosted project." >&2
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
if [ "${#WORKER_SECRET}" -lt 32 ]; then
  echo "WORKER_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32" >&2
  exit 1
fi

site="${SITE_URL%/}"
ref="$SUPABASE_PROJECT_REF"
supabase() { npx --no-install supabase "$@"; }

echo "==> 1/5 Applying database migrations to $ref"
supabase db push --remote="$ref" --password "$SUPABASE_DB_PASSWORD" --yes

if [ "${SKIP_CONFIG_PUSH:-0}" != "1" ]; then
  echo "==> 2/5 Pushing Auth settings and email templates (site URL: $site)"
  # config.toml carries local defaults. Push a copy that names the real site instead.
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  mkdir -p "$work/supabase"
  cp -R supabase/templates "$work/supabase/templates"
  sed \
    -e "s|^site_url = .*|site_url = \"$site\"|" \
    -e "s|^additional_redirect_urls = .*|additional_redirect_urls = [\"$site/**\"]|" \
    supabase/config.toml >"$work/supabase/config.toml"
  supabase config push --workdir "$work" --remote="$ref" --yes
else
  echo "==> 2/5 Skipping Auth settings (SKIP_CONFIG_PUSH=1). Set them by hand: see README, 'Auth settings'."
fi

echo "==> 3/5 Setting Edge Function secrets"
supabase secrets set --remote="$ref" --yes "WORKER_SECRET=$WORKER_SECRET" "SITE_URL=$site"

echo "==> 4/5 Deploying Edge Functions (worker, ops)"
supabase functions deploy --remote="$ref" --yes worker ops

echo "==> 5/5 Activating the queue consumer"
SUPABASE_FUNCTIONS_BASE_URL="${SUPABASE_URL%/}" npx --no-install tsx scripts/activate-queues.ts

cat <<DONE

Backend deployed to $ref.

Next:
  1. Bootstrap the first owner:   npm run bootstrap:owner -- --email you@example.com
  2. Deploy the web app:          npm run deploy:vercel   (or connect the repository in Vercel)
  3. Sign in at $site/sign-in, name the workspace, then add the OpenAI key under Settings.
No campaign runs until an owner or admin launches one.
DONE
