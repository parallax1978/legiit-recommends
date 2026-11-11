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

Requirements: Node 26 (the version CI and Vercel run; `package.json` pins it, and npm prints an
engine warning on other versions), Docker, and (only for `npm run typecheck:functions`) Deno 2.

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
exceed the cap. It talks to `https://api.openai.com/v1` only: with `OPENAI_BASE_URL` pointing
anywhere else it refuses to start, so a pass cannot come from a gateway or from the double. It
also refuses a price that is not above zero, because the cap is computed from the prices.

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
   in Vault for the database, after first checking that it can reach the database with the
   service key;
4. deploys `worker` and `ops` (bundled on Supabase's side, so no local Docker is needed);
5. reports the three schedules, fails when one is missing or paused or when the every-minute
   planner is not running, then has the database wake the worker once and fails unless the
   worker accepts.

It is safe to run again and never starts a campaign. It also never resumes a schedule somebody
paused: that can start paid work, so it reports the pause and stops. Everything goes over HTTPS
with the access token: no database password and no direct database connection are required.
Migrations are applied through the Management API as one transaction, so a deployment either
applies completely or changes nothing, and they are recorded in the Supabase CLI's own history
table.

The script deploys the migrations, functions and email templates **of this checkout**. It names
the commit it deploys and refuses to run while files under `supabase/` or `scripts/` differ
from that commit (`ALLOW_UNCOMMITTED=1` overrides), so what runs in production always
corresponds to a commit.

To rehearse the migrations on the project without changing it:

```bash
npm run db:push:api -- --verify
```

If you set `SUPABASE_DB_PASSWORD`, the script uses `supabase db push` over a direct connection
instead. `WORKER_SECRET` is optional: without it a new one is generated and installed on both
sides each time, so nobody has to keep it.

#### Auth settings

`npm run auth:configure` (step 1 of the deploy; `-- --check` only reports differences) sets
exactly these and leaves every other project setting alone. Do not run `supabase config push`:
`supabase/config.toml` holds local-development defaults.

- **Sign-ups disabled**, anonymous sign-ins off. People join only by invitation.
- **Email addresses must be confirmed**, and a change of address is confirmed from both the old
  and the new one. Invitations and workspace grants are addressed to an email address, so an
  account's address has to be one its holder can receive mail at.
- **Minimum password length** 10, and **replacing a password needs the current one**. One-time
  links (invitation, reset) are exempt, which is what lets them set a password.
- **Email links live for 24 hours** and work once. The **one-time code** behind each link is
  10 digits, the longest Supabase allows: a link is only as hard to guess as that code, and
  anyone can ask for a reset link for an address they know.
- **Every email template that carries a link** (invitation, password reset, sign-in link,
  confirmation, email change) from `supabase/templates/`. They all point to
  `SITE_URL/auth/confirm?token_hash=…`, a page of the web app, and your `SITE_URL` is written
  into the emails themselves. The one-time token is used only when the person presses
  **Continue** on that page, so mail scanners and chat previews that fetch the link cannot use
  it up.
- **Site URL** = `SITE_URL` and **Redirect URLs** = `SITE_URL/**` only.

The same command checks one Data API setting without changing it: **Max rows** (Project
Settings → Data API) must be at least 1000, its default. The web app reads long lists a
thousand rows at a time, and with a lower limit they would stop early without any error, so
the deploy refuses such a project.

Vercel's Supabase integration rewrites the last two on every deployment: it puts a deployment
alias back as the Site URL (one that sits behind Vercel's own login) and re-adds wildcard
redirect entries for preview deployments. That no longer affects this app: no email takes its
address from the Site URL, and no emailed link carries a redirect, so the redirect list is
never consulted. `auth:configure -- --check` will report those two as different after each
deployment; the next `deploy:supabase` sets them back.

#### Email

Supabase Auth sends the invitation and password-reset emails. Every hosted project starts on
Supabase's **built-in email service**. It needs no setup and it does send, within limits that
Supabase sets on purpose (it is there for trying Auth out, not for production use):

- It delivers **only to the people on the project's Supabase team**: the members of its
  Supabase organization, at the address of their Supabase account. For a project created
  through Vercel's Supabase integration, those accounts belong to the people in the Vercel
  team (normally under their Vercel email address). Any other address is refused
  (`email_address_not_authorized`): an invitation to it fails with "… cannot be used as it is
  not authorized", and a reset email for it is not sent.
- It sends **2 emails an hour** for the whole project.
- According to Supabase's announcement of 3 June 2026, a **Free-plan project created after
  that date** sends Supabase's standard emails through this service instead of the templates
  above. This app completes only its own links (`/auth/confirm?token_hash=…`), so on such a
  project the emails arrive but their links let nobody in until the project is on a paid plan
  or has its own sender.

So an owner whose address is on the Supabase team has working password-reset emails from the
first deployment, with nothing to configure. Inviting anyone outside that team, or sending more
than a couple of emails an hour, needs **the project's own sender**, entered under
**Authentication → Emails → SMTP Settings**: the host, port, user name and password of an SMTP
service, a From address that service lets you send from, and a sender name. Supabase then
delivers to every address, 30 emails an hour to begin with (raise it under **Authentication →
Rate Limits**). The deploy leaves these settings alone. Two usual sources of an SMTP login: a
transactional email service (Resend, for one, can be added from the Vercel Marketplace and
needs a domain of your own there; a `*.vercel.app` address cannot send mail), or a mailbox you
already have that offers SMTP. A provider with an HTTP API only can be connected through
Supabase's **Send Email hook** instead.

Nobody needs email to get in as an owner: the next step prints a one-time link.

### 2. First owner

```bash
npm run bootstrap:owner -- --email you@example.com --link
```

(With a separate env file for the hosted project, prefix it the same way as the deploy:
`ENV_FILE=.env.operator.production npm run bootstrap:owner -- …`. The command prints which
project it is acting on.)

This grants that address the right to create one workspace and prints a one-time link. Open it
in a browser to choose a password, then name the workspace. Nothing is emailed. Without
`--link` the command sends a Supabase invitation email instead (it arrives only if the
project's email sender may deliver to that address, see [Email](#email)); with `OWNER_PASSWORD`
set in the environment it creates the account with that password, which is how local
development and the tests do it.

This is for owners only: every address it is run for may create its own workspace. Other people
join an existing workspace through an invitation from **Settings → Members**. That invitation
is an email, so with the built-in email service it reaches only people on the project's
Supabase team ([Email](#email)).

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
web app reads none of them, but while they are there the web tier holds credentials that bypass
row level security. They belong to the integration's connection between the Supabase resource
and this Vercel project, so they cannot be deleted one by one under Settings → Environment
Variables. To remove them, disconnect the project from the resource (Vercel → the project →
**Integrations** → Supabase → **Manage** → the resource → **Projects**), add the two variables
in the table above as ordinary Production variables straight away, redeploy, and check the
variable list. Disconnecting removes those two as well, so do not push in between: a build
without them cannot reach Supabase. Disconnect the project only: do not delete the resource
itself, which is the database. The same connection is what rewrites
the Auth Site URL on every deployment (see "Auth settings"). If you keep the connection, those
secrets stay in Vercel: treat access to the Vercel project like access to the database. Never
add `WORKER_SECRET` or an OpenAI key to Vercel either.

**CI does not gate production by itself.** Vercel builds and promotes a push as soon as its own
build succeeds, while the CI jobs for that commit are still running, and keeps it there if they
fail. To hold a production build back until CI passes, add the three CI jobs as GitHub
Deployment Checks in the Vercel project (Settings → **Build and Deployment** → **Deployment
Checks** → **Add Checks** → GitHub): Vercel then assigns a production build to the production
domain only once they have passed. Confirm once that this also holds for a `*.vercel.app`
production domain if that is your `SITE_URL`. The alternative is a separate, protected
production branch that only receives pull requests with those checks required.

Deploy from Git rather than with the Vercel CLI from a working directory. `vercel build` packs
every `.env*` file it finds in the directory into the deployment, and the operator env files
there hold a Supabase access token. The repository's `.vercelignore` excludes them as a second
line of defence. If you must use the CLI, run it in a clean export of the commit
(`git worktree add` or `git archive`), never in the directory you operate from. `ENV_FILE`
also accepts an absolute path, so the hosted operator file can live outside the repository.

#### Updating a deployment

A push updates the web app at once; the database and the Edge Functions change only when you
run `npm run deploy:supabase`. When a commit changes both, deploy the backend from that commit
first, then push:

```bash
ENV_FILE=.env.operator.production npm run deploy:supabase
```

```bash
git push
```

In between, the previous web build runs against the new backend, so a migration should keep
working with the web build before it: add in one deployment, remove what is no longer used in
a later one.

A browser tab that was opened before a deployment belongs to the earlier build. Most buttons
keep working, and where Vercel's Skew Protection applies (it depends on the plan) the tab stays
on its own build for a while. When the server no longer has what a button calls, the tab says
"This page is out of date" and offers a reload; nothing is changed until then. Signing out
works from any tab.

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

The web app is built to hold nothing but the publishable key, and reads nothing else. Vercel's
Supabase integration nevertheless puts the secret key, the JWT secret and the database password
into the Vercel project's environment; Deploying, step 3 says how to take them out and what it
means to leave them.

API keys and authorization headers are never written to logs, tables or exports. The app shows
a key only as a masked hint such as `sk-…ab12`. Replacing a key takes effect immediately.

## Queue activation

Cron always plans and queues work for launched campaigns. The dispatcher can wake the `worker`
function once Vault holds the function's URL and the shared secret. For a hosted project
`npm run deploy:supabase` installs that secret on both sides (the function and Vault) and never
shows it, so there is nothing to keep. `npm run queues:activate` stores a secret you supply; it
is what the local stack uses, with the value from `supabase/functions/.env`.

Stored settings prove nothing by themselves, so activation ends by sending one wake-up from the
database and reporting the worker's answer. The same check on its own, which stores nothing
(for a hosted project, prefix it with the `ENV_FILE=…` you deploy with):

```bash
npm run queues:activate -- --status
```

It reports the three schedules (`lr-plan`, `lr-dispatch`, `lr-maintenance`) and fails when one
is missing or paused, or when the every-minute planner has not run for a few minutes. It then
runs one dispatch pass, the same one `lr-dispatch` runs every ten seconds, and sends the one
wake-up. That fails with the reason (HTTP 401 when the secret in the database and the
function's secret differ, 503 when the worker cannot reach the database with its service key)
instead of leaving work queued with nothing picking it up. A wake-up with nothing queued makes
the worker look for work, find none and stop.

**Settings → Operational status** shows the scheduler heartbeat, whether recent wake-ups were
accepted by the worker, queue backlog, stalled leases, connection state, provider errors and
budget exhaustion. To rotate the worker secret, run `npm run deploy:supabase` again without
`WORKER_SECRET` set: a new one is generated and installed as a function secret and in Vault.

## Backups

- **Recovery relies on Supabase's managed backups** (Dashboard → Database → Backups: daily on
  paid plans, point-in-time recovery as an add-on). A restore puts the whole database back as
  it was at that moment, so launched campaigns carry on from the restored state: pause them or
  use the emergency stop right after a restore if that is not what you want, and check each
  OpenAI connection with **Test connection**.
- A logical dump is a readable copy of your data, not a recovery path. It needs a direct
  connection to the database from the machine you run it on (the deploy itself only needs
  HTTPS). With `SUPABASE_ACCESS_TOKEN` set, the Supabase CLI connects through a temporary
  login role, so the database password is not needed; `--password` is the alternative.

```bash
npx supabase db dump --remote=<project-ref> -f backup-schema.sql
```

```bash
npx supabase db dump --remote=<project-ref> --data-only --use-copy -f backup-data.sql
```

The two files are not a complete copy. Supabase's own parts are left out or only partly
included: Vault (the OpenAI keys), the migration history, and the definitions of the queue
and the schedules. This repository has no tested procedure for loading such a dump into a new
project, so do not count on one for recovery. A new project always starts with
`npm run deploy:supabase` and with the OpenAI keys entered again in Settings.

- From the app, each campaign can be exported as CSV (results, fresh checks, usage) and JSON
  (transcripts, configuration). Exports respect workspace membership, escape spreadsheet
  formulas and contain no secrets.
- Transcript text can be removed automatically after a number of days
  (**Settings → Workspace**); counts, classifications, usage and the audit trail are kept.

## Recovery

| Situation                           | What to do                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stop all spending now               | **Settings → Workspace → Emergency stop** (owner). Requests already sent finish and are recorded. Release it to resume.                                                                                                                                                                                                                                                                                                        |
| A campaign was paused automatically | The provider rejected its model or settings. Open the campaign for the reason, fix it under **Edit**, apply the change, then **Resume**.                                                                                                                                                                                                                                                                                       |
| Connection "needs attention"        | Invalid key or exhausted quota. Fix it at OpenAI or replace the key, then **Test connection**: a successful test releases the held work.                                                                                                                                                                                                                                                                                       |
| Jobs in the review queue            | **Settings → Operational status → Review queue → Retry**. A retry continues from the last saved turn; completed turns are never sent again.                                                                                                                                                                                                                                                                                    |
| Conversation "expired"              | The provider no longer has the stored response the next turn needs. It is not replayed silently: use **Restart as a new conversation** on its page.                                                                                                                                                                                                                                                                            |
| Request with an unknown outcome     | A timeout or dropped connection after sending. Its reservation stays held. An owner decides under **Usage**: count as spent, or release after checking the provider's usage page.                                                                                                                                                                                                                                              |
| Worker stopped mid-request          | Nothing to do. The lease expires, the attempt is marked unknown or retried, and the job resumes from the last saved state.                                                                                                                                                                                                                                                                                                     |
| Budget reached                      | Raise the campaign or connection limit (or wait for the next day). Waiting jobs continue; skipped slots follow the campaign's missed-slot setting.                                                                                                                                                                                                                                                                             |
| "Queue consumers are not activated" | Hosted: run `npm run deploy:supabase` (it installs one worker secret on both sides). Local stack: `npm run queues:activate`.                                                                                                                                                                                                                                                                                                   |
| An owner cannot sign in             | `npm run bootstrap:owner -- --email <their address> --link` (with `ENV_FILE=…` for the hosted project) prints a one-time link that lets them choose a new password. No email is needed.                                                                                                                                                                                                                                        |
| An email link says it has expired   | Links work once and for a limited time. Send a new invitation or reset email; for an owner the email cannot reach, use the one-time link above.                                                                                                                                                                                                                                                                                |
| An invitation "is not authorized"   | The project is on Supabase's built-in email service, which delivers only to the people on the project's Supabase team. Give the project its own sender ([Email](#email)), then invite the person again.                                                                                                                                                                                                                        |
| A reset email does not arrive       | The page gives the same reply whether or not an email went out. The built-in email service sends 2 emails an hour and only to the project's Supabase team: wait an hour before asking again, check spam, or use the one-time link for owners above. Addresses outside the team need the project's own sender ([Email](#email)).                                                                                                |
| A migration fails during a deploy   | Through the Management API (the default) nothing was applied: the deployment is one transaction and the command names the failing file. When the request itself failed (too large, a gateway timeout, a lost reply) it says so, blames no file and reports what the project records. With `SUPABASE_DB_PASSWORD` (`supabase db push`), files before the failing one stay applied. Fix and run `npm run deploy:supabase` again. |
| Scheduler heartbeat is stale        | `npm run queues:activate -- --status` (with your `ENV_FILE=…` for a hosted project) says which of `lr-plan`, `lr-dispatch` and `lr-maintenance` is missing or paused. Resume a paused one under Dashboard → Integrations → Cron. `npm run deploy:supabase` puts back a schedule that was removed; it never resumes a paused one.                                                                                               |

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
