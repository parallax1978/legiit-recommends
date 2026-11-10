# Legiit Recommends

An invite-only internal tool for running repeatable OpenAI conversation campaigns and measuring,
with independent fresh checks, whether a business shows up in recommendation answers before,
during and after those conversations.

A campaign does three things on a schedule:

1. **Conversations.** A fresh context each time: an initial question, a request to include the
   business, and a request for the revised list (plus any extra user messages you add). Every
   answer is the model's own; turn 2 continues from the real turn 1 answer, and so on.
2. **Fresh checks.** Single questions sent with no conversation history, no instructions and
   nothing about the business or campaign: a baseline before the conversations, scheduled checks
   while they run, and a final sample after they end.
3. **Reporting.** First-response inclusion, final-response inclusion and fresh-check inclusion
   (including held-out questions) are reported separately, each with its counts and valid
   denominator. Results are OpenAI **API** results, not ChatGPT app results.

Nothing is seeded: an installation starts with no campaigns, prompts or businesses. Deploying
never starts paid work; only an owner or admin clicking **Launch** does.

## How it is built

```
Browser ──► Next.js on Vercel ──(user session, publishable key only)──► Supabase
                                                                        ├─ Postgres: tables, RLS, role-checked functions
                                                                        ├─ Auth: invitations, password recovery
                                                                        ├─ Vault: OpenAI keys, worker secret
                                                                        ├─ Cron ─► plan slots (1 min) ─► dispatch to Queues (10 s)
                                                                        ├─ Queues (pgmq): one message per job
                                                                        └─ Edge Functions
                                                                             worker: one turn / check / poll per invocation ─► OpenAI Responses API
                                                                             ops:    credentials, model verification, generation, invitations
```

- **The web app holds no service key.** It reads through row level security and writes only
  through database functions that check the caller's workspace role. Anything needing a secret
  (the OpenAI key, sending invitations) goes through the `ops` Edge Function, which verifies the
  user's token and authorizes again in SQL.
- **Background work does not depend on a browser or a long-lived process.** Supabase Cron plans
  and dispatches; each `worker` invocation claims one unit with a lease and fencing token,
  records the attempt before sending it, and commits the result together with the next step in
  one transaction. Long-running models use background responses and queued polling.
- **Spending is reserved before it happens.** Each request reserves its worst-case cost against
  the campaign and connection limits; a request that does not fit is not sent.

Repository layout:

| Path                               | Contents                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/`                             | Next.js app (App Router), server actions, export routes                                         |
| `supabase/migrations/`             | Schema, RLS, functions, queue and cron setup, default price list                                |
| `supabase/functions/worker`, `ops` | Edge Functions                                                                                  |
| `supabase/functions/_shared/`      | Provider adapter, engine, detection, templates, cost math (shared with the web app and tests)   |
| `scripts/`                         | Deployment, Auth settings, migrations over HTTPS, owner bootstrap, queue activation, smoke test |
| `tests/`                           | Unit, integration (real local Supabase) and end-to-end (browser) tests                          |

## Local setup

Requirements: Node 22+, Docker, and (only for `npm run typecheck:functions`) Deno 2.

```bash
npm install
```

```bash
cp supabase/functions/.env.example supabase/functions/.env
```

```bash
npm run db:start
```

```bash
npm run env:local
```

```bash
OWNER_PASSWORD='choose-a-password-of-10-or-more' npm run bootstrap:owner -- --email you@example.com
```

```bash
npm run queues:activate
```

```bash
npm run dev
```

Open http://localhost:3000, sign in, and name your workspace. Local emails (invitations,
password resets) are caught by Mailpit at http://127.0.0.1:54324.

`npm run db:start` applies every migration. `npm run env:local` writes `.env.local` (the two
public values the web app needs) and `.env.operator` (the secret key for the scripts, which
Next.js never reads). After changing a migration run `npm run db:reset`.

### Trying it without spending money

The repository includes a deterministic stand-in for the OpenAI API. Its answers are synthetic
and nothing is sent to OpenAI.

1. Add `OPENAI_BASE_URL=http://host.docker.internal:4010/v1` to `supabase/functions/.env`, then
   restart the stack (`npm run db:stop`, `npm run db:start`).
2. Run `npm run fake-openai` in another terminal.
3. In **Settings → OpenAI connections**, use any key starting with `sk-fake-valid`. Add a price
   for `fake-chat-1` under **Settings → Model pricing**, then verify the model.

Remove `OPENAI_BASE_URL` and restart to use the real API.

## Testing

```bash
npm run check
```

```bash
npm run test:integration
```

```bash
npm run test:e2e
```

| Suite              | What runs                                                                                             | Provider         |
| ------------------ | ----------------------------------------------------------------------------------------------------- | ---------------- |
| `test:unit`        | Detection, templates, selection, cost math, CSV, timezones, redirect safety, deploy-script logic      | none             |
| `test:integration` | The real local database, Auth, queue, Vault and the engine                                            | provider double  |
| `test:e2e`         | A browser driving the built app at desktop and phone sizes, with real Cron, Queues and Edge Functions | provider double  |
| `smoke:live`       | Three chained turns and one fresh check against the real OpenAI API                                   | **real, billed** |

`npm run check` runs formatting, lint, type checks, unit tests and a production build.
Integration and end-to-end tests need the local stack (`npm run db:start`); the end-to-end tests
also need the `OPENAI_BASE_URL` line above and `npm run env:local`. Both suites clear local data.

Passing integration and end-to-end tests show that the application handles the provider
contract as implemented by the double (success, 429, credential and quota errors, incomplete
responses, timeouts, expired state). They are **not** evidence of a live OpenAI integration. For
that, run the live smoke test with a key and a small cap:

```bash
OPENAI_API_KEY=sk-... LIVE_SMOKE_MODEL=<model-id> LIVE_SMOKE_MAX_USD=0.25 npm run smoke:live
```

It prints each request's usage and estimated cost and stops before any request that would
exceed the cap.

## Deploying

You need a Supabase project and a Vercel project. Operator values go in a git-ignored env file
in the repository root (see `.env.example`); Next.js does not read it. `npm run env:local`
writes `.env.operator` for the local stack, so keep the hosted project's values in a separate
file and name it when you run a command, for example:

```bash
ENV_FILE=.env.operator.production npm run deploy:supabase
```

Values from the two files are then never mixed, and the deploy script refuses to run against a
local URL.

### 1. Supabase

Create a project (directly, or through Vercel's Supabase integration). The deploy needs three
values:

| Value                   | Where it comes from                                  |
| ----------------------- | ---------------------------------------------------- |
| `SUPABASE_PROJECT_REF`  | the subdomain of the project URL                     |
| `SUPABASE_ACCESS_TOKEN` | Supabase dashboard → Account → Access Tokens         |
| `SITE_URL`              | the public https address of the web app (see step 3) |

```bash
npm run deploy:supabase
```

In order, the script:

1. sets the Auth settings the app depends on (below), which closes public sign-up first;
2. applies the migrations. They enable the extensions they need (`pgmq`, `pg_cron`, `pg_net`,
   `supabase_vault`);
3. installs the worker secret on both sides: as an Edge Function secret (with `SITE_URL`) and
   in Vault for the database;
4. deploys `worker` and `ops` (bundled on Supabase's side, so no local Docker is needed);
5. has the database wake the worker once and fails unless the worker accepts.

It is safe to run again and never starts a campaign. Everything goes over HTTPS with the access
token: no database password and no direct database connection are required. Migrations are
applied through the Management API as one transaction, so a deployment either applies
completely or changes nothing, and they are recorded in the Supabase CLI's own history table.
To rehearse them on the project without changing it:

```bash
npm run db:push:api -- --verify
```

If you set `SUPABASE_DB_PASSWORD`, the script uses `supabase db push` over a direct connection
instead. `WORKER_SECRET` is optional: without it a new one is generated and installed on both
sides each time, so nobody has to keep it.

#### Auth settings

`npm run auth:configure` (step 1 of the deploy; `-- --check` only reports differences) sets
exactly these and leaves every other project setting alone. It does not push
`supabase/config.toml`, which holds local-development defaults.

- **Site URL**: your `SITE_URL`. Email links are built from it, so it must be the address people
  can open. If Vercel's integration filled in a deployment alias that sits behind Vercel's own
  login, this replaces it.
- **Redirect URLs**: `SITE_URL/**` and nothing else. Entries an integration added for preview
  deployments are removed: the app never redirects to them, and a wildcard on a shared domain
  such as `*.vercel.app` can be matched by a host somebody else registers.
- **Sign-ups disabled**, anonymous sign-ins off. People join only by invitation.
- **Minimum password length** 10.
- **Every email template that carries a link** (invitation, password reset, sign-in link,
  confirmation, email change) from `supabase/templates/`. They all point to
  `SITE_URL/auth/confirm?token_hash=…`, a page of the web app. The one-time token is used only
  when the person presses **Continue** there, so mail scanners and chat previews that fetch the
  link cannot use it up.

Supabase's built-in email sender is rate-limited and only delivers to members of the project's
Supabase organization. Configure your own SMTP provider under **Authentication → Emails** before
inviting other people. Until then use one-time links (next step).

### 2. First owner

```bash
npm run bootstrap:owner -- --email you@example.com --link
```

This grants that address the right to create one workspace and prints a one-time link. Open it
in a browser to choose a password, then name the workspace. Nothing is emailed. Without
`--link` the command sends a Supabase invitation email instead (needs working email delivery);
with `OWNER_PASSWORD` set in the environment it creates the account with that password, which
is how local development and the tests do it.

The same command with `--link` is the way back in for an owner who is locked out: for an
account that already has a password, the link resets it. An account that already existed for
the address but was never confirmed is not trusted: its password is replaced before anything
can confirm it. The command creates no campaigns or other data and can be run again.

### 3. Vercel

Import the repository in the Vercel dashboard. Pushes to the production branch are then built
and deployed by Vercel. The web app needs exactly two environment variables, both safe for
browsers:

| Variable                               | Value                               |
| -------------------------------------- | ----------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | `https://<project-ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | the publishable key                 |

Use the project's public production domain (or your own domain) as `SITE_URL` in step 1. Other
`*.vercel.app` aliases of a deployment are usually behind Vercel's login and cannot be opened
from an email.

**If you use Vercel's Supabase integration**, it adds those two variables for you, but it also
adds the Supabase secret key, the legacy JWT secret and the database password
(`SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `POSTGRES_*`). The
web app reads none of them. Remove them from the Vercel project (Settings → Environment
Variables) and redeploy, so that the web tier holds nothing that bypasses row level security.
Never add `WORKER_SECRET` or an OpenAI key to Vercel either.

Vercel deploys a push whether or not CI has finished. To make a red build block production,
require the CI checks on the production branch (GitHub branch protection) or deploy from a
branch that only receives reviewed merges.

`npm run deploy:vercel` deploys from your machine with the Vercel CLI instead. You do not need
it for a Git-connected project, where its deployment would be replaced by the next push.

### 4. Connect OpenAI

Sign in as the owner and open **Settings → OpenAI connections**: add a connection with a daily
spending limit and a number of concurrent requests, paste the API key, then verify the model
you want to use. Verification sends a few very small real requests to learn which settings the
model accepts; they are reserved against the daily limit and listed under Usage. Record the
data-sharing setting you see in your OpenAI organization (it is a dated note, not a switch; see
[OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)).

Check the default price list under **Settings → Model pricing** against OpenAI's current prices
before relying on budgets, and add a price version for any model that is missing. A model with
no price cannot be used.

## Where secrets live

| Secret                | Stored in                             | Readable by                                                    |
| --------------------- | ------------------------------------- | -------------------------------------------------------------- |
| OpenAI API key        | Supabase Vault (entered in the app)   | the `worker` and `ops` Edge Functions only                     |
| `WORKER_SECRET`       | Edge Function secret and Vault        | Supabase Cron (to wake the worker) and the `worker` function   |
| Supabase secret key   | Supabase (provided to Edge Functions) | Edge Functions; operator scripts read it with the access token |
| Supabase access token | your operator env file only           | operator scripts (deploy, bootstrap)                           |
| Publishable key       | Vercel environment                    | browsers (by design)                                           |

The web app is built to hold nothing but the publishable key. If Vercel's Supabase integration
has added the secret key, JWT secret or database password to the Vercel project, remove them
(see Deploying, step 3).

API keys and authorization headers are never written to logs, tables or exports. The app shows
a key only as a masked hint such as `sk-…ab12`. Replacing a key takes effect immediately.

## Queue activation

Cron always plans and queues work for launched campaigns. `npm run queues:activate` stores, in
Vault, the URL of the `worker` function and the shared secret, which lets the dispatcher wake it.
`deploy:supabase` does this for you.

Stored settings prove nothing by themselves, so activation ends by sending one wake-up from the
database and reporting the worker's answer. The same check on its own:

```bash
npm run queues:activate -- --status
```

It fails with the reason (for example HTTP 401 when the secret in the database and the
function's secret differ) instead of leaving work queued with nothing picking it up. A wake-up
with nothing queued makes the worker look for work, find none and stop.

**Settings → Operational status** shows the scheduler heartbeat, whether recent wake-ups were
accepted by the worker, queue backlog, stalled leases, connection state, provider errors and
budget exhaustion. To rotate the worker secret, run `npm run deploy:supabase` again without
`WORKER_SECRET` set: a new one is generated and installed as a function secret and in Vault.

## Backups

- Use Supabase's managed backups (daily, or point-in-time recovery on plans that include it).
- For your own copy, dump the schema and the data. This needs the database password and a
  direct connection to the database (reset the password under **Database → Settings** if the
  project was created by an integration and you never saw it; nothing in this app uses it):

```bash
npx supabase db dump --remote=<project-ref> --password "$SUPABASE_DB_PASSWORD" -f backup-schema.sql
```

```bash
npx supabase db dump --remote=<project-ref> --password "$SUPABASE_DB_PASSWORD" --data-only --use-copy -f backup-data.sql
```

- Vault secrets are encrypted with a key Supabase manages for the project. After restoring into
  a **different** project, re-enter each OpenAI key in Settings and run `npm run queues:activate`.
- From the app, each campaign can be exported as CSV (results, fresh checks, usage) and JSON
  (transcripts, configuration). Exports respect workspace membership, escape spreadsheet
  formulas and contain no secrets.
- Transcript text can be removed automatically after a number of days
  (**Settings → Workspace**); counts, classifications, usage and the audit trail are kept.

## Recovery

| Situation                           | What to do                                                                                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop all spending now               | **Settings → Workspace → Emergency stop** (owner). Requests already sent finish and are recorded. Release it to resume.                                                           |
| A campaign was paused automatically | The provider rejected its model or settings. Open the campaign for the reason, fix it under **Edit**, apply the change, then **Resume**.                                          |
| Connection "needs attention"        | Invalid key or exhausted quota. Fix it at OpenAI or replace the key, then **Test connection**: a successful test releases the held work.                                          |
| Jobs in the review queue            | **Settings → Operational status → Review queue → Retry**. A retry continues from the last saved turn; completed turns are never sent again.                                       |
| Conversation "expired"              | The provider no longer has the stored response the next turn needs. It is not replayed silently: use **Restart as a new conversation** on its page.                               |
| Request with an unknown outcome     | A timeout or dropped connection after sending. Its reservation stays held. An owner decides under **Usage**: count as spent, or release after checking the provider's usage page. |
| Worker stopped mid-request          | Nothing to do. The lease expires, the attempt is marked unknown or retried, and the job resumes from the last saved state.                                                        |
| Budget reached                      | Raise the campaign or connection limit (or wait for the next day). Waiting jobs continue; skipped slots follow the campaign's missed-slot setting.                                |
| "Queue consumers are not activated" | Run `npm run queues:activate`.                                                                                                                                                    |
| An owner cannot sign in             | `npm run bootstrap:owner -- --email <their address> --link` prints a one-time link that lets them choose a new password. No email is needed.                                      |
| An email link says it has expired   | Links work once and for a limited time. Send a new invitation or reset email; for an owner without email delivery use the one-time link above.                                    |
| A migration fails during a deploy   | Nothing was applied: the deployment is one transaction. The command names the failing file; fix it and run `npm run deploy:supabase` again.                                       |
| Scheduler heartbeat is stale        | Check that the `lr-plan` and `lr-dispatch` jobs exist and are active (Dashboard → Integrations → Cron). `npm run queues:activate` puts back any schedule that was removed.        |

Editing a launched campaign never rewrites history: changes are saved as pending, and applying
them creates a new immutable revision used only for future work. Changing the fresh-check
question set, allocation or model settings starts a new comparison group with its own baseline.

## Notes on accuracy

- Costs are estimates from recorded token usage and the price versions in Settings. They are for
  budgeting; your OpenAI invoice is authoritative.
- Delivery is at-least-once with safeguards, not exactly-once. Every provider request is
  recorded before it is sent, requests with unknown outcomes are tracked separately, and no
  result is counted twice.
- A change in fresh-check inclusion after a campaign is an observation, not proof of cause.
  Model answers vary between requests; read the counts next to every percentage.
