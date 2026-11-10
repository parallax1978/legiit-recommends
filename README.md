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

| Path                               | Contents                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/`                             | Next.js app (App Router), server actions, export routes                                       |
| `supabase/migrations/`             | Schema, RLS, functions, queue and cron setup, default price list                              |
| `supabase/functions/worker`, `ops` | Edge Functions                                                                                |
| `supabase/functions/_shared/`      | Provider adapter, engine, detection, templates, cost math (shared with the web app and tests) |
| `scripts/`                         | Owner bootstrap, queue activation, deployment, live smoke test                                |
| `tests/`                           | Unit, integration (real local Supabase) and end-to-end (browser) tests                        |

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
| `test:unit`        | Detection, templates, selection, cost math, CSV, timezone handling                                    | none             |
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

You need a Supabase project and a Vercel project. Put the operator values in a file named
`.env.operator` in the repository root (see `.env.example`); it is git-ignored and Next.js does
not read it.

### 1. Supabase

Create a project, then collect from the dashboard: the project ref, the database password, the
project URL, the **publishable** key and the **secret** key. The migrations enable the
extensions they need (`pgmq`, `pg_cron`, `pg_net`, `supabase_vault`).

```bash
npx supabase login
```

```bash
openssl rand -hex 32
```

Use the generated value as `WORKER_SECRET`, fill in `.env.operator`, then:

```bash
npm run deploy:supabase
```

The script applies the migrations, pushes the Auth settings and email templates, sets the Edge
Function secrets (`WORKER_SECRET`, `SITE_URL`), deploys `worker` and `ops`, and activates the
queue consumer. It is safe to run again and never starts a campaign.

#### Auth settings

`deploy:supabase` configures these from `supabase/config.toml` (set `SKIP_CONFIG_PUSH=1` to do
it by hand under **Authentication** in the dashboard):

- **Site URL**: your `SITE_URL`. **Redirect URLs**: `SITE_URL/**`.
- **Sign-ups disabled.** People join only by invitation from a workspace owner.
- **Minimum password length** 10.
- **Invite** and **Reset password** email templates from `supabase/templates/`. Their links go to
  `SITE_URL/auth/confirm?token_hash=…&type=invite|recovery`, which verifies the one-time token on
  the server and sends the person on to set a password.

Supabase's built-in email sender is rate-limited and intended for testing. Configure your own
SMTP provider under **Authentication → Emails** before inviting people.

### 2. First owner

```bash
npm run bootstrap:owner -- --email you@example.com
```

This grants that address the right to create one workspace and sends it an invitation email.
The owner sets a password from the link and names the workspace on first sign-in. (Without
working email, set `OWNER_PASSWORD` in the environment to create the account directly.) It
creates no campaigns or other data and can be run again.

### 3. Vercel

The web app needs exactly two environment variables, both safe for browsers:

| Variable                               | Value                               |
| -------------------------------------- | ----------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | `https://<project-ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | the publishable key                 |

Either import the repository in the Vercel dashboard and add them for Production, or run:

```bash
npm run deploy:vercel
```

Never add the Supabase secret key, `WORKER_SECRET` or an OpenAI key to Vercel. If the deployed
URL differs from the `SITE_URL` you used in step 1, run `npm run deploy:supabase` again with the
new value so email links point to the right place.

### 4. Connect OpenAI

Sign in as the owner and open **Settings → OpenAI connections**: add a connection with a daily
spending limit, paste the API key, then verify the model you want to use. Verification sends a
few very small real requests to learn which settings the model accepts; they are reserved
against the daily limit and listed under Usage. Record the data-sharing setting you see in your
OpenAI organization (it is a dated note, not a switch; see
[OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)).

Check the default price list under **Settings → Model pricing** against OpenAI's current prices
before relying on budgets, and add a price version for any model that is missing. A model with
no price cannot be used.

## Where secrets live

| Secret              | Stored in                                                   | Readable by                                                  |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| OpenAI API key      | Supabase Vault (entered in the app)                         | the `worker` and `ops` Edge Functions only                   |
| `WORKER_SECRET`     | Edge Function secret and Vault                              | Supabase Cron (to wake the worker) and the `worker` function |
| Supabase secret key | Supabase (provided to Edge Functions), your `.env.operator` | Edge Functions, operator scripts                             |
| Publishable key     | Vercel environment                                          | browsers (by design)                                         |

API keys and authorization headers are never written to logs, tables or exports. The app shows
a key only as a masked hint such as `sk-…ab12`. Replacing a key takes effect immediately.

## Queue activation

Cron always plans and queues work for launched campaigns. `npm run queues:activate` stores, in
Vault, the URL of the `worker` function and the shared secret, which lets the dispatcher wake it.
`deploy:supabase` does this for you. To check the current state:

```bash
npm run queues:activate -- --status
```

**Settings → Operational status** shows the scheduler heartbeat, queue backlog, stalled leases,
connection state, provider errors and budget exhaustion, and warns when consumers are not
activated. To rotate the worker secret, set the new value in `.env.operator` and run
`npm run deploy:supabase` again.

## Backups

- Use Supabase's managed backups (daily, or point-in-time recovery on plans that include it).
- For your own copy, dump the schema and the data:

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
