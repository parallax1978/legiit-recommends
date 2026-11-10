import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakeOpenAI } from "../support/fake-openai.ts";
import {
  admin,
  closeConnections,
  createCampaign,
  createConnection,
  createWorkspace,
  drain,
  expectDbError,
  launch,
  ops,
  resetDatabase,
  rpc,
  sql,
  startFake,
  tick,
  work,
  type CampaignFixture,
  type ConnectionFixture,
  type Workspace,
} from "./harness.ts";

let fake: FakeOpenAI;

beforeAll(async () => {
  fake = await startFake();
});
afterAll(async () => {
  await fake.stop();
  await closeConnections();
});
beforeEach(async () => {
  await resetDatabase();
  fake.reset();
});

/** A price that makes the arithmetic obvious: $1 per 1,000 tokens in either direction. */
async function roundPrice(workspace: Workspace, model: string): Promise<void> {
  await rpc(workspace.owner.client, "add_model_price", {
    p_workspace_id: workspace.id,
    p_price: {
      model_id: model,
      input_usd_per_mtok: 1000,
      cached_input_usd_per_mtok: 100,
      output_usd_per_mtok: 1000,
      source_url: "https://example.test/pricing",
      verified_on: "2026-11-10",
    },
  });
}

function adhoc(
  workspace: Workspace,
  connection: ConnectionFixture,
  campaignId: string | null = null,
  tokens = 1000,
) {
  return rpc<{ ok: boolean; code?: string; attempt_ids?: string[]; reserved_usd?: number }>(
    admin(),
    "svc_begin_adhoc",
    {
      p_workspace_id: workspace.id,
      p_actor: workspace.owner.id,
      p_connection_id: connection.id,
      p_purpose: "variation_generation",
      p_model: connection.model,
      p_requests: [{ est_input_tokens: tokens, max_output_tokens: tokens }],
      p_campaign_id: campaignId,
    },
  );
}

const sumOpen = async (connectionId: string) =>
  Number(
    (
      await sql<{ total: string }>(
        "select coalesce(sum(amount_usd), 0) as total from public.budget_reservations where connection_id = $1 and status in ('held', 'unresolved')",
        [connectionId],
      )
    )[0]!.total,
  );

async function spend(
  campaign: CampaignFixture,
  workspace: Workspace,
  connection: ConnectionFixture,
  amount: number,
  campaignDay: string | null = null,
): Promise<void> {
  // A settled attempt with a known cost, as if a request had been made earlier.
  await sql(
    `with a as (
       insert into public.provider_attempts (workspace_id, connection_id, campaign_id, purpose, status, requested_model, finished_at, cost_usd)
       values ($1, $2, $3, 'conversation_turn', 'succeeded', $4, now(), $5) returning id
     )
     insert into public.usage_ledger (workspace_id, connection_id, campaign_id, attempt_id, purpose, model, cost_usd, connection_day, campaign_day)
     select $1, $2, $3, a.id, 'conversation_turn', $4, $5, (now() at time zone 'UTC')::date, coalesce($6::date, (now() at time zone 'UTC')::date) from a`,
    [workspace.id, connection.id, campaign.id, connection.model, amount, campaignDay],
  );
}

describe("spending reservations", () => {
  it("never lets concurrent reservations exceed the connection's daily cap", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake, { dailyBudget: 10 });
    await roundPrice(workspace, connection.model);

    // Model verification already spent a few cents today; that counts against the same cap.
    const [already] = await sql<{ spent: string }>(
      "select coalesce(sum(cost_usd), 0) as spent from public.usage_ledger where connection_id = $1",
      [connection.id],
    );
    const spent = Number(already!.spent);
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThan(2);

    // Each request reserves exactly $2.00, so the $10 cap has room for four more, never five.
    const results = await Promise.all(
      Array.from({ length: 24 }, () => adhoc(workspace, connection)),
    );
    const accepted = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);
    expect(accepted).toHaveLength(Math.floor((10 - spent) / 2));
    expect(accepted).toHaveLength(4);
    expect(refused).toHaveLength(20);
    expect(refused.every((r) => r.code === "connection_daily_budget_exhausted")).toBe(true);
    expect(accepted.every((r) => Number(r.reserved_usd) === 2)).toBe(true);
    expect(await sumOpen(connection.id)).toBe(8);
    expect(spent + (await sumOpen(connection.id))).toBeLessThanOrEqual(10);

    // Releasing one makes room for exactly one more.
    await rpc(admin(), "svc_finish_adhoc", {
      p_attempt_id: accepted[0]!.attempt_ids![0],
      p_outcome: { status: "failed", error_class: "server_error" },
    });
    const again = await Promise.all(Array.from({ length: 6 }, () => adhoc(workspace, connection)));
    expect(again.filter((r) => r.ok)).toHaveLength(1);
    expect(await sumOpen(connection.id)).toBe(8);
  });

  it("reconciles a reservation against returned usage and keeps the difference available", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake, { dailyBudget: 10 });
    await roundPrice(workspace, connection.model);

    const begun = await adhoc(workspace, connection);
    const attemptId = begun.attempt_ids![0]!;
    await rpc(admin(), "svc_finish_adhoc", {
      p_attempt_id: attemptId,
      p_outcome: {
        status: "succeeded",
        usage: {
          input_tokens: 400,
          cached_tokens: 100,
          cache_write_tokens: 0,
          cache_write_30m_tokens: 0,
          cache_write_12h_tokens: 0,
          output_tokens: 50,
          reasoning_tokens: 10,
          total_tokens: 450,
        },
      },
    });
    const [reservation] = await sql<{
      status: string;
      amount_usd: string;
      settled_cost_usd: string;
    }>(
      "select status, amount_usd, settled_cost_usd from public.budget_reservations where attempt_id = $1",
      [attemptId],
    );
    // 300 uncached input + 100 cached at a tenth of the price + 50 output.
    expect(reservation).toMatchObject({ status: "settled" });
    expect(Number(reservation!.amount_usd)).toBe(2);
    expect(Number(reservation!.settled_cost_usd)).toBeCloseTo(0.3 + 0.01 + 0.05, 8);
    const [ledger] = await sql<{
      cost_usd: string;
      cached_input_tokens: number;
      reasoning_tokens: number;
      basis: string;
      purpose: string;
    }>(
      "select cost_usd, cached_input_tokens, reasoning_tokens, basis, purpose from public.usage_ledger where attempt_id = $1",
      [attemptId],
    );
    expect(ledger).toMatchObject({
      cached_input_tokens: 100,
      reasoning_tokens: 10,
      basis: "usage",
      purpose: "variation_generation",
    });
    expect(Number(ledger!.cost_usd)).toBeCloseTo(0.36, 8);

    // $0.36 (plus verification) spent of $10: four more $2 reservations fit, a fifth does not.
    const more = await Promise.all(Array.from({ length: 8 }, () => adhoc(workspace, connection)));
    expect(more.filter((r) => r.ok)).toHaveLength(4);
  });

  it("applies connection total, campaign daily and campaign total caps independently", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake, {
      dailyBudget: 1000,
      totalBudget: 9,
    });
    const campaign = await createCampaign(workspace, connection, {
      questions: null,
      config: { daily_budget_usd: 5, total_budget_usd: 7 },
    });
    await roundPrice(workspace, connection.model);

    // Campaign daily ($5): two $2 reservations fit, the third does not.
    expect((await adhoc(workspace, connection, campaign.id)).ok).toBe(true);
    expect((await adhoc(workspace, connection, campaign.id)).ok).toBe(true);
    expect(await adhoc(workspace, connection, campaign.id)).toMatchObject({
      ok: false,
      code: "campaign_daily_budget_exhausted",
    });

    // Outside the campaign the connection still has room, until its own total ($9) is reached.
    expect((await adhoc(workspace, connection)).ok).toBe(true);
    expect((await adhoc(workspace, connection)).ok).toBe(true);
    expect(await adhoc(workspace, connection)).toMatchObject({
      ok: false,
      code: "connection_total_budget_exhausted",
    });

    // Campaign total ($7) across days: yesterday's spend counts toward the total, not toward today.
    await sql(
      "update public.budget_reservations set status = 'released' where connection_id = $1",
      [connection.id],
    );
    const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10);
    await spend(campaign, workspace, connection, 5.5, yesterday);
    await rpc(workspace.owner.client, "update_connection", {
      p_connection_id: connection.id,
      p_patch: { total_budget_usd: null },
    });
    expect(await adhoc(workspace, connection, campaign.id)).toMatchObject({
      ok: false,
      code: "campaign_total_budget_exhausted",
    });
    expect((await adhoc(workspace, connection, campaign.id, 500)).ok).toBe(true); // $1 still fits
  });

  it("uses the campaign's own timezone for its daily boundary and UTC for the connection", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake, { dailyBudget: 3 });
    const campaign = await createCampaign(workspace, connection, {
      questions: null,
      config: { timezone: "Pacific/Auckland", daily_budget_usd: 3, total_budget_usd: 100 },
    });
    await roundPrice(workspace, connection.model);

    const block = async (now: string, campaignId: string | null) =>
      (
        await sql<{ result: { code: string; until: string } | null }>(
          `select app_private.budget_block(c, $2, 2, false, $3::timestamptz) as result
         from public.provider_connections c where c.id = $1`,
          [connection.id, campaignId, now],
        )
      )[0]!.result;

    // $2 already spent on the campaign's local day 2026-11-12 (Auckland is UTC+13 in November).
    await sql(
      `with a as (
         insert into public.provider_attempts (workspace_id, connection_id, campaign_id, purpose, status, requested_model)
         values ($1, $2, $3, 'conversation_turn', 'succeeded', $4) returning id)
       insert into public.usage_ledger (workspace_id, connection_id, campaign_id, attempt_id, purpose, model, cost_usd, connection_day, campaign_day)
       select $1, $2, $3, a.id, 'conversation_turn', $4, 2, date '2026-11-10', date '2026-11-12' from a`,
      [workspace.id, connection.id, campaign.id, connection.model],
    );

    // 10:30 UTC on Nov 11 is 23:30 on Nov 11 in Auckland: a different local day, so it fits.
    expect(await block("2026-11-11T10:30:00Z", campaign.id)).toBeNull();
    // 11:30 UTC on Nov 11 is 00:30 on Nov 12 in Auckland: the cap for that local day is used up.
    const blocked = await block("2026-11-11T11:30:00Z", campaign.id);
    expect(blocked).toMatchObject({ code: "campaign_daily_budget_exhausted" });
    // It reopens at the next local midnight: 2026-11-13 00:00 in Auckland = 11:00 UTC on Nov 12.
    expect(new Date(blocked!.until).toISOString()).toBe("2026-11-12T11:00:00.000Z");

    // The connection cap follows the UTC day the spend was recorded on (Nov 10).
    expect(await block("2026-11-10T23:59:00Z", null)).toMatchObject({
      code: "connection_daily_budget_exhausted",
    });
    expect(await block("2026-11-11T00:00:01Z", null)).toBeNull();
    const utc = await block("2026-11-10T12:00:00Z", null);
    expect(new Date(utc!.until).toISOString()).toBe("2026-11-11T00:00:00.000Z");
  });

  it("sets money aside for the final fresh checks", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, {
      config: {
        baseline_samples: 0,
        daily_checks: 0,
        final_samples: 4,
        daily_budget_usd: 50,
        total_budget_usd: 10,
      },
    });
    await launch(workspace, campaign);
    const [revision] = await sql<{ aside: string; est_check: string }>(
      "select final_check_set_aside_usd as aside, est_check_max_cost_usd as est_check from public.campaign_revisions where id = $1",
      [campaign.revisionId],
    );
    const aside = Number(revision!.aside);
    expect(aside).toBeCloseTo(4 * Number(revision!.est_check), 8);
    expect(aside).toBeGreaterThan(0);

    // Spend everything except the amount set aside.
    await spend(campaign, workspace, connection, 10 - aside);
    const block = async (isFinal: boolean, amount: number) =>
      (
        await sql<{ result: { code: string } | null }>(
          "select app_private.budget_block(c, $2, $3, $4, now()) as result from public.provider_connections c where c.id = $1",
          [connection.id, campaign.id, amount, isFinal],
        )
      )[0]!.result;
    // Conversations and scheduled checks can no longer reserve anything...
    expect(await block(false, Number(revision!.est_check))).toMatchObject({
      code: "campaign_total_budget_exhausted",
    });
    // ...but every final check still fits.
    expect(await block(true, aside)).toBeNull();
    expect(await block(true, aside + 0.01)).toMatchObject({
      code: "campaign_total_budget_exhausted",
    });
  });

  it("blocks paid requests when no price is recorded for the model", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const result = await rpc<{ ok: boolean; code: string }>(admin(), "svc_begin_adhoc", {
      p_workspace_id: workspace.id,
      p_actor: workspace.owner.id,
      p_connection_id: connection.id,
      p_purpose: "variation_generation",
      p_model: "fake-reasoning-1",
      p_requests: [{ est_input_tokens: 10, max_output_tokens: 16 }],
    });
    expect(result).toMatchObject({ ok: false, code: "price_missing" });
    // Verification of an unpriced model is refused before any request is made.
    const before = fake.requests.length;
    expect(
      await ops(workspace.owner, fake, "model.verify", {
        connection_id: connection.id,
        model_id: "fake-reasoning-1",
        max_output_tokens: 64,
      }),
    ).toMatchObject({ ok: false, code: "price_missing" });
    expect(fake.requests.length).toBe(before);

    // A campaign on an unpriced model cannot be launched.
    const campaign = await createCampaign(workspace, connection, {
      questions: null,
      config: { model: "fake-reasoning-1" },
    });
    const failure = await expectDbError(launch(workspace, campaign), "campaign_invalid");
    expect(failure.message).toMatch(/not been verified|No price/);

    // And a connection can never be left without a daily limit.
    await expectDbError(
      rpc(workspace.owner.client, "update_connection", {
        p_connection_id: connection.id,
        p_patch: { daily_budget_usd: null },
      }),
      "invalid_budget",
    );
  });
});

describe("budget during execution", () => {
  async function launched(config: Record<string, unknown>, connectionOptions = {}) {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake, {
      maxConcurrent: 8,
      ...connectionOptions,
    });
    const campaign = await createCampaign(workspace, connection, {
      questions: null,
      config: { conversations_per_day: 1440, max_concurrency: 8, ...config },
    });
    fake.reset();
    await launch(workspace, campaign);
    const [revision] = await sql<{ est: string }>(
      "select est_run_max_cost_usd as est from public.campaign_revisions where id = $1",
      [campaign.revisionId],
    );
    const slots = await sql<{ scheduled_for: Date }>(
      "select scheduled_for from public.jobs where campaign_id = $1 and kind = 'conversation' order by scheduled_for limit 6",
      [campaign.id],
    );
    return { workspace, connection, campaign, est: Number(revision!.est), slots };
  }

  it("reserves the worst case before each request and settles to actual usage after it", async () => {
    const { campaign, slots } = await launched({});
    await tick(new Date(slots[0]!.scheduled_for));

    // During the request the full conservative amount is held.
    let heldDuringRequest = 0;
    let reservedInput = 0;
    await work(
      fake,
      {},
      {
        afterBeginAttempt: async () => {
          const [row] = await sql<{ amount_usd: string; status: string; est_input_tokens: number }>(
            "select r.amount_usd, r.status, a.est_input_tokens from public.budget_reservations r join public.provider_attempts a on a.id = r.attempt_id where r.campaign_id = $1",
            [campaign.id],
          );
          expect(row!.status).toBe("held");
          heldDuringRequest = Number(row!.amount_usd);
          reservedInput = row!.est_input_tokens;
        },
      },
    );
    await drain(fake);

    const rows = await sql<{
      amount_usd: string;
      settled_cost_usd: string;
      status: string;
      est_input_tokens: number;
      input_tokens: number;
      max_output_tokens: number;
      output_tokens: number;
    }>(
      `select r.amount_usd, r.settled_cost_usd, r.status, a.est_input_tokens, a.input_tokens, a.max_output_tokens, a.output_tokens
       from public.budget_reservations r join public.provider_attempts a on a.id = r.attempt_id
       where r.campaign_id = $1 order by a.started_at`,
      [campaign.id],
    );
    expect(rows).toHaveLength(3);
    expect(Number(rows[0]!.amount_usd)).toBe(heldDuringRequest);
    expect(rows[0]!.est_input_tokens).toBe(reservedInput);
    for (const row of rows) {
      expect(row.status).toBe("settled");
      // The reservation covered the whole submitted context and the output cap.
      expect(row.est_input_tokens).toBeGreaterThanOrEqual(row.input_tokens);
      expect(row.max_output_tokens).toBeGreaterThanOrEqual(row.output_tokens);
      expect(Number(row.amount_usd)).toBeGreaterThanOrEqual(Number(row.settled_cost_usd));
    }
    // Later turns reserve more: the earlier turns are part of what is submitted.
    expect(rows[1]!.est_input_tokens).toBeGreaterThan(rows[0]!.est_input_tokens);
    expect(rows[2]!.est_input_tokens).toBeGreaterThan(rows[1]!.est_input_tokens);

    const [totals] = await sql<{ ledger: string; turns: string }>(
      `select (select sum(cost_usd) from public.usage_ledger where campaign_id = $1) as ledger,
              (select sum(cost_usd) from public.run_turns where campaign_id = $1) as turns`,
      [campaign.id],
    );
    expect(Number(totals!.ledger)).toBeCloseTo(Number(totals!.turns), 8);
    expect(Number(totals!.ledger)).toBeGreaterThan(0);
  });

  it("does not start more conversations than the daily budget can carry to completion", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake, { maxConcurrent: 8 });
    const draft = await createCampaign(workspace, connection, {
      questions: null,
      config: { conversations_per_day: 1440, max_concurrency: 8 },
    });
    const preview = await rpc<{
      est_run_max_cost_usd: number;
      daily_budget_shortfall: boolean;
      conversations_within_daily_budget: number;
    }>(workspace.owner.client, "campaign_plan_preview", { p_campaign_id: draft.id });
    const est = Number(preview.est_run_max_cost_usd);
    // Room for two worst-case conversations a day, with 1,440 scheduled.
    await rpc(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: draft.id,
      p_patch: {
        config: { daily_budget_usd: Number((est * 2.4).toFixed(4)), total_budget_usd: 50 },
      },
    });
    const shortfall = await rpc<{
      daily_budget_shortfall: boolean;
      conversations_within_daily_budget: number;
      planned_conversations: number;
    }>(workspace.owner.client, "campaign_plan_preview", { p_campaign_id: draft.id });
    // The projected shortfall is shown before launch.
    expect(shortfall.daily_budget_shortfall).toBe(true);
    expect(shortfall.conversations_within_daily_budget).toBe(2);
    expect(shortfall.planned_conversations).toBeGreaterThan(100);

    fake.reset();
    await launch(workspace, draft);
    const slots = await sql<{ scheduled_for: Date }>(
      "select scheduled_for from public.jobs where campaign_id = $1 and kind = 'conversation' order by scheduled_for limit 5",
      [draft.id],
    );
    await tick(new Date(slots[4]!.scheduled_for));
    // Five slots are due and concurrency would allow eight, but only two are started.
    const started = await sql("select 1 from public.runs where campaign_id = $1", [draft.id]);
    expect(started).toHaveLength(2);
    await drain(fake);
    expect(
      (
        await sql<{ status: string }>("select status from public.runs where campaign_id = $1", [
          draft.id,
        ])
      ).every((r) => r.status === "completed"),
    ).toBe(true);
  });

  it("skips slots visibly once the daily budget is used up, and blocks nothing silently", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake, { maxConcurrent: 8 });
    const campaign = await createCampaign(workspace, connection, {
      questions: null,
      startAt: new Date(Date.now() + 90_000),
      config: {
        conversations_per_day: 1440,
        max_concurrency: 8,
        daily_budget_usd: 5,
        total_budget_usd: 50,
      },
    });
    fake.reset();
    await launch(workspace, campaign);
    const [revision] = await sql<{ est: string }>(
      "select est_run_max_cost_usd as est from public.campaign_revisions where id = $1",
      [campaign.revisionId],
    );
    const est = Number(revision!.est);
    // Today's budget is already spent apart from less than one worst-case conversation.
    await spend(campaign, workspace, connection, 5 - est / 2);
    await tick(new Date(Date.now() + 91_000));
    const slots = await sql<{ scheduled_for: Date }>(
      "select scheduled_for from public.jobs where campaign_id = $1 and kind = 'conversation' order by scheduled_for limit 2",
      [campaign.id],
    );
    await tick(new Date(slots[1]!.scheduled_for));

    const jobs = await sql<{ status: string; status_reason: string }>(
      "select status, status_reason from public.jobs where campaign_id = $1 and kind = 'conversation' order by scheduled_for limit 2",
      [campaign.id],
    );
    expect(jobs).toEqual([
      { status: "skipped", status_reason: "campaign_daily_budget_exhausted" },
      { status: "skipped", status_reason: "campaign_daily_budget_exhausted" },
    ]);
    expect(fake.responseRequests()).toHaveLength(0);

    const budget = await rpc<{
      campaigns: { budget_skips: number; spent_today_usd: number; daily_budget_usd: number }[];
    }>(workspace.owner.client, "budget_status", { p_workspace_id: workspace.id });
    expect(budget.campaigns[0]).toMatchObject({ budget_skips: 2 });
    const health = await rpc<{ workspace: { budget_exhausted: { reason: string }[] } }>(
      workspace.owner.client,
      "operational_status",
      { p_workspace_id: workspace.id },
    );
    expect(health.workspace.budget_exhausted).toEqual([
      { campaign_id: campaign.id, reason: "campaign_daily_budget_exhausted" },
    ]);
  });

  it("holds a conversation mid-way when the budget runs out and continues it when budget returns", async () => {
    const { workspace, connection, campaign, slots } = await launched({
      daily_budget_usd: 5,
      total_budget_usd: 50,
    });
    await tick(new Date(slots[0]!.scheduled_for));
    await drain(fake, { max: 1 }); // first turn done

    // The rest of today's budget disappears (for example through another campaign's test).
    await spend(campaign, workspace, connection, 4.999);
    expect(await work(fake)).toMatchObject({
      result: "gate:blocked:campaign_daily_budget_exhausted",
    });
    const [blocked] = await sql<{ status: string; status_reason: string; blocked_until: Date }>(
      "select status, status_reason, blocked_until from public.jobs where campaign_id = $1 and status = 'blocked'",
      [campaign.id],
    );
    expect(blocked).toMatchObject({
      status: "blocked",
      status_reason: "campaign_daily_budget_exhausted",
    });
    // The conversation is not abandoned or restarted: its first turn stays as recorded.
    const [run] = await sql<{ status: string; steps_completed: number }>(
      "select status, steps_completed from public.runs where campaign_id = $1",
      [campaign.id],
    );
    expect(run).toEqual({ status: "in_progress", steps_completed: 1 });
    expect(fake.responseRequests()).toHaveLength(1);

    // Nothing is released before the cap resets.
    await tick(new Date(new Date(blocked!.blocked_until).getTime() - 60_000));
    expect((await work(fake)).status).toBe("idle");

    // An owner raising the cap releases it immediately.
    await rpc(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: campaign.id,
      p_patch: { config: { daily_budget_usd: 20 } },
    });
    const check = await rpc<{ revision_id: string }>(
      workspace.owner.client,
      "campaign_launch_check",
      { p_campaign_id: campaign.id },
    );
    await rpc(workspace.owner.client, "apply_campaign_changes", {
      p_campaign_id: campaign.id,
      p_expected_revision_id: check.revision_id,
    });
    await drain(fake);
    const turns = await sql<{ response_id: string; previous_response_id: string | null }>(
      "select response_id, previous_response_id from public.run_turns where campaign_id = $1 order by step_index",
      [campaign.id],
    );
    expect(turns[1]!.previous_response_id).toBe(turns[0]!.response_id);
    expect(
      (
        await sql<{ status: string }>(
          "select status from public.runs where campaign_id = $1 order by created_at limit 1",
          [campaign.id],
        )
      )[0]!.status,
    ).toBe("completed");
  });

  it("charges tests, verification and generation to the same ledger", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, { questions: null });
    await rpc(workspace.owner.client, "request_test_conversation", { p_campaign_id: campaign.id });
    await drain(fake);
    const generated = await ops(workspace.owner, fake, "variations.generate", {
      workspace_id: workspace.id,
      campaign_id: campaign.id,
      kind: "inclusion_request",
      count: 3,
    });
    expect(generated).toMatchObject({ ok: true });

    const byPurpose = await sql<{ purpose: string; is_test: boolean; n: string; cost: string }>(
      "select purpose, is_test, count(*) as n, sum(cost_usd) as cost from public.usage_ledger where workspace_id = $1 group by purpose, is_test order by purpose",
      [workspace.id],
    );
    const purposes = Object.fromEntries(
      byPurpose.map((row) => [row.purpose + (row.is_test ? ":test" : ""), Number(row.n)]),
    );
    expect(purposes["conversation_turn:test"]).toBe(3);
    expect(purposes["variation_generation"]).toBe(1);
    expect(purposes["model_probe"]).toBeGreaterThanOrEqual(5);
    expect(byPurpose.every((row) => Number(row.cost) > 0)).toBe(true);

    // Nothing is left reserved once everything has resolved, and rejected probe requests were released.
    const open = await sql(
      "select 1 from public.budget_reservations where workspace_id = $1 and status in ('held', 'unresolved')",
      [workspace.id],
    );
    expect(open).toHaveLength(0);
    const released = await sql(
      "select 1 from public.budget_reservations where workspace_id = $1 and status = 'released'",
      [workspace.id],
    );
    expect(released.length).toBeGreaterThan(0);

    // The usage report agrees with the ledger.
    const usage = await rpc<{ cost_usd: number; requests: number }[]>(
      workspace.owner.client,
      "usage_daily",
      {
        p_workspace_id: workspace.id,
        p_from: "2020-01-01",
        p_to: "2099-01-01",
      },
    );
    const reported = usage.reduce((sum, row) => sum + Number(row.cost_usd), 0);
    const actual = byPurpose.reduce((sum, row) => sum + Number(row.cost), 0);
    expect(reported).toBeCloseTo(actual, 8);
  });
});
