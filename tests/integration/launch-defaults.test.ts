// What a campaign needs from its owner before it can be launched: how long it runs, how many
// conversations a day, and a total budget. Everything else has a standard value, is optional,
// or is settled at the moment of launch.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakeOpenAI } from "../support/fake-openai.ts";
import {
  addMember,
  addPrice,
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
  type CampaignFixture,
  type Client,
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

interface Problem {
  code: string;
  field: string | null;
  message: string;
}

async function launchCheck(client: Client, campaignId: string) {
  return rpc<{ revision_id: string; problems: Problem[] }>(client, "campaign_launch_check", {
    p_campaign_id: campaignId,
  });
}

/** The three answers only a person can give. */
const THREE_ANSWERS = {
  schedule_end_mode: "duration",
  duration_days: 3,
  conversations_per_day: 24,
  total_budget_usd: 20,
};

/** Everything else the usual fixture sets, cleared: optional, standard, or settled at launch. */
const LEFT_OPEN = {
  category: null,
  location: null,
  language: null,
  start_at: null,
  end_at: null,
  active_weekdays: null,
  active_start_minute: null,
  active_end_minute: null,
  max_concurrency: null,
  missed_slot_behavior: null,
  on_existing_inclusion: null,
  daily_budget_usd: null,
  baseline_samples: null,
  daily_checks: null,
  final_samples: null,
  max_output_tokens: null,
};

/** Prompts without {{category}} or {{location}}, and no fresh-check question set. */
const PLAIN_PROMPTS = {
  initialQuestions: ["What are the best coffee subscriptions?"],
  questions: null,
};

const STANDARD_COLUMNS =
  "active_weekdays, active_start_minute, active_end_minute, max_concurrency, missed_slot_behavior, on_existing_inclusion, baseline_samples, daily_checks, final_samples, max_output_tokens";
const STANDARD_VALUES = {
  active_weekdays: [1, 2, 3, 4, 5, 6, 7],
  active_start_minute: 0,
  active_end_minute: 1440,
  max_concurrency: 1,
  missed_slot_behavior: "skip",
  on_existing_inclusion: "continue",
  baseline_samples: 0,
  daily_checks: 0,
  final_samples: 0,
};

async function revisionRow(revisionId: string, columns: string) {
  const [row] = await sql<Record<string, unknown>>(
    `select ${columns} from public.campaign_revisions where id = $1`,
    [revisionId],
  );
  return row!;
}

async function activeRevision(campaignId: string, columns: string) {
  const [row] = await sql<Record<string, unknown>>(
    `select ${columns} from public.campaign_revisions r join public.campaigns c on c.active_revision_id = r.id where c.id = $1`,
    [campaignId],
  );
  return row!;
}

describe("what a campaign needs before launch", () => {
  it("gives a new draft the standard values and asks only for what it cannot decide", async () => {
    const workspace = await createWorkspace();
    const id = await rpc<string>(workspace.owner.client, "create_campaign", {
      p_workspace_id: workspace.id,
      p_name: "New",
    });
    const check = await launchCheck(workspace.owner.client, id);
    const fields = new Set(check.problems.map((problem) => problem.field));
    // Still the owner's to give.
    for (const field of ["end_at", "conversations_per_day", "total_budget_usd", "timezone"]) {
      expect(fields.has(field), field).toBe(true);
    }
    // No longer asked for.
    for (const field of [
      "category",
      "language",
      "start_at",
      "daily_budget_usd",
      "active_weekdays",
      "active_hours",
      "max_concurrency",
      "missed_slot_behavior",
      "on_existing_inclusion",
      "checks",
    ]) {
      expect(fields.has(field), field).toBe(false);
    }

    expect(await revisionRow(check.revision_id, STANDARD_COLUMNS)).toEqual({
      ...STANDARD_VALUES,
      // The output cap follows the model, and none has been chosen yet.
      max_output_tokens: null,
    });
    // Nothing about the campaign itself is filled in: no business, model, schedule, volume or money.
    const mine = await revisionRow(
      check.revision_id,
      "business_name, website_url, category, language, connection_id, model, start_at, end_at, duration_days, timezone, conversations_per_day, total_conversation_limit, daily_budget_usd, total_budget_usd, probe_set_id",
    );
    expect(Object.values(mine).every((value) => value === null)).toBe(true);
    expect(await revisionRow(check.revision_id, "schedule_end_mode")).toEqual({
      schedule_end_mode: "duration",
    });
  });

  it("launches on three answers: it starts at the launch and ends that many days later", async () => {
    const workspace = await createWorkspace();
    // Verified for more than the standard cap, so the cap is the standard one.
    const connection = await createConnection(workspace, fake, { verifyCap: 5000 });
    const campaign = await createCampaign(workspace, connection, {
      ...PLAIN_PROMPTS,
      config: { ...LEFT_OPEN, ...THREE_ANSWERS, timezone: "America/New_York" },
    });

    const check = await launchCheck(workspace.owner.client, campaign.id);
    expect(check.problems).toEqual([]);
    expect(await revisionRow(campaign.revisionId, STANDARD_COLUMNS)).toEqual({
      ...STANDARD_VALUES,
      max_output_tokens: 2000,
    });
    // Until it is launched the draft keeps its start open.
    expect(await revisionRow(campaign.revisionId, "start_at, end_at, duration_days")).toEqual({
      start_at: null,
      end_at: null,
      duration_days: 3,
    });

    const before = Date.now();
    await launch(workspace, campaign);
    const after = Date.now();

    const frozen = await activeRevision(
      campaign.id,
      `r.state, r.start_at, r.daily_budget_usd,
       r.end_at = ((r.start_at at time zone r.timezone) + make_interval(days => r.duration_days)) at time zone r.timezone as ends_on_its_own_clock`,
    );
    expect(frozen.state).toBe("frozen");
    // The launch, to the minute: the way a start is shown and entered everywhere else.
    const startedAt = (frozen.start_at as Date).getTime();
    expect(startedAt % 60_000).toBe(0);
    expect(startedAt).toBeGreaterThan(before - 62_000);
    expect(startedAt).toBeLessThanOrEqual(after + 2_000);
    expect(frozen.ends_on_its_own_clock).toBe(true);
    expect(frozen.daily_budget_usd).toBeNull();

    // It is running, and its first conversation completes without a daily budget to check.
    const [state] = await sql<{ status: string }>(
      "select status from public.campaigns where id = $1",
      [campaign.id],
    );
    expect(state!.status).toBe("running");
    const [slot] = await sql<{ scheduled_for: Date }>(
      "select scheduled_for from public.jobs where campaign_id = $1 and kind = 'conversation' and status = 'pending' order by scheduled_for limit 1",
      [campaign.id],
    );
    expect(slot).toBeDefined();
    await tick(new Date(slot!.scheduled_for));
    await drain(fake);
    const [runs] = await sql<{ completed: number }>(
      "select count(*)::int as completed from public.runs where campaign_id = $1 and status = 'completed'",
      [campaign.id],
    );
    expect(runs!.completed).toBe(1);
  });

  it("caps the standard output cap at what the model was verified for", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake, { verifyCap: 600 });
    const campaign = await createCampaign(workspace, connection, {
      ...PLAIN_PROMPTS,
      config: { ...LEFT_OPEN, ...THREE_ANSWERS, timezone: "UTC" },
    });
    expect(await revisionRow(campaign.revisionId, "max_output_tokens")).toEqual({
      max_output_tokens: 600,
    });
    expect((await launchCheck(workspace.owner.client, campaign.id)).problems).toEqual([]);
  });

  it("gives a setting that is saved blank its standard value again", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    // The fixture's own choices: two at once, an output cap of 600, a daily budget.
    const campaign = await createCampaign(workspace, connection);
    expect(await revisionRow(campaign.revisionId, "max_concurrency, max_output_tokens")).toEqual({
      max_concurrency: 2,
      max_output_tokens: 600,
    });
    await rpc(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: campaign.id,
      p_patch: {
        config: {
          active_weekdays: null,
          active_start_minute: null,
          active_end_minute: null,
          max_concurrency: null,
          missed_slot_behavior: null,
          on_existing_inclusion: null,
          baseline_samples: null,
          daily_checks: null,
          final_samples: null,
          max_output_tokens: null,
        },
      },
    });
    expect(await revisionRow(campaign.revisionId, STANDARD_COLUMNS)).toEqual({
      ...STANDARD_VALUES,
      max_output_tokens: 2000,
    });
    // A value that was chosen is kept: only blanks are filled.
    await rpc(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: campaign.id,
      p_patch: { config: { max_concurrency: 3, active_start_minute: 540 } },
    });
    expect(
      await revisionRow(
        campaign.revisionId,
        "max_concurrency, active_start_minute, active_end_minute",
      ),
    ).toEqual({ max_concurrency: 3, active_start_minute: 540, active_end_minute: 1440 });
  });

  it("needs a category only for a prompt that uses it", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const withPlaceholder = await createCampaign(workspace, connection, {
      name: "Uses the placeholder",
      initialQuestions: ["What are the best {{category}}?"],
      questions: null,
      config: { ...LEFT_OPEN, ...THREE_ANSWERS, timezone: "UTC" },
    });
    const check = await launchCheck(workspace.owner.client, withPlaceholder.id);
    expect(check.problems.map((problem) => [problem.code, problem.field])).toEqual([
      ["unresolved_variable", "steps.1"],
    ]);
    await expectDbError(launch(workspace, withPlaceholder), "campaign_invalid");

    await rpc(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: withPlaceholder.id,
      p_patch: { config: { category: "coffee subscriptions" } },
    });
    expect((await launchCheck(workspace.owner.client, withPlaceholder.id)).problems).toEqual([]);
  });

  it("accepts an open start with an end date, and refuses an end that cannot work", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const inTwoDays = new Date(Date.now() + 2 * 86_400_000);
    const base = { ...LEFT_OPEN, ...THREE_ANSWERS, timezone: "UTC", duration_days: null };

    const dated = await createCampaign(workspace, connection, {
      ...PLAIN_PROMPTS,
      name: "Open start, end date",
      config: { ...base, schedule_end_mode: "end_time", end_at: inTwoDays.toISOString() },
    });
    expect((await launchCheck(workspace.owner.client, dated.id)).problems).toEqual([]);
    const before = Date.now();
    await launch(workspace, dated);
    const frozen = await activeRevision(dated.id, "r.start_at, r.end_at");
    expect((frozen.start_at as Date).getTime()).toBeGreaterThan(before - 62_000);
    expect((frozen.end_at as Date).getTime()).toBe(inTwoDays.getTime());

    const codes = async (config: Record<string, unknown>, name: string) => {
      const campaign = await createCampaign(workspace, connection, {
        ...PLAIN_PROMPTS,
        name,
        config: { ...base, ...config },
      });
      const check = await launchCheck(workspace.owner.client, campaign.id);
      await expectDbError(launch(workspace, campaign), "campaign_invalid");
      // A launch that is refused leaves the draft as it was: nothing was settled.
      expect(await revisionRow(campaign.revisionId, "state, start_at")).toEqual({
        state: "draft",
        start_at: null,
      });
      return check.problems.map((problem) => [problem.code, problem.field]);
    };
    // Neither a length nor an end.
    expect(await codes({ schedule_end_mode: "duration" }, "No length")).toEqual([
      ["required", "end_at"],
    ]);
    expect(await codes({ schedule_end_mode: "end_time" }, "No end")).toEqual([
      ["required", "end_at"],
    ]);
    // An end that has passed.
    expect(
      await codes(
        { schedule_end_mode: "end_time", end_at: new Date(Date.now() - 3600_000).toISOString() },
        "Past end",
      ),
    ).toEqual([["end_in_past", "end_at"]]);
    // A start after the end is not even stored.
    const backwards = await createCampaign(workspace, connection, {
      ...PLAIN_PROMPTS,
      name: "Start after end",
      config: base,
    });
    await expectDbError(
      rpc(workspace.owner.client, "save_campaign_draft", {
        p_campaign_id: backwards.id,
        p_patch: {
          config: {
            schedule_end_mode: "end_time",
            start_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
            end_at: inTwoDays.toISOString(),
          },
        },
      }),
      "invalid_value",
    );
  });

  it("counts a length in days from a given start when the draft is saved", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, {
      ...PLAIN_PROMPTS,
      config: { ...LEFT_OPEN, ...THREE_ANSWERS, timezone: "Europe/Berlin" },
    });
    // Five days from 09:00 on a Berlin clock, across the change to summer time on 29 March.
    await rpc(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: campaign.id,
      p_patch: { config: { start_at: "2027-03-26T08:00:00Z", duration_days: 5 } },
    });
    expect(await revisionRow(campaign.revisionId, "start_at, end_at, duration_days")).toEqual({
      start_at: new Date("2027-03-26T08:00:00Z"),
      end_at: new Date("2027-03-31T07:00:00Z"),
      duration_days: 5,
    });
    // Changing only the length moves the end; clearing the start opens it again.
    await rpc(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: campaign.id,
      p_patch: { config: { duration_days: 1 } },
    });
    expect(await revisionRow(campaign.revisionId, "end_at")).toEqual({
      end_at: new Date("2027-03-27T08:00:00Z"),
    });
    await rpc(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: campaign.id,
      p_patch: { config: { start_at: null } },
    });
    expect(await revisionRow(campaign.revisionId, "start_at, end_at, duration_days")).toEqual({
      start_at: null,
      end_at: null,
      duration_days: 1,
    });
    // An end date is kept as entered.
    await rpc(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: campaign.id,
      p_patch: {
        config: {
          schedule_end_mode: "end_time",
          duration_days: null,
          end_at: "2027-05-01T12:00:00Z",
        },
      },
    });
    expect(await revisionRow(campaign.revisionId, "start_at, end_at")).toEqual({
      start_at: null,
      end_at: new Date("2027-05-01T12:00:00Z"),
    });
  });

  it("applies later edits to a campaign that started at its launch, without moving its start", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, {
      ...PLAIN_PROMPTS,
      config: { ...LEFT_OPEN, ...THREE_ANSWERS, timezone: "America/New_York" },
    });
    await launch(workspace, campaign);
    const launched = await activeRevision(campaign.id, "r.start_at, r.end_at");
    const start = launched.start_at as Date;

    // What the editor does: it sends the start back as it shows it, to the minute.
    const apply = async (config: Record<string, unknown>) => {
      await rpc(workspace.owner.client, "save_campaign_draft", {
        p_campaign_id: campaign.id,
        p_patch: { config: { start_at: start.toISOString(), duration_days: 3, ...config } },
      });
      const check = await launchCheck(workspace.owner.client, campaign.id);
      expect(check.problems).toEqual([]);
      await rpc(workspace.owner.client, "apply_campaign_changes", {
        p_campaign_id: campaign.id,
        p_expected_revision_id: check.revision_id,
      });
    };
    await apply({ conversations_per_day: 48 });
    expect(await activeRevision(campaign.id, "r.revision_number, r.start_at, r.end_at")).toEqual({
      revision_number: 2,
      start_at: launched.start_at,
      end_at: launched.end_at,
    });
    // A longer campaign: the end moves, the start does not.
    await apply({ duration_days: 5 });
    const longer = await activeRevision(
      campaign.id,
      `r.start_at, r.end_at = ((r.start_at at time zone r.timezone) + interval '5 days') at time zone r.timezone as five_days`,
    );
    expect(longer).toEqual({ start_at: launched.start_at, five_days: true });
  });

  it("keeps a start that carries seconds when the form sends it back to the minute", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    // A start with seconds, as an older launch or a direct call could have stored it.
    const withSeconds = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000 + 23_456);
    const campaign = await createCampaign(workspace, connection, {
      ...PLAIN_PROMPTS,
      startAt: withSeconds,
      config: { timezone: "America/New_York" },
    });
    await launch(workspace, campaign);
    expect(await activeRevision(campaign.id, "r.start_at")).toEqual({ start_at: withSeconds });
    const [state] = await sql<{ started: boolean }>(
      "select started_at is not null as started from public.campaigns where id = $1",
      [campaign.id],
    );
    expect(state!.started).toBe(true);

    const toTheMinute = new Date(Math.floor(withSeconds.getTime() / 60_000) * 60_000);
    await rpc(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: campaign.id,
      p_patch: { config: { start_at: toTheMinute.toISOString(), conversations_per_day: 48 } },
    });
    const pending = await launchCheck(workspace.owner.client, campaign.id);
    expect(pending.problems).toEqual([]);
    expect(await revisionRow(pending.revision_id, "start_at")).toEqual({ start_at: withSeconds });

    // A start that really is different is still refused once the campaign has started.
    await rpc(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: campaign.id,
      p_patch: { config: { start_at: new Date(withSeconds.getTime() + 7_200_000).toISOString() } },
    });
    expect(
      (await launchCheck(workspace.owner.client, campaign.id)).problems.map((p) => p.code),
    ).toEqual(["start_locked"]);
  });

  it("does not let a launched campaign drop its start", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    // Launched, but waiting for a start two days away.
    const inTwoDays = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 2 * 86_400_000);
    const campaign = await createCampaign(workspace, connection, {
      ...PLAIN_PROMPTS,
      startAt: inTwoDays,
      endAt: new Date(inTwoDays.getTime() + 3 * 86_400_000),
    });
    await launch(workspace, campaign);
    const [state] = await sql<{ status: string }>(
      "select status from public.campaigns where id = $1",
      [campaign.id],
    );
    expect(state!.status).toBe("scheduled");

    await rpc(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: campaign.id,
      p_patch: { config: { start_at: null } },
    });
    const check = await launchCheck(workspace.owner.client, campaign.id);
    expect(check.problems.map((problem) => [problem.code, problem.field])).toEqual([
      ["required", "start_at"],
    ]);
    await expectDbError(
      rpc(workspace.owner.client, "apply_campaign_changes", {
        p_campaign_id: campaign.id,
        p_expected_revision_id: check.revision_id,
      }),
      "campaign_invalid",
    );
    // Nothing started early.
    expect(await activeRevision(campaign.id, "r.start_at")).toEqual({ start_at: inTwoDays });
    const [still] = await sql<{ status: string }>(
      "select status from public.campaigns where id = $1",
      [campaign.id],
    );
    expect(still!.status).toBe("scheduled");
  });

  it("plans a draft with an open start as a launch at this moment", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, {
      ...PLAIN_PROMPTS,
      config: { ...LEFT_OPEN, ...THREE_ANSWERS, timezone: "UTC" },
    });
    const preview = await rpc<{
      starts_at_launch: boolean;
      schedule_end_mode: string;
      duration_days: number;
      start_at: string | null;
      planned_start_at: string;
      planned_end_at: string;
      first_conversation_at: string;
      planned_conversations: number;
      daily_budget_usd: number | null;
      max_cost_usd: number;
    }>(workspace.owner.client, "campaign_plan_preview", { p_campaign_id: campaign.id });
    expect(preview.starts_at_launch).toBe(true);
    expect(preview.start_at).toBeNull();
    expect(preview.duration_days).toBe(3);
    expect(Date.parse(preview.planned_end_at) - Date.parse(preview.planned_start_at)).toBe(
      3 * 86_400_000,
    );
    // With 24 a day the grid is hourly, so the first conversation is within the hour.
    const first = Date.parse(preview.first_conversation_at);
    expect(first).toBeGreaterThanOrEqual(Date.parse(preview.planned_start_at));
    expect(first - Date.parse(preview.planned_start_at)).toBeLessThanOrEqual(3_600_000);
    expect(first % 3_600_000).toBe(0);
    // Three days of 24 a day, whatever the hour: the first and last days are partial.
    expect(preview.planned_conversations).toBe(72);
    expect(preview.daily_budget_usd).toBeNull();
    expect(preview.max_cost_usd).toBeGreaterThan(0);
  });

  it("keeps the length of a duplicated campaign and leaves its start open", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const source = await createCampaign(workspace, connection, {
      ...PLAIN_PROMPTS,
      config: { ...LEFT_OPEN, ...THREE_ANSWERS, timezone: "UTC" },
    });
    await launch(workspace, source);
    const copyId = await rpc<string>(workspace.owner.client, "duplicate_campaign", {
      p_campaign_id: source.id,
    });
    const check = await launchCheck(workspace.owner.client, copyId);
    expect(check.problems).toEqual([]);
    expect(
      await revisionRow(check.revision_id, "start_at, end_at, duration_days, schedule_end_mode"),
    ).toEqual({ start_at: null, end_at: null, duration_days: 3, schedule_end_mode: "duration" });

    // A campaign from before the length was stored has it only as end minus start.
    const older: CampaignFixture = await createCampaign(workspace, connection, {
      ...PLAIN_PROMPTS,
      name: "Older",
      config: { schedule_end_mode: "duration", timezone: "Europe/Berlin" },
      startAt: new Date("2026-03-27T09:00:00Z"),
      // Five days later on a Berlin clock, across the change to summer time: an hour short.
      endAt: new Date("2026-04-01T08:00:00Z"),
    });
    // Saved today, the length is noted from the two dates. An older row has none.
    expect(await revisionRow(older.revisionId, "duration_days")).toEqual({ duration_days: 5 });
    await sql("update public.campaign_revisions set duration_days = null where id = $1", [
      older.revisionId,
    ]);
    const olderCopy = await rpc<string>(workspace.owner.client, "duplicate_campaign", {
      p_campaign_id: older.id,
    });
    const olderCheck = await launchCheck(workspace.owner.client, olderCopy);
    expect(await revisionRow(olderCheck.revision_id, "duration_days, start_at")).toEqual({
      duration_days: 5,
      start_at: null,
    });
  });

  it("fills standard values only into drafts: frozen and discarded revisions are left alone", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection);
    await launch(workspace, campaign);
    const frozenBefore = await revisionRow(campaign.revisionId, `${STANDARD_COLUMNS}, updated_at`);
    await sql("select app_private.fill_revision_defaults($1)", [campaign.revisionId]);
    expect(await revisionRow(campaign.revisionId, `${STANDARD_COLUMNS}, updated_at`)).toEqual(
      frozenBefore,
    );

    // A discarded pending edit that still has a blank: a frozen row can never have one, so
    // this is the row that shows the function really looks at the state.
    const pendingId = await rpc<string>(workspace.owner.client, "begin_campaign_edit", {
      p_campaign_id: campaign.id,
    });
    await sql("update public.campaign_revisions set max_concurrency = null where id = $1", [
      pendingId,
    ]);
    await rpc(workspace.owner.client, "discard_campaign_draft", { p_campaign_id: campaign.id });
    const discardedBefore = await revisionRow(pendingId, `state, ${STANDARD_COLUMNS}, updated_at`);
    expect(discardedBefore).toMatchObject({ state: "discarded", max_concurrency: null });
    await sql("select app_private.fill_revision_defaults($1)", [pendingId]);
    expect(await revisionRow(pendingId, `state, ${STANDARD_COLUMNS}, updated_at`)).toEqual(
      discardedBefore,
    );
  });

  it("replaces an output cap carried over from a model that was verified for more", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake, { verifyCap: 4000 });
    // A second model on the same connection, verified for less.
    await addPrice(workspace.owner, workspace.id, "fake-reasoning-1");
    const verified = await ops(workspace.owner, fake, "model.verify", {
      connection_id: connection.id,
      model_id: "fake-reasoning-1",
      max_output_tokens: 1000,
    });
    expect(verified.ok).toBe(true);

    const campaign = await createCampaign(workspace, connection, {
      ...PLAIN_PROMPTS,
      config: { ...LEFT_OPEN, ...THREE_ANSWERS, timezone: "UTC" },
    });
    expect(await revisionRow(campaign.revisionId, "max_output_tokens")).toEqual({
      max_output_tokens: 2000,
    });
    // Switching model without touching the cap: the new model's standard cap takes over.
    await rpc(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: campaign.id,
      p_patch: { config: { model: "fake-reasoning-1" } },
    });
    expect(await revisionRow(campaign.revisionId, "max_output_tokens")).toEqual({
      max_output_tokens: 1000,
    });
    expect((await launchCheck(workspace.owner.client, campaign.id)).problems).toEqual([]);

    // A cap the person sets in the same save is theirs, and is judged as it is.
    await rpc(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: campaign.id,
      p_patch: { config: { model: connection.model, max_output_tokens: 3000 } },
    });
    await rpc(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: campaign.id,
      p_patch: { config: { model: "fake-reasoning-1", max_output_tokens: 1500 } },
    });
    expect(await revisionRow(campaign.revisionId, "max_output_tokens")).toEqual({
      max_output_tokens: 1500,
    });
    expect(
      (await launchCheck(workspace.owner.client, campaign.id)).problems.map((p) => p.code),
    ).toEqual(["unsupported_parameter"]);
    // A cap that fits the new model is kept.
    await rpc(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: campaign.id,
      p_patch: { config: { model: connection.model, max_output_tokens: 800 } },
    });
    await rpc(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: campaign.id,
      p_patch: { config: { model: "fake-reasoning-1" } },
    });
    expect(await revisionRow(campaign.revisionId, "max_output_tokens")).toEqual({
      max_output_tokens: 800,
    });
  });
});

describe("the timezone suggested by the interface", () => {
  it("is stored only on a draft that has none, and only for someone who may edit it", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, {
      ...PLAIN_PROMPTS,
      config: { ...LEFT_OPEN, ...THREE_ANSWERS, timezone: null },
    });
    const suggest = (client: Client, timezone: string, id = campaign.id) =>
      rpc<boolean>(client, "suggest_campaign_timezone", {
        p_campaign_id: id,
        p_timezone: timezone,
      });
    const stored = async () => (await revisionRow(campaign.revisionId, "timezone")).timezone;

    // The missing timezone was the one thing in the way.
    expect(
      (await launchCheck(workspace.owner.client, campaign.id)).problems.map((p) => p.field),
    ).toEqual(["timezone"]);

    // Not a timezone: nothing is stored.
    expect(await suggest(workspace.owner.client, "Mars/Olympus_Mons")).toBe(false);
    expect(await stored()).toBeNull();

    // People who may not edit the campaign cannot set it either.
    const member = await addMember(workspace, "member");
    await expectDbError(suggest(member.client, "Europe/Berlin"), "forbidden");
    const stranger = await createWorkspace("Other workspace");
    await expectDbError(suggest(stranger.owner.client, "Europe/Berlin"), "forbidden");
    expect(await stored()).toBeNull();

    expect(await suggest(workspace.owner.client, "Europe/Berlin")).toBe(true);
    expect(await stored()).toBe("Europe/Berlin");
    expect((await launchCheck(workspace.owner.client, campaign.id)).problems).toEqual([]);

    // A timezone that is set is the owner's choice and is never replaced.
    expect(await suggest(workspace.owner.client, "Asia/Tokyo")).toBe(false);
    expect(await stored()).toBe("Europe/Berlin");

    // A launched campaign is not touched: neither what is running nor a pending edit of it,
    // even one whose timezone has been cleared.
    await launch(workspace, campaign);
    expect(await suggest(workspace.owner.client, "Asia/Tokyo")).toBe(false);
    const pendingId = await rpc<string>(workspace.owner.client, "save_campaign_draft", {
      p_campaign_id: campaign.id,
      p_patch: { config: { timezone: null } },
    });
    expect(await suggest(workspace.owner.client, "Asia/Tokyo")).toBe(false);
    expect(await revisionRow(pendingId, "state, timezone")).toEqual({
      state: "draft",
      timezone: null,
    });
    expect(await activeRevision(campaign.id, "r.timezone")).toEqual({ timezone: "Europe/Berlin" });
  });
});
