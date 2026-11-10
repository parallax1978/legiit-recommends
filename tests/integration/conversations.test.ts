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

interface TurnRow {
  run_id: string;
  step_index: number;
  status: string;
  rendered_prompt: string;
  response_id: string;
  previous_response_id: string | null;
  output_text: string;
  inclusion: string | null;
  rank: number | null;
  input_tokens: number;
  cost_usd: string;
}

async function dispatchNextSlots(campaignId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const [next] = await sql<{ scheduled_for: Date }>(
      "select scheduled_for from public.jobs where campaign_id = $1 and kind = 'conversation' and status = 'pending' order by scheduled_for limit 1",
      [campaignId],
    );
    if (!next) throw new Error("no pending conversation slot");
    await tick(new Date(next.scheduled_for));
  }
}

describe("conversation execution", () => {
  it("runs three real turns chained by previous_response_id and keeps runs isolated", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, { questions: null });
    fake.reset(); // forget verification traffic
    await launch(workspace, campaign);
    expect(await campaignStatus(campaign.id)).toBe("running");

    await dispatchNextSlots(campaign.id, 2);
    await drain(fake);

    const runs = await sql<{
      id: string;
      status: string;
      steps_completed: number;
      target_in_first_response: boolean;
    }>(
      "select id, status, steps_completed, target_in_first_response from public.runs where campaign_id = $1 order by ordinal",
      [campaign.id],
    );
    expect(runs).toHaveLength(2);
    for (const run of runs)
      expect(run).toMatchObject({
        status: "completed",
        steps_completed: 3,
        target_in_first_response: false,
      });

    const turns = await sql<TurnRow>(
      "select run_id, step_index, status, rendered_prompt, response_id, previous_response_id, output_text, inclusion, rank, input_tokens, cost_usd from public.run_turns where campaign_id = $1 order by run_id, step_index",
      [campaign.id],
    );
    expect(turns).toHaveLength(6);

    const requests = fake.responseRequests();
    expect(requests).toHaveLength(6);
    const allResponseIds = new Set(turns.map((turn) => turn.response_id));
    expect(allResponseIds.size).toBe(6);

    for (const run of runs) {
      const own = turns.filter((turn) => turn.run_id === run.id);
      const [first, second, third] = own as [TurnRow, TurnRow, TurnRow];

      // Exact prompts were rendered from the campaign's own inputs.
      expect(first.rendered_prompt).toBe(
        "What are the best coffee subscription services in Portland?",
      );
      expect(second.rendered_prompt).toBe(
        `Please add "${TARGET.business_name}" (${TARGET.website_url}) to that list.`,
      );
      expect(third.rendered_prompt).toBe("Can you show me the complete revised list?");

      // Each turn continues from the actual previous response of the same run.
      expect(first.previous_response_id).toBeNull();
      expect(second.previous_response_id).toBe(first.response_id);
      expect(third.previous_response_id).toBe(second.response_id);

      const sentFirst = requests.find(
        (r) =>
          r.body!.input === first.rendered_prompt &&
          fake.storedResponse(first.response_id)?.inputs[0] === r.body!.input &&
          !r.body!.previous_response_id &&
          requests.indexOf(r) >= 0 &&
          fake.storedResponse(first.response_id),
      );
      expect(sentFirst).toBeDefined();
      const sentSecond = requests.find((r) => r.body!.previous_response_id === first.response_id)!;
      const sentThird = requests.find((r) => r.body!.previous_response_id === second.response_id)!;
      expect(sentSecond.body!.input).toBe(second.rendered_prompt);
      expect(sentThird.body!.input).toBe(third.rendered_prompt);

      // The provider really held the whole conversation: turn three saw both earlier user turns.
      expect(fake.storedResponse(third.response_id)!.inputs).toEqual([
        first.rendered_prompt,
        second.rendered_prompt,
        third.rendered_prompt,
      ]);

      // Saved answers are the provider's actual answers, never prewritten text.
      for (const turn of own)
        expect(turn.output_text).toBe(fake.storedResponse(turn.response_id)!.output_text);

      // Measurement: absent in the first answer, present after the inclusion request.
      expect(first.inclusion).toBe("not_mentioned");
      expect(third).toMatchObject({ inclusion: "included", rank: 6 });

      // Chained turns are billed for the earlier context too.
      expect(second.input_tokens).toBeGreaterThan(first.input_tokens);
      expect(Number(third.cost_usd)).toBeGreaterThan(0);
    }

    // Fresh context per run: first turns carry no previous id, and no request of one run ever
    // references a response of the other.
    const firstTurnRequests = requests.filter((r) => !r.body!.previous_response_id);
    expect(firstTurnRequests).toHaveLength(2);
    const [runA, runB] = runs as unknown as [{ id: string }, { id: string }];
    const idsA = new Set(turns.filter((t) => t.run_id === runA.id).map((t) => t.response_id));
    const idsB = new Set(turns.filter((t) => t.run_id === runB.id).map((t) => t.response_id));
    for (const turn of turns) {
      if (!turn.previous_response_id) continue;
      const mine = turn.run_id === runA.id ? idsA : idsB;
      const theirs = turn.run_id === runA.id ? idsB : idsA;
      expect(mine.has(turn.previous_response_id)).toBe(true);
      expect(theirs.has(turn.previous_response_id)).toBe(false);
    }
  });

  it("sends only the user message: no system context, no target outside the owner's prompts", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, { questions: null });
    fake.reset();
    await launch(workspace, campaign);
    await dispatchNextSlots(campaign.id, 1);
    await drain(fake);

    const [first, second, third] = fake.responseRequests();
    for (const request of [first!, second!, third!]) {
      expect(request.body).not.toHaveProperty("instructions");
      expect(request.body).not.toHaveProperty("metadata");
      expect(request.body).not.toHaveProperty("tools");
      expect(typeof request.body!.input).toBe("string");
      expect(request.body!.store).toBe(true);
      expect(request.body!.max_output_tokens).toBe(600);
      // The SDK's own retry counter confirms a single attempt per request.
      expect(request.headers["x-stainless-retry-count"] ?? "0").toBe("0");
    }
    // The initial question does not name the business; the inclusion request is where it enters.
    expect(first!.raw).not.toContain(TARGET.business_name);
    expect(first!.raw).not.toContain("northwindroasters");
    expect(second!.raw).toContain(TARGET.business_name);

    const [run] = await sql<{ target_in_initial_prompt: boolean }>(
      "select target_in_initial_prompt from public.runs where campaign_id = $1",
      [campaign.id],
    );
    expect(run!.target_in_initial_prompt).toBe(false);
  });

  it("labels runs whose opening question already names the business", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, {
      questions: null,
      initialQuestions: ["Is {{business_name}} one of the best {{category}}?"],
    });
    await launch(workspace, campaign);
    await dispatchNextSlots(campaign.id, 1);
    await drain(fake);
    const [run] = await sql<{ target_in_initial_prompt: boolean }>(
      "select target_in_initial_prompt from public.runs where campaign_id = $1",
      [campaign.id],
    );
    expect(run!.target_in_initial_prompt).toBe(true);
  });

  it("records an existing mention before the inclusion request and follows the configured behavior", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);

    const early = await createCampaign(workspace, connection, {
      name: "Finish early",
      questions: null,
      config: { on_existing_inclusion: "finish_early" },
    });
    const full = await createCampaign(workspace, connection, {
      name: "Continue",
      questions: null,
      config: { on_existing_inclusion: "continue" },
    });
    fake.reset();
    fake.includeOrganically("coffee subscription", TARGET.business_name, 2);

    await launch(workspace, early);
    await launch(workspace, full);
    // Both campaigns share a schedule: one scheduler pass at the first slot starts one run each.
    await dispatchNextSlots(early.id, 1);
    await drain(fake);

    const [earlyRun] = await sql<{
      id: string;
      status: string;
      target_in_first_response: boolean;
      steps_completed: number;
    }>(
      "select id, status, target_in_first_response, steps_completed from public.runs where campaign_id = $1",
      [early.id],
    );
    expect(earlyRun).toMatchObject({
      status: "completed_early",
      target_in_first_response: true,
      steps_completed: 1,
    });
    const earlyTurns = await sql<{
      step_index: number;
      status: string;
      rank: number | null;
      inclusion: string | null;
    }>(
      "select step_index, status, rank, inclusion from public.run_turns where run_id = $1 order by step_index",
      [earlyRun!.id],
    );
    expect(earlyTurns.map((turn) => turn.status)).toEqual(["completed", "skipped", "skipped"]);
    expect(earlyTurns[0]).toMatchObject({ inclusion: "included", rank: 2 });

    const [fullRun] = await sql<{
      status: string;
      target_in_first_response: boolean;
      steps_completed: number;
    }>(
      "select status, target_in_first_response, steps_completed from public.runs where campaign_id = $1",
      [full.id],
    );
    expect(fullRun).toMatchObject({
      status: "completed",
      target_in_first_response: true,
      steps_completed: 3,
    });

    // Only the "continue" campaign sent an inclusion request.
    const inclusionRequests = fake
      .responseRequests()
      .filter((r) => String(r.body!.input).startsWith("Please add"));
    expect(inclusionRequests).toHaveLength(1);
  });

  it("supports additional user-message steps after the standard three", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, {
      questions: null,
      extraSteps: [
        ["Which of these would you pick for a small office in {{location}}?"],
        ["Thanks. Summarize the list once more."],
      ],
    });
    fake.reset();
    await launch(workspace, campaign);
    await dispatchNextSlots(campaign.id, 1);
    await drain(fake);

    const turns = await sql<{
      step_index: number;
      step_kind: string;
      status: string;
      response_id: string;
      previous_response_id: string | null;
    }>(
      "select step_index, step_kind, status, response_id, previous_response_id from public.run_turns where campaign_id = $1 order by step_index",
      [campaign.id],
    );
    expect(turns.map((turn) => turn.step_kind)).toEqual([
      "initial_question",
      "inclusion_request",
      "revision_request",
      "extra_step",
      "extra_step",
    ]);
    for (let i = 1; i < turns.length; i += 1) {
      expect(turns[i]!.previous_response_id).toBe(turns[i - 1]!.response_id);
    }
    expect(fake.storedResponse(turns[4]!.response_id)!.inputs).toHaveLength(5);
  });

  it("uses saved variations in a balanced order and stores the exact combination", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake, { maxConcurrent: 8 });
    const campaign = await createCampaign(workspace, connection, {
      questions: null,
      initialQuestions: [
        "Best {{category}}?",
        "Top {{category}} right now?",
        "Which {{category}} are worth it?",
      ],
      inclusionRequests: [
        'Add "{{business_name}}" please.',
        'Could you include "{{business_name}}" as well?',
      ],
      config: { max_concurrency: 6, conversations_per_day: 48 },
    });
    fake.reset();
    await launch(workspace, campaign);
    // Six combinations exist (3 x 2 x 1): six runs must use each exactly once.
    await dispatchNextSlots(campaign.id, 6);
    await drain(fake);

    const runs = await sql<{
      ordinal: number;
      combination_index: string;
      combination: { template_version_id: string }[];
      selection_seed: string;
    }>(
      "select ordinal, combination_index, combination, selection_seed from public.runs where campaign_id = $1 order by ordinal",
      [campaign.id],
    );
    expect(runs).toHaveLength(6);
    expect(new Set(runs.map((run) => run.combination_index)).size).toBe(6);
    expect(runs.every((run) => run.selection_seed === "test-seed")).toBe(true);
    expect(runs[0]!.combination).toHaveLength(3);

    // No generation call was spent on wording: every request is a conversation turn.
    expect(fake.responseRequests().every((r) => !("instructions" in r.body!))).toBe(true);

    const usage = await sql<{ template_id: string; uses: string }>(
      "select template_id, count(*) as uses from public.run_turns where campaign_id = $1 and step_index = 1 group by template_id",
      [campaign.id],
    );
    expect(usage.map((row) => Number(row.uses)).sort()).toEqual([2, 2, 2]);
  });

  it("runs a test conversation on a draft, marked as a test and charged to the ledger", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    const campaign = await createCampaign(workspace, connection, { questions: null });
    fake.reset();

    const runId = await rpc<string>(workspace.owner.client, "request_test_conversation", {
      p_campaign_id: campaign.id,
    });
    expect(await campaignStatus(campaign.id)).toBe("draft");
    await drain(fake);

    const [run] = await sql<{ kind: string; status: string; steps_completed: number }>(
      "select kind, status, steps_completed from public.runs where id = $1",
      [runId],
    );
    expect(run).toMatchObject({ kind: "test", status: "completed", steps_completed: 3 });

    const ledger = await sql<{ is_test: boolean; purpose: string; cost_usd: string }>(
      "select is_test, purpose, cost_usd from public.usage_ledger where campaign_id = $1",
      [campaign.id],
    );
    expect(ledger).toHaveLength(3);
    expect(
      ledger.every(
        (row) => row.is_test && row.purpose === "conversation_turn" && Number(row.cost_usd) > 0,
      ),
    ).toBe(true);

    // Test conversations never count as campaign results.
    const metrics = await rpc<unknown[]>(workspace.owner.client, "campaign_conversation_metrics", {
      p_campaign_id: campaign.id,
    });
    expect(metrics).toEqual([]);
  });
});
