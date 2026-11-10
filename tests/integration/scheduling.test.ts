import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakeOpenAI } from "../support/fake-openai.ts";
import {
  admin,
  campaignStatus,
  closeConnections,
  createCampaign,
  createConnection,
  createWorkspace,
  drain,
  launch,
  localWorkerSecret,
  resetDatabase,
  rpc,
  sql,
  startFake,
  tick,
  work,
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

/** Slots for one local day, straight from the planner's slot function. */
async function daySlots(
  revision: Record<string, unknown>,
  day: string,
  count: number,
  offset = 0,
  salt = "conversation",
): Promise<{ slot_index: number; slot_at: Date; local: string }[]> {
  return sql(
    `select s.slot_index, s.slot_at,
            to_char(s.slot_at at time zone ($1::jsonb ->> 'timezone'), 'YYYY-MM-DD HH24:MI:SS') as local
     from app_private.day_slots(jsonb_populate_record(null::public.campaign_revisions, $1::jsonb), $2::date, $3, $4, $5) s
     order by s.slot_index`,
    [JSON.stringify(revision), day, count, offset, salt],
  );
}

const baseRevision = {
  timezone: "America/New_York",
  active_weekdays: [1, 2, 3, 4, 5],
  active_start_minute: 9 * 60,
  active_end_minute: 17 * 60,
  jitter_seconds: 0,
  selection_seed: "seed-a",
};

describe("slot planning", () => {
  it("spreads the daily quota evenly across the active hours in the campaign's timezone", async () => {
    const slots = await daySlots(baseRevision, "2026-11-12", 4); // a Thursday
    expect(slots.map((s) => s.local)).toEqual([
      "2026-11-12 09:00:00",
      "2026-11-12 11:00:00",
      "2026-11-12 13:00:00",
      "2026-11-12 15:00:00",
    ]);
    // Stored in UTC: 09:00 in New York (EST, UTC-5) is 14:00Z.
    expect(new Date(slots[0]!.slot_at).toISOString()).toBe("2026-11-12T14:00:00.000Z");
  });

  it("skips inactive weekdays", async () => {
    expect(await daySlots(baseRevision, "2026-11-14", 4)).toHaveLength(0); // Saturday
    expect(await daySlots(baseRevision, "2026-11-16", 4)).toHaveLength(4); // Monday
  });

  it("keeps local hours across daylight-saving changes", async () => {
    // Clocks go forward on 2027-03-14 in New York: 09:00 local moves from 14:00Z to 13:00Z.
    const before = await daySlots(
      { ...baseRevision, active_weekdays: [1, 2, 3, 4, 5, 6, 7] },
      "2027-03-13",
      2,
    );
    const after = await daySlots(
      { ...baseRevision, active_weekdays: [1, 2, 3, 4, 5, 6, 7] },
      "2027-03-14",
      2,
    );
    expect(new Date(before[0]!.slot_at).toISOString()).toBe("2027-03-13T14:00:00.000Z");
    expect(new Date(after[0]!.slot_at).toISOString()).toBe("2027-03-14T13:00:00.000Z");
    expect(after.map((s) => s.local)).toEqual(["2027-03-14 09:00:00", "2027-03-14 13:00:00"]);

    // A full-day window on the 23-hour day still fits inside that local day.
    const allDay = await daySlots(
      { ...baseRevision, active_weekdays: [7], active_start_minute: 0, active_end_minute: 1440 },
      "2027-03-14",
      24,
    );
    expect(allDay).toHaveLength(24);
    expect(allDay.every((s) => s.local.startsWith("2027-03-14"))).toBe(true);
  });

  it("assigns slots to the local calendar day, not the UTC day", async () => {
    // 22:00–23:59 in Los Angeles is already the next day in UTC.
    const revision = {
      ...baseRevision,
      timezone: "America/Los_Angeles",
      active_weekdays: [1, 2, 3, 4, 5, 6, 7],
      active_start_minute: 22 * 60,
      active_end_minute: 24 * 60,
    };
    const slots = await daySlots(revision, "2026-11-12", 2);
    expect(slots.map((s) => s.local)).toEqual(["2026-11-12 22:00:00", "2026-11-12 23:00:00"]);
    expect(new Date(slots[0]!.slot_at).toISOString()).toBe("2026-11-13T06:00:00.000Z");

    // Far-east timezone: the local day starts the previous UTC day.
    const tokyo = {
      ...revision,
      timezone: "Asia/Tokyo",
      active_start_minute: 0,
      active_end_minute: 120,
    };
    const early = await daySlots(tokyo, "2026-11-12", 2);
    expect(new Date(early[0]!.slot_at).toISOString()).toBe("2026-11-11T15:00:00.000Z");
  });

  it("applies bounded, deterministic jitter that never leaves a slot's own interval", async () => {
    const revision = { ...baseRevision, jitter_seconds: 900 };
    const first = await daySlots(revision, "2026-11-12", 8);
    const second = await daySlots(revision, "2026-11-12", 8);
    // Same inputs, same slots.
    expect(second.map((s) => s.local)).toEqual(first.map((s) => s.local));
    // A different seed moves them.
    const other = await daySlots({ ...revision, selection_seed: "seed-b" }, "2026-11-12", 8);
    expect(other.map((s) => s.local)).not.toEqual(first.map((s) => s.local));

    const windowStart = Date.parse("2026-11-12T14:00:00Z");
    first.forEach((slot, index) => {
      const offset = (new Date(slot.slot_at).getTime() - windowStart) / 1000 - index * 3600;
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThanOrEqual(900);
    });
    // Jitter larger than the spacing is clamped so slots stay in order.
    const dense = await daySlots({ ...revision, jitter_seconds: 3600 }, "2026-11-12", 96);
    const times = dense.map((s) => new Date(s.slot_at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(96);
  });

  it("interleaves scheduled checks between conversation slots", async () => {
    const checks = await daySlots(baseRevision, "2026-11-12", 2, 0.5, "check_daily");
    expect(checks.map((s) => s.local)).toEqual(["2026-11-12 11:00:00", "2026-11-12 15:00:00"]);
  });
});

describe("scheduler idempotency", () => {
  it("creates each slot exactly once however often and however concurrently the scheduler runs", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, {
      questions: null,
      config: { conversations_per_day: 48 },
    });
    await launch(workspace, campaign);

    const count = async () =>
      (
        await sql<{ jobs: string; slots: string }>(
          "select count(*) as jobs, count(distinct (slot_date, slot_index)) as slots from public.jobs where campaign_id = $1 and kind = 'conversation'",
          [campaign.id],
        )
      )[0]!;
    const initial = await count();
    expect(Number(initial.jobs)).toBeGreaterThan(40);
    expect(initial.jobs).toBe(initial.slots);

    const now = new Date();
    await Promise.all(Array.from({ length: 12 }, () => tick(now)));
    await Promise.all(Array.from({ length: 6 }, () => tick(now)));
    expect(await count()).toEqual(initial);

    // Moving time forward extends the plan; repeating that instant adds nothing.
    const later = new Date(now.getTime() + 6 * 3600_000);
    await Promise.all(Array.from({ length: 8 }, () => tick(later)));
    const extended = await count();
    expect(Number(extended.jobs)).toBeGreaterThan(Number(initial.jobs));
    expect(extended.jobs).toBe(extended.slots);
    await Promise.all(Array.from({ length: 8 }, () => tick(later)));
    expect(await count()).toEqual(extended);

    // The database itself refuses a duplicate slot.
    await expect(
      sql(
        `insert into public.jobs (workspace_id, campaign_id, revision_id, connection_id, kind, slot_date, slot_index, scheduled_for)
         select workspace_id, campaign_id, revision_id, connection_id, kind, slot_date, slot_index, scheduled_for
         from public.jobs where campaign_id = $1 limit 1`,
        [campaign.id],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("dispatches a due slot once even when dispatchers race", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, { questions: null });
    fake.reset();
    await launch(workspace, campaign);
    const [slot] = await sql<{ scheduled_for: Date }>(
      "select scheduled_for from public.jobs where campaign_id = $1 and status = 'pending' order by scheduled_for limit 1",
      [campaign.id],
    );
    const at = new Date(slot!.scheduled_for);
    await Promise.all(Array.from({ length: 10 }, () => tick(at)));

    expect(
      await sql("select 1 from public.runs where campaign_id = $1", [campaign.id]),
    ).toHaveLength(1);
    expect(await sql("select 1 from pgmq.q_lr_work")).toHaveLength(1);
    await drain(fake);
    expect(fake.responseRequests()).toHaveLength(3);
  });

  it("respects the campaign's concurrency and total conversation limit", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, {
      questions: null,
      // One slot per minute, so several are due together without any of them being "missed".
      config: { conversations_per_day: 1440, max_concurrency: 2, total_conversation_limit: 5 },
    });
    fake.reset();
    await launch(workspace, campaign);

    // Only five slots are ever materialized.
    const planned = await sql<{ scheduled_for: Date }>(
      "select scheduled_for from public.jobs where campaign_id = $1 and kind = 'conversation' order by scheduled_for",
      [campaign.id],
    );
    expect(planned).toHaveLength(5);

    // Four slots are due at once, but only two conversations may be in progress.
    await tick(new Date(new Date(planned[3]!.scheduled_for).getTime()));
    const active = await sql<{ status: string }>(
      "select status from public.jobs where campaign_id = $1 and status in ('queued', 'running', 'waiting')",
      [campaign.id],
    );
    expect(active).toHaveLength(2);

    await drain(fake);
    await tick(new Date(planned[4]!.scheduled_for));
    await drain(fake);
    await tick(new Date(new Date(planned[4]!.scheduled_for).getTime() + 60_000));
    await drain(fake);

    const finished = await sql<{ status: string; n: string }>(
      "select status, count(*) as n from public.jobs where campaign_id = $1 and kind = 'conversation' group by status order by status",
      [campaign.id],
    );
    const total = finished.reduce((sum, row) => sum + Number(row.n), 0);
    expect(total).toBe(5);
    // Having reached its limit with everything resolved, the campaign moves on by itself.
    await tick(new Date(new Date(planned[4]!.scheduled_for).getTime() + 120_000));
    expect(["finalizing", "completed"]).toContain(await campaignStatus(campaign.id));
    const [more] = await sql<{ n: string }>(
      "select count(*) as n from public.jobs where campaign_id = $1 and kind = 'conversation'",
      [campaign.id],
    );
    expect(Number(more!.n)).toBe(5);
  });

  it("bounds simultaneous provider requests across campaigns that share a connection", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake, { maxConcurrent: 1 });
    const first = await createCampaign(workspace, connection, {
      name: "First",
      questions: null,
      config: { max_concurrency: 1 },
    });
    const second = await createCampaign(workspace, connection, {
      name: "Second",
      questions: null,
      config: { max_concurrency: 1 },
    });
    fake.reset();
    await launch(workspace, first);
    await launch(workspace, second);
    const [slot] = await sql<{ scheduled_for: Date }>(
      "select scheduled_for from public.jobs where campaign_id = $1 and status = 'pending' order by scheduled_for limit 1",
      [first.id],
    );
    await tick(new Date(slot!.scheduled_for));
    expect(await sql("select 1 from pgmq.q_lr_work")).toHaveLength(2);

    // While one request is in flight, a second worker is told to wait instead of sending.
    let second_outcome: unknown;
    const outcome = await work(
      fake,
      {},
      {
        afterBeginAttempt: async () => {
          second_outcome = await work(fake);
        },
      },
    );
    expect(outcome).toMatchObject({ status: "processed" });
    expect(second_outcome).toMatchObject({ result: "gate:deferred:connection_busy" });
    const deferred = await sql<{ status: string; status_reason: string }>(
      "select status, status_reason from public.jobs where status = 'waiting'",
    );
    expect(deferred).toEqual([{ status: "waiting", status_reason: "connection_busy" }]);
    // The deferral is not a provider attempt.
    expect(
      await sql("select 1 from public.provider_attempts where campaign_id in ($1, $2)", [
        first.id,
        second.id,
      ]),
    ).toHaveLength(1);
  });

  it("enforces request-per-minute caps for the connection and for the campaign", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, {
      questions: null,
      config: { requests_per_minute: 1 },
    });
    fake.reset();
    await launch(workspace, campaign);
    const [slot] = await sql<{ scheduled_for: Date }>(
      "select scheduled_for from public.jobs where campaign_id = $1 and status = 'pending' order by scheduled_for limit 1",
      [campaign.id],
    );
    await tick(new Date(slot!.scheduled_for));

    expect(await work(fake)).toMatchObject({ result: "committed:continue" });
    // The second turn would be the second request within a minute.
    const blocked = await work(fake);
    expect(blocked).toMatchObject({ result: "gate:deferred:campaign_rate_cap" });
    const [job] = await sql<{ status: string; next_attempt_at: Date }>(
      "select status, next_attempt_at from public.jobs where campaign_id = $1 and status = 'waiting'",
      [campaign.id],
    );
    const wait = new Date(job!.next_attempt_at).getTime() - Date.now();
    expect(wait).toBeGreaterThan(30_000);
    expect(wait).toBeLessThanOrEqual(62_000);
    expect(fake.responseRequests()).toHaveLength(1);

    // Connection-level cap behaves the same way.
    await rpc(workspace.owner.client, "update_connection", {
      p_connection_id: connection.id,
      p_patch: { requests_per_minute: 1 },
    });
    await sql("update pgmq.q_lr_work set vt = now() - interval '1 second'");
    expect(await work(fake)).toMatchObject({ result: "gate:deferred:connection_rate_cap" });
  });
});

describe("missed slots", () => {
  async function campaignWithMissedSlots(config: Record<string, unknown>) {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake, { maxConcurrent: 8 });
    const campaign = await createCampaign(workspace, connection, {
      questions: null,
      config: { conversations_per_day: 24, max_concurrency: 8, ...config },
    });
    fake.reset();
    await launch(workspace, campaign);
    const slots = await sql<{ id: string; scheduled_for: Date }>(
      "select id, scheduled_for from public.jobs where campaign_id = $1 and kind = 'conversation' order by scheduled_for limit 6",
      [campaign.id],
    );
    return { workspace, campaign, slots };
  }

  it("skips slots missed while the scheduler was down when configured to skip", async () => {
    const { campaign, slots } = await campaignWithMissedSlots({ missed_slot_behavior: "skip" });
    // The scheduler comes back four and a half hours later.
    const resumeAt = new Date(new Date(slots[4]!.scheduled_for).getTime() + 60_000);
    await tick(resumeAt);

    const states = await sql<{ status: string; status_reason: string | null }>(
      "select status, status_reason from public.jobs where campaign_id = $1 and kind = 'conversation' order by scheduled_for limit 6",
      [campaign.id],
    );
    // Four slots were missed; the one a minute ago is still on time (within the grace period).
    expect(
      states.slice(0, 4).every((s) => s.status === "skipped" && s.status_reason === "missed_slot"),
    ).toBe(true);
    expect(states[4]!.status).toBe("queued");
    expect(states[5]!.status).toBe("pending");
    expect(
      await sql("select 1 from public.runs where campaign_id = $1", [campaign.id]),
    ).toHaveLength(1);
  });

  it("catches up only within the configured delay and daily bound", async () => {
    const { campaign, slots } = await campaignWithMissedSlots({
      missed_slot_behavior: "catch_up",
      catch_up_max_delay_minutes: 150,
      catch_up_max_per_day: 1,
    });
    const resumeAt = new Date(new Date(slots[4]!.scheduled_for).getTime() + 60_000);
    await tick(resumeAt);

    const states = await sql<{
      status: string;
      status_reason: string | null;
      is_catch_up: boolean;
    }>(
      "select status, status_reason, is_catch_up from public.jobs where campaign_id = $1 and kind = 'conversation' order by scheduled_for limit 6",
      [campaign.id],
    );
    // Slots 0 and 1 are more than 150 minutes late: skipped. Slots 2 and 3 are within the delay,
    // but only one catch-up per day is allowed. Slot 4 is simply on time.
    expect(states.map((s) => s.status)).toEqual([
      "skipped",
      "skipped",
      "queued",
      "skipped",
      "queued",
      "pending",
    ]);
    expect(states.map((s) => s.is_catch_up)).toEqual([false, false, true, false, false, false]);
    expect(
      await sql("select 1 from public.runs where campaign_id = $1", [campaign.id]),
    ).toHaveLength(2);
  });

  it("applies the missed-slot setting to slots that passed while paused", async () => {
    const { workspace, campaign, slots } = await campaignWithMissedSlots({
      missed_slot_behavior: "skip",
    });
    await rpc(workspace.owner.client, "pause_campaign", { p_campaign_id: campaign.id });
    // Time passes while paused: nothing is dispatched or skipped yet.
    await tick(new Date(new Date(slots[2]!.scheduled_for).getTime() + 60_000));
    expect(
      await sql("select 1 from public.jobs where campaign_id = $1 and status <> 'pending'", [
        campaign.id,
      ]),
    ).toHaveLength(0);

    await sql(
      "update public.campaigns set status = 'running', paused_from = null, pause_reason = null where id = $1",
      [campaign.id],
    );
    await tick(new Date(new Date(slots[3]!.scheduled_for).getTime() + 60_000));
    const states = await sql<{ status: string }>(
      "select status from public.jobs where campaign_id = $1 and kind = 'conversation' order by scheduled_for limit 5",
      [campaign.id],
    );
    expect(states.map((s) => s.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "queued",
      "pending",
    ]);
  });
});

describe("campaign window", () => {
  it("does nothing before the start time and starts by itself when it arrives", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const start = new Date(Date.now() + 3 * 3600_000);
    const campaign = await createCampaign(workspace, connection, {
      questions: null,
      startAt: start,
      endAt: new Date(start.getTime() + 24 * 3600_000),
    });
    fake.reset();
    await launch(workspace, campaign);
    expect(await campaignStatus(campaign.id)).toBe("scheduled");
    await tick();
    await tick(new Date(start.getTime() - 60_000));
    expect(await campaignStatus(campaign.id)).toBe("scheduled");
    expect(
      await sql("select 1 from public.jobs where campaign_id = $1", [campaign.id]),
    ).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);

    await tick(new Date(start.getTime() + 1000));
    expect(await campaignStatus(campaign.id)).toBe("running");
    const [bounds] = await sql<{ first: Date; last: Date }>(
      "select min(scheduled_for) as first, max(scheduled_for) as last from public.jobs where campaign_id = $1",
      [campaign.id],
    );
    expect(new Date(bounds!.first).getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(new Date(bounds!.last).getTime()).toBeLessThan(start.getTime() + 24 * 3600_000);
  });

  it("schedules nothing past the end time and previews the same plan it executes", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const start = new Date(Date.UTC(2031, 0, 6, 12, 30, 0)); // a Monday, mid-window
    const end = new Date(Date.UTC(2031, 0, 8, 10, 0, 0));
    const campaign = await createCampaign(workspace, connection, {
      startAt: start,
      endAt: end,
      config: {
        timezone: "UTC",
        active_weekdays: [1, 2, 3],
        active_start_minute: 9 * 60,
        active_end_minute: 17 * 60,
        conversations_per_day: 8,
        baseline_samples: 2,
        daily_checks: 2,
        final_samples: 2,
      },
    });
    const preview = await rpc<{
      planned_conversations: number;
      scheduled_checks: number;
      provider_requests: number;
      days: { date: string; conversations: number; checks: number }[];
      steps: number;
    }>(workspace.owner.client, "campaign_plan_preview", { p_campaign_id: campaign.id });
    // Monday from 12:30 (13:00..16:00 = 4 slots), all of Tuesday (8), Wednesday before 10:00 (1).
    expect(preview.days).toEqual([
      { date: "2031-01-06", conversations: 4, checks: 1 },
      { date: "2031-01-07", conversations: 8, checks: 2 },
      { date: "2031-01-08", conversations: 1, checks: 0 },
    ]);
    expect(preview.planned_conversations).toBe(13);
    expect(preview.scheduled_checks).toBe(3);
    expect(preview.provider_requests).toBe(13 * 3 + 2 + 3 + 2);

    // Execute the same window with the real planner and compare.
    await sql("update public.campaign_revisions set baseline_samples = 0 where id = $1", [
      campaign.revisionId,
    ]);
    const check = await rpc<{ revision_id: string }>(
      workspace.owner.client,
      "campaign_launch_check",
      { p_campaign_id: campaign.id },
    );
    await rpc(workspace.owner.client, "launch_campaign", {
      p_campaign_id: campaign.id,
      p_expected_revision_id: check.revision_id,
    });
    for (let hours = 0; hours <= 48; hours += 12)
      await tick(new Date(start.getTime() + hours * 3600_000 + 1000));
    const actual = await sql<{ day: string; conversations: string; checks: string }>(
      `select slot_date::text as day,
              count(*) filter (where kind = 'conversation') as conversations,
              count(*) filter (where kind = 'check_daily') as checks
       from public.jobs where campaign_id = $1 group by slot_date order by slot_date`,
      [campaign.id],
    );
    expect(
      actual.map((row) => ({
        date: row.day,
        conversations: Number(row.conversations),
        checks: Number(row.checks),
      })),
    ).toEqual(preview.days);
    const [last] = await sql<{ last: Date }>(
      "select max(scheduled_for) as last from public.jobs where campaign_id = $1",
      [campaign.id],
    );
    expect(new Date(last!.last).getTime()).toBeLessThan(end.getTime());
  });
});

describe("queue activation", () => {
  it("stores the consumer settings in Vault and puts back a schedule that was removed", async () => {
    await sql("select cron.unschedule('lr-maintenance')");
    await expect(
      rpc(admin(), "svc_configure_worker", {
        p_functions_base_url: "http://kong:8000",
        p_worker_secret: "too-short",
      }),
    ).rejects.toThrow(/at least 24 characters/);

    try {
      await rpc(admin(), "svc_configure_worker", {
        p_functions_base_url: "http://kong:8000",
        p_worker_secret: "s".repeat(40),
      });
      // Activating twice changes nothing: one job per schedule, never a duplicate.
      await rpc(admin(), "svc_configure_worker", {
        p_functions_base_url: "http://kong:8000",
        p_worker_secret: "s".repeat(40),
      });

      const jobs = await sql<{ jobname: string; n: string }>(
        "select jobname, count(*)::text as n from cron.job where jobname like 'lr-%' group by jobname order by jobname",
      );
      expect(jobs).toEqual([
        { jobname: "lr-dispatch", n: "1" },
        { jobname: "lr-maintenance", n: "1" },
        { jobname: "lr-plan", n: "1" },
      ]);
      const secrets = await sql<{ name: string }>(
        "select name from vault.secrets where name in ('lr_functions_base_url', 'lr_worker_secret') order by name",
      );
      expect(secrets.map((secret) => secret.name)).toEqual([
        "lr_functions_base_url",
        "lr_worker_secret",
      ]);
    } finally {
      // Back to the state the other tests rely on: no HTTP wake-ups, schedules paused.
      await sql(
        "delete from vault.secrets where name in ('lr_functions_base_url', 'lr_worker_secret')",
      );
      await sql(
        "select cron.alter_job(jobid, active := false) from cron.job where jobname like 'lr-%'",
      );
    }
  });

  it("shows whether the database's wake-ups actually reach the worker", async () => {
    const workspace = await createWorkspace();
    type Wakes = {
      requested: number;
      accepted: number;
      rejected: number;
      last_accepted_at: string | null;
      last_problem: { status_code: number | null } | null;
    };
    const wakes = async () =>
      (
        await rpc<{ wakes: Wakes }>(workspace.owner.client, "operational_status", {
          p_workspace_id: workspace.id,
        })
      ).wakes;
    // One wake-up from the database to the real local worker function, and its answer.
    const wake = async () => {
      const requestId = await rpc<number>(admin(), "svc_wake_check");
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const result = await rpc<{ done: boolean; status_code?: number | null }>(
          admin(),
          "svc_wake_result",
          { p_request_id: requestId },
        );
        if (result.done) return result;
        await new Promise((done) => setTimeout(done, 500));
      }
      throw new Error("pg_net recorded no response for the wake-up");
    };
    await sql("delete from app_private.worker_wakes");

    // Not activated: there is nothing to call, and the check says so.
    await expect(rpc(admin(), "svc_wake_check")).rejects.toThrow(/not activated/);
    expect(await wakes()).toMatchObject({ requested: 0 });

    try {
      // "Activated" with a secret the function does not have: every wake-up is rejected, and
      // that is now visible instead of looking healthy.
      await rpc(admin(), "svc_configure_worker", {
        p_functions_base_url: "http://kong:8000",
        p_worker_secret: "w".repeat(40),
      });
      await sql(
        "select cron.alter_job(jobid, active := false) from cron.job where jobname like 'lr-%'",
      );
      expect(await wake()).toMatchObject({ done: true, status_code: 401 });
      expect(await wakes()).toMatchObject({
        requested: 1,
        accepted: 0,
        rejected: 1,
        last_accepted_at: null,
        last_problem: { status_code: 401 },
      });

      // With the function's real secret the worker accepts the wake-up (and finds no work).
      await rpc(admin(), "svc_configure_worker", {
        p_functions_base_url: "http://kong:8000",
        p_worker_secret: localWorkerSecret(),
      });
      await sql(
        "select cron.alter_job(jobid, active := false) from cron.job where jobname like 'lr-%'",
      );
      expect(await wake()).toMatchObject({ done: true, status_code: 202 });
      const after = await wakes();
      expect(after).toMatchObject({ requested: 2, accepted: 1, rejected: 1 });
      expect(after.last_accepted_at).not.toBeNull();

      // Browser roles can neither send a wake-up nor read one.
      await expect(rpc(workspace.owner.client, "svc_wake_check")).rejects.toThrow();
      await expect(
        rpc(workspace.owner.client, "svc_wake_result", { p_request_id: 1 }),
      ).rejects.toThrow();
    } finally {
      await sql(
        "delete from vault.secrets where name in ('lr_functions_base_url', 'lr_worker_secret')",
      );
      await sql(
        "select cron.alter_job(jobid, active := false) from cron.job where jobname like 'lr-%'",
      );
      await sql("delete from app_private.worker_wakes");
    }
  });
});
