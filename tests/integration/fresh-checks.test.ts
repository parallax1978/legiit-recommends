import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakeOpenAI } from "../support/fake-openai.ts";
import {
  TARGET,
  campaignStatus,
  closeConnections,
  createCampaign,
  createConnection,
  createWorkspace,
  drain,
  expectDbError,
  launch,
  resetDatabase,
  rpc,
  sql,
  startFake,
  tick,
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

interface CheckRow {
  id: string;
  phase: string;
  status: string;
  is_held_out: boolean;
  rendered_prompt: string;
  response_id: string;
  inclusion: string | null;
  exclusion_reason: string | null;
  comparison_group_id: string;
}

const checks = (campaignId: string) =>
  sql<CheckRow>(
    "select id, phase, status, is_held_out, rendered_prompt, response_id, inclusion, exclusion_reason, comparison_group_id from public.fresh_checks where campaign_id = $1 order by created_at, id",
    [campaignId],
  );

describe("fresh checks", () => {
  it("collects the baseline before any conversation is dispatched", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, {
      config: { baseline_samples: 4 },
    });
    fake.reset();

    await launch(workspace, campaign);
    expect(await campaignStatus(campaign.id)).toBe("baseline");

    // While the baseline is outstanding nothing else exists: no conversation slots, no runs.
    const before = await sql<{ kind: string; n: string }>(
      "select kind, count(*) as n from public.jobs where campaign_id = $1 group by kind",
      [campaign.id],
    );
    expect(before).toEqual([{ kind: "check_baseline", n: "4" }]);

    await drain(fake);
    await tick();
    expect(await campaignStatus(campaign.id)).toBe("running");

    const baseline = await checks(campaign.id);
    expect(baseline).toHaveLength(4);
    expect(
      baseline.every((check) => check.phase === "baseline" && check.status === "completed"),
    ).toBe(true);
    // Questions are allocated evenly across the set, held-out ones included.
    expect(baseline.filter((check) => check.is_held_out)).toHaveLength(2);

    const [timing] = await sql<{ ok: boolean }>(
      `select (select max(completed_at) from public.fresh_checks where campaign_id = $1 and phase = 'baseline')
              <= (select min(scheduled_for) from public.jobs where campaign_id = $1 and kind = 'conversation') as ok`,
      [campaign.id],
    );
    expect(timing!.ok).toBe(true);
  });

  it("never sends target, campaign or conversation context with a fresh check", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, {
      config: { baseline_samples: 4 },
    });
    fake.reset();
    await launch(workspace, campaign);
    await drain(fake);

    const requests = fake.responseRequests();
    expect(requests).toHaveLength(4);
    const forbidden = [
      TARGET.business_name,
      "Northwind",
      "northwindroasters",
      ...TARGET.business_aliases,
      ...TARGET.domain_aliases,
      campaign.id,
      campaign.revisionId,
      workspace.id,
      connection.id,
    ];
    for (const request of requests) {
      // Exactly one question and the model settings: nothing else.
      expect(Object.keys(request.body!).sort()).toEqual([
        "input",
        "max_output_tokens",
        "model",
        "store",
      ]);
      expect(request.body).not.toHaveProperty("previous_response_id");
      expect(request.body).not.toHaveProperty("instructions");
      expect(request.body).not.toHaveProperty("metadata");
      expect(request.body!.store).toBe(false);
      for (const text of forbidden)
        expect(request.raw.toLowerCase()).not.toContain(text.toLowerCase());
      // The only identifier sent is the opaque attempt id.
      const clientRequestId = request.headers["x-client-request-id"]!;
      const attempts = await sql(
        "select 1 from public.provider_attempts where id::text = $1 and purpose = 'fresh_check'",
        [clientRequestId],
      );
      expect(attempts).toHaveLength(1);
    }
    expect(new Set(requests.map((r) => r.body!.input))).toEqual(
      new Set([
        "Which coffee subscription services would you recommend in Portland?",
        "Who offers great coffee subscription services near Portland?",
      ]),
    );
  });

  it("stays independent of conversations that already promoted the target", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, {
      config: { baseline_samples: 2, daily_checks: 24, conversations_per_day: 24 },
    });
    fake.reset();
    await launch(workspace, campaign);
    await drain(fake);
    await tick();

    // Run one conversation (which adds the target to its own list), then one scheduled check.
    const [slot] = await sql<{ scheduled_for: Date }>(
      "select scheduled_for from public.jobs where campaign_id = $1 and kind = 'conversation' and status = 'pending' order by scheduled_for limit 1",
      [campaign.id],
    );
    await tick(new Date(slot!.scheduled_for));
    await drain(fake);
    const [checkSlot] = await sql<{ scheduled_for: Date }>(
      "select scheduled_for from public.jobs where campaign_id = $1 and kind = 'check_daily' and status = 'pending' order by scheduled_for limit 1",
      [campaign.id],
    );
    await tick(new Date(checkSlot!.scheduled_for));
    await drain(fake);

    const [turn] = await sql<{ response_id: string }>(
      "select response_id from public.run_turns where campaign_id = $1 and step_index = 3",
      [campaign.id],
    );
    const daily = (await checks(campaign.id)).filter(
      (check) => check.phase === "daily" && check.status === "completed",
    );
    expect(daily.length).toBeGreaterThan(0);
    for (const check of daily) {
      const stored = fake.requests.find(
        (r) => r.body?.input === check.rendered_prompt && !r.body?.previous_response_id,
      );
      expect(stored).toBeDefined();
      // A single question with no link to the conversation's response chain.
      expect(check.response_id).not.toBe(turn!.response_id);
      expect(check.inclusion).toBe("not_mentioned");
    }
    const chained = fake.responseRequests().filter((r) => r.body!.previous_response_id);
    expect(chained).toHaveLength(2); // only the conversation's own turns two and three
  });

  it("refuses question sets that name the target or reuse a campaign question as held-out", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);

    // Target variables cannot even be saved in a fresh-check question.
    await expectDbError(
      rpc(workspace.owner.client, "save_probe_set", {
        p_workspace_id: workspace.id,
        p_probe_set_id: null,
        p_name: "Leaky",
        p_description: null,
        p_questions: [{ body: "Is {{business_name}} any good?", is_held_out: false }],
      }),
      "invalid_question",
    );

    const leaky = await createCampaign(workspace, connection, {
      name: "Leaky literal",
      questions: [{ body: "Is Northwind Roasters the best for {{category}}?", is_held_out: false }],
    });
    const leak = await expectDbError(launch(workspace, leaky), "campaign_invalid");
    expect(leak.message).toMatch(/mentions the target/);

    const overlapping = await createCampaign(workspace, connection, {
      name: "Overlap",
      questions: [{ body: "What are the best {{category}} in {{location}}?", is_held_out: true }],
    });
    const overlap = await expectDbError(launch(workspace, overlapping), "campaign_invalid");
    expect(overlap.message).toMatch(/Held-out question/);
    expect(
      fake.responseRequests().filter((r) => String(r.body!.input).includes("Northwind")),
    ).toHaveLength(0);
  });

  it("excludes a check at run time if its prompt would name the target, without sending it", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, {
      config: { baseline_samples: 2 },
    });
    fake.reset();
    await launch(workspace, campaign);
    // Simulate a prompt that slipped past validation.
    await sql(
      "update public.fresh_checks set rendered_prompt = 'Should I pick northwindroasters.example?' where id = (select id from public.fresh_checks where campaign_id = $1 order by id limit 1)",
      [campaign.id],
    );
    await drain(fake);

    const all = await checks(campaign.id);
    const excluded = all.filter((check) => check.status === "excluded");
    expect(excluded).toHaveLength(1);
    expect(excluded[0]!.exclusion_reason).toBe("target_leak");
    expect(fake.responseRequests()).toHaveLength(1);
    expect(fake.responseRequests()[0]!.raw).not.toContain("northwindroasters");

    // The excluded check stays visible in the numbers; it is not counted as a negative.
    const metrics = await rpc<{ phase: string; total: number; valid: number; excluded: number }[]>(
      workspace.owner.client,
      "campaign_check_metrics",
      { p_campaign_id: campaign.id },
    );
    const total = metrics.reduce((sum, row) => sum + Number(row.total), 0);
    const valid = metrics.reduce((sum, row) => sum + Number(row.valid), 0);
    const excludedCount = metrics.reduce((sum, row) => sum + Number(row.excluded), 0);
    expect({ total, valid, excludedCount }).toEqual({ total: 2, valid: 1, excludedCount: 1 });
  });

  it("runs final checks only after the last conversation jobs have resolved", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const start = new Date(Date.now() - 60_000);
    const campaign = await createCampaign(workspace, connection, {
      startAt: start,
      endAt: new Date(start.getTime() + 6 * 3600_000),
      config: { baseline_samples: 0, daily_checks: 0, final_samples: 3, conversations_per_day: 24 },
    });
    fake.reset();
    await launch(workspace, campaign);
    expect(await campaignStatus(campaign.id)).toBe("running");

    // Start one conversation and leave it mid-way (first turn done, two turns outstanding).
    const [slot] = await sql<{ scheduled_for: Date }>(
      "select scheduled_for from public.jobs where campaign_id = $1 and kind = 'conversation' and status = 'pending' order by scheduled_for limit 1",
      [campaign.id],
    );
    await tick(new Date(slot!.scheduled_for));
    await drain(fake, { max: 1 });

    // The scheduled end passes.
    const afterEnd = new Date(start.getTime() + 6 * 3600_000 + 60_000);
    await tick(afterEnd);
    expect(await campaignStatus(campaign.id)).toBe("finalizing");
    // End time alone does not trigger the final checks while a conversation is unresolved.
    expect(
      await sql("select 1 from public.jobs where campaign_id = $1 and kind = 'check_final'", [
        campaign.id,
      ]),
    ).toHaveLength(0);

    // The conversation finishes; only then are final checks created and run.
    await drain(fake);
    await tick(new Date(afterEnd.getTime() + 60_000));
    expect(
      await sql("select 1 from public.jobs where campaign_id = $1 and kind = 'check_final'", [
        campaign.id,
      ]),
    ).toHaveLength(3);
    await drain(fake);
    await tick(new Date(afterEnd.getTime() + 120_000));
    expect(await campaignStatus(campaign.id)).toBe("completed");

    const [order] = await sql<{ ok: boolean }>(
      `select (select max(completed_at) from public.runs where campaign_id = $1)
              <= (select min(started_at) from public.fresh_checks where campaign_id = $1 and phase = 'final') as ok`,
      [campaign.id],
    );
    expect(order!.ok).toBe(true);
    const finals = (await checks(campaign.id)).filter((check) => check.phase === "final");
    expect(finals.every((check) => check.status === "completed")).toBe(true);
  });

  it("records conversations that cannot finish as unresolved instead of waiting forever", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const start = new Date(Date.now() - 60_000);
    const end = new Date(start.getTime() + 6 * 3600_000);
    const campaign = await createCampaign(workspace, connection, {
      startAt: start,
      endAt: end,
      config: { baseline_samples: 0, daily_checks: 0, final_samples: 1 },
    });
    fake.reset();
    await launch(workspace, campaign);
    const [slot] = await sql<{ scheduled_for: Date }>(
      "select scheduled_for from public.jobs where campaign_id = $1 and kind = 'conversation' and status = 'pending' order by scheduled_for limit 1",
      [campaign.id],
    );
    await tick(new Date(slot!.scheduled_for));
    await drain(fake, { max: 1 });
    // The run is stuck waiting for budget in the middle of the conversation.
    await sql(
      "update public.jobs set status = 'blocked', status_reason = 'campaign_total_budget_exhausted', queue_msg_id = null where campaign_id = $1 and kind = 'conversation' and status = 'queued'",
      [campaign.id],
    );
    await sql("select pgmq.purge_queue('lr_work')");

    await tick(new Date(end.getTime() + 60_000));
    expect(await campaignStatus(campaign.id)).toBe("finalizing");
    // After the documented wait the stuck run is closed explicitly and final checks proceed.
    await tick(new Date(end.getTime() + 3 * 3600_000));
    const [run] = await sql<{ status: string; error_class: string }>(
      "select status, error_class from public.runs where campaign_id = $1",
      [campaign.id],
    );
    expect(run).toMatchObject({ status: "unresolved", error_class: "unresolved_at_campaign_end" });
    expect(
      await sql("select 1 from public.jobs where campaign_id = $1 and kind = 'check_final'", [
        campaign.id,
      ]),
    ).toHaveLength(1);
  });

  it("starts a new comparison group when the question set or check settings change", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, {
      config: { baseline_samples: 2 },
    });
    fake.reset();
    await launch(workspace, campaign);
    await drain(fake);
    await tick();
    expect(await campaignStatus(campaign.id)).toBe("running");

    // Changing something unrelated keeps the comparison group.
    await rpc(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: campaign.id,
      p_patch: { config: { conversations_per_day: 12 } },
    });
    let draft = await rpc<{ revision_id: string }>(
      workspace.owner.client,
      "campaign_launch_check",
      { p_campaign_id: campaign.id },
    );
    let applied = await rpc<{ new_comparison_group: boolean }>(
      workspace.owner.client,
      "apply_campaign_changes",
      {
        p_campaign_id: campaign.id,
        p_expected_revision_id: draft.revision_id,
      },
    );
    expect(applied.new_comparison_group).toBe(false);

    // Changing the allocation starts a new, separately labelled group with its own reference sample.
    await rpc(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: campaign.id,
      p_patch: { config: { daily_checks: 6 } },
    });
    draft = await rpc<{ revision_id: string }>(workspace.owner.client, "campaign_launch_check", {
      p_campaign_id: campaign.id,
    });
    applied = await rpc<{ new_comparison_group: boolean }>(
      workspace.owner.client,
      "apply_campaign_changes",
      {
        p_campaign_id: campaign.id,
        p_expected_revision_id: draft.revision_id,
      },
    );
    expect(applied.new_comparison_group).toBe(true);

    const groups = await sql<{
      sequence: number;
      started_mid_campaign: boolean;
      daily_checks: number;
    }>(
      "select sequence, started_mid_campaign, daily_checks from public.comparison_groups where campaign_id = $1 order by sequence",
      [campaign.id],
    );
    expect(groups).toEqual([
      { sequence: 1, started_mid_campaign: false, daily_checks: 2 },
      { sequence: 2, started_mid_campaign: true, daily_checks: 6 },
    ]);

    await drain(fake);
    const metrics = await rpc<{ group_sequence: number; phase: string; total: number }[]>(
      workspace.owner.client,
      "campaign_check_metrics",
      { p_campaign_id: campaign.id },
    );
    // Results are reported per group and never merged across groups.
    expect(new Set(metrics.map((row) => row.group_sequence))).toEqual(new Set([1, 2]));
    for (const sequence of [1, 2]) {
      const total = metrics
        .filter((row) => row.group_sequence === sequence && row.phase === "baseline")
        .reduce((sum, row) => sum + Number(row.total), 0);
      expect(total).toBe(2);
    }
  });
});
