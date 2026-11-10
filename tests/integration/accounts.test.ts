import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeOpenAI } from "../support/fake-openai.ts";
import {
  addMember,
  admin,
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
  await resetDatabase();
  fake = await startFake();
});
afterAll(async () => {
  await fake.stop();
  await closeConnections();
});

const rejects = async (statement: string, params: unknown[]) =>
  sql(statement, params).then(
    () => null,
    (error: Error) => error.message,
  );

describe("deleting an account", () => {
  it("removes the login and keeps, unchanged, the history that person authored", async () => {
    const workspace = await createWorkspace();
    const connection = await createConnection(workspace, fake);
    // An admin writes the prompts and the question set, builds the campaign and launches it.
    const author = await addMember(workspace, "admin");
    const asAuthor = { ...workspace, owner: author };
    const campaign = await createCampaign(asAuthor, connection, {
      config: { baseline_samples: 1, daily_checks: 0, final_samples: 0 },
    });
    await launch(asAuthor, campaign);
    await drain(fake);
    // The baseline is done: the next scheduler pass plans the conversations.
    await tick();
    const [slot] = await sql<{ scheduled_for: Date }>(
      "select scheduled_for from public.jobs where campaign_id = $1 and kind = 'conversation' and status = 'pending' order by scheduled_for limit 1",
      [campaign.id],
    );
    await tick(new Date(slot!.scheduled_for));
    await drain(fake);
    await rpc(author.client, "record_manual_check", {
      p_campaign_id: campaign.id,
      p_observed_on: new Date().toISOString().slice(0, 10),
      p_source_label: "ChatGPT web app",
      p_question: "Best coffee subscriptions?",
      p_response_text: "1. Alpha\n2. Beta",
      p_classification: null,
    });

    const snapshot = async () => ({
      versions: await sql(
        `select v.id, v.body, v.created_by from public.template_versions v
         join public.templates t on t.id = v.template_id where t.workspace_id = $1 order by v.id`,
        [workspace.id],
      ),
      revision: (
        await sql(
          "select id, state, conversations_per_day, created_by, frozen_by from public.campaign_revisions where id = $1",
          [campaign.revisionId],
        )
      )[0],
      counts: (
        await sql(
          `select (select count(*)::int from public.runs where campaign_id = $1) as runs,
                  (select count(*)::int from public.run_turns where campaign_id = $1) as turns,
                  (select count(*)::int from public.fresh_checks where campaign_id = $1) as checks,
                  (select count(*)::int from public.manual_checks where campaign_id = $1) as manual,
                  (select count(*)::int from public.usage_ledger where campaign_id = $1) as usage,
                  (select count(*)::int from public.audit_events where workspace_id = $2) as audit`,
          [campaign.id, workspace.id],
        )
      )[0],
    });
    const before = await snapshot();
    expect(
      (before.versions as { created_by: string }[]).every((v) => v.created_by === author.id),
    ).toBe(true);
    expect(before.revision).toMatchObject({
      state: "frozen",
      created_by: author.id,
      frozen_by: author.id,
    });
    expect(before.counts).toMatchObject({ runs: 1, turns: 3, checks: 1, manual: 1 });

    // "Delete user" in the Supabase dashboard does exactly this.
    const removed = await admin().auth.admin.deleteUser(author.id);
    expect(removed.error).toBeNull();
    expect(await sql("select 1 from auth.users where id = $1", [author.id])).toEqual([]);

    // The history is all still there; only who wrote it is now unknown.
    const after = await snapshot();
    expect(after.counts).toEqual(before.counts);
    expect(after.versions).toEqual(
      (before.versions as Record<string, unknown>[]).map((v) => ({ ...v, created_by: null })),
    );
    expect(after.revision).toEqual({ ...before.revision, created_by: null, frozen_by: null });
    expect(
      await sql("select 1 from public.workspace_members where workspace_id = $1 and user_id = $2", [
        workspace.id,
        author.id,
      ]),
    ).toEqual([]);
    // The remaining owner still sees the campaign and its results.
    const metrics = await rpc<Record<string, number>[]>(
      workspace.owner.client,
      "campaign_conversation_metrics",
      { p_campaign_id: campaign.id },
    );
    expect(Number(metrics[0]!.runs_total)).toBe(1);

    // Nothing else about these records became editable.
    const versionId = (after.versions as { id: string }[])[0]!.id;
    expect(
      await rejects("update public.template_versions set body = 'rewritten' where id = $1", [
        versionId,
      ]),
    ).toMatch(/immutable/);
    expect(
      await rejects("update public.template_versions set created_by = $2 where id = $1", [
        versionId,
        workspace.owner.id,
      ]),
    ).toMatch(/immutable/);
    expect(
      await rejects(
        "update public.campaign_revisions set conversations_per_day = 1 where id = $1",
        [campaign.revisionId],
      ),
    ).toMatch(/frozen campaign revision cannot be modified/);
    expect(
      await rejects("update public.campaign_revisions set created_by = $2 where id = $1", [
        campaign.revisionId,
        workspace.owner.id,
      ]),
    ).toMatch(/frozen campaign revision cannot be modified/);
  });
});
