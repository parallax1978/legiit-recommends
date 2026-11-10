"use server";

import { classifyResponse } from "@shared/core/detection.ts";
import { fail, type ActionResult } from "@/lib/result";
import { createClient } from "@/lib/supabase/server";
import { isUuid, mutate, operate } from "./helpers";

const INVALID = fail("That item could not be found.", "not_found");

function plain<T>(result: ActionResult<T>): ActionResult {
  return result.ok ? { ok: true, message: result.message } : result;
}

// --- Campaign lifecycle -----------------------------------------------------------------------

export async function pauseCampaign(campaignId: string): Promise<ActionResult> {
  if (!isUuid(campaignId)) return INVALID;
  return plain(
    await mutate((db) => db.rpc("pause_campaign", { p_campaign_id: campaignId }), {
      success: "Campaign paused. Requests already sent will finish; nothing new is dispatched.",
    }),
  );
}

export async function resumeCampaign(campaignId: string): Promise<ActionResult> {
  if (!isUuid(campaignId)) return INVALID;
  return plain(
    await mutate((db) => db.rpc("resume_campaign", { p_campaign_id: campaignId }), {
      success: "Campaign resumed.",
    }),
  );
}

export async function cancelCampaign(campaignId: string): Promise<ActionResult> {
  if (!isUuid(campaignId)) return INVALID;
  return plain(
    await mutate((db) => db.rpc("cancel_campaign", { p_campaign_id: campaignId }), {
      success: "Campaign canceled. No further work will be dispatched.",
    }),
  );
}

export async function requestTestConversation(campaignId: string): Promise<ActionResult<string>> {
  if (!isUuid(campaignId)) return INVALID;
  return mutate<string>(
    (db) => db.rpc("request_test_conversation", { p_campaign_id: campaignId }),
    { success: "Test conversation started. It is marked as a test and excluded from results." },
  );
}

// --- Recovery ---------------------------------------------------------------------------------

export async function retryJob(jobId: string): Promise<ActionResult> {
  if (!isUuid(jobId)) return INVALID;
  return plain(
    await mutate((db) => db.rpc("retry_job", { p_job_id: jobId }), {
      success: "Queued again. It continues from the last saved step.",
    }),
  );
}

export async function restartRun(runId: string): Promise<ActionResult<string>> {
  if (!isUuid(runId)) return INVALID;
  return mutate<string>((db) => db.rpc("restart_run", { p_run_id: runId }), {
    success: "A new conversation was started in place of this one. The original is kept.",
  });
}

export async function resolveUncertainAttempt(
  attemptId: string,
  resolution: "counted_as_spent" | "released",
): Promise<ActionResult> {
  if (!isUuid(attemptId)) return INVALID;
  return plain(
    await mutate(
      (db) =>
        db.rpc("resolve_uncertain_attempt", { p_attempt_id: attemptId, p_resolution: resolution }),
      {
        success:
          resolution === "released"
            ? "Reservation released."
            : "Recorded as spent at the reserved amount.",
      },
    ),
  );
}

// --- Classification ---------------------------------------------------------------------------

export async function correctClassification(input: {
  subjectType: "run_turn" | "fresh_check" | "manual_check";
  subjectId: string;
  inclusion: string;
  rank: number | null;
  listPosition: number | null;
  note: string;
}): Promise<ActionResult> {
  if (!isUuid(input.subjectId)) return INVALID;
  if (!["included", "mentioned_only", "not_mentioned"].includes(input.inclusion))
    return fail("Choose included, mentioned only, or not mentioned.", "invalid");
  if (input.rank !== null && (!Number.isInteger(input.rank) || input.rank < 1))
    return fail("Rank must be a whole number starting at 1.", "invalid");
  if (
    input.listPosition !== null &&
    (!Number.isInteger(input.listPosition) || input.listPosition < 1)
  )
    return fail("List position must be a whole number starting at 1.", "invalid");
  return plain(
    await mutate(
      (db) =>
        db.rpc("correct_classification", {
          p_subject_type: input.subjectType,
          p_subject_id: input.subjectId,
          p_inclusion: input.inclusion,
          p_rank: input.rank ?? undefined,
          p_list_position: input.listPosition ?? undefined,
          p_note: input.note.trim() || undefined,
        }),
      { success: "Classification corrected. The previous one is kept in the history." },
    ),
  );
}

export async function runModelClassification(
  subjectType: "run_turn" | "fresh_check" | "manual_check",
  subjectId: string,
): Promise<ActionResult> {
  if (!isUuid(subjectId)) return INVALID;
  return plain(
    await operate(
      "classification.run",
      { subject_type: subjectType, subject_id: subjectId },
      { success: "Model classification recorded. Its cost is listed under Usage." },
    ),
  );
}

// --- Manual ChatGPT observations --------------------------------------------------------------

export async function recordManualCheck(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const campaignId = String(formData.get("campaign_id") ?? "");
  const observedOn = String(formData.get("observed_on") ?? "");
  const source = String(formData.get("source_label") ?? "").trim();
  const question = String(formData.get("question") ?? "").trim();
  const response = String(formData.get("response_text") ?? "").trim();
  const errors: Record<string, string> = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(observedOn))
    errors.observed_on = "Enter the date of the observation.";
  if (!source)
    errors.source_label = "Say where this was observed, for example the app and plan used.";
  if (source.length > 120) errors.source_label = "Use at most 120 characters.";
  if (!response) errors.response_text = "Paste the response text.";
  if (response.length > 100_000)
    errors.response_text = "The response is longer than 100,000 characters.";
  if (!isUuid(campaignId) || Object.keys(errors).length > 0)
    return fail("Check the highlighted fields.", "invalid", errors);

  // Classified with the same rules as API responses, against the campaign's current target.
  const supabase = await createClient();
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("active_revision_id, draft_revision_id")
    .eq("id", campaignId)
    .maybeSingle();
  const revisionId = campaign?.active_revision_id ?? campaign?.draft_revision_id;
  if (!revisionId) return INVALID;
  const { data: revision } = await supabase
    .from("campaign_revisions")
    .select("business_name, website_url, business_aliases, domain_aliases")
    .eq("id", revisionId)
    .maybeSingle();
  if (!revision?.business_name)
    return fail(
      "Set the campaign's business name before recording observations.",
      "target_missing",
    );
  const classification = classifyResponse(response, {
    business_name: revision.business_name,
    website_url: revision.website_url,
    business_aliases: revision.business_aliases,
    domain_aliases: revision.domain_aliases,
  });

  return plain(
    await mutate(
      (db) =>
        db.rpc("record_manual_check", {
          p_campaign_id: campaignId,
          p_observed_on: observedOn,
          p_source_label: source,
          p_question: question,
          p_response_text: response,
          p_classification: JSON.parse(JSON.stringify(classification)),
        }),
      { success: "Manual observation recorded. Review its classification below." },
    ),
  );
}

export async function deleteManualCheck(manualCheckId: string): Promise<ActionResult> {
  if (!isUuid(manualCheckId)) return INVALID;
  return plain(
    await mutate((db) => db.rpc("delete_manual_check", { p_manual_check_id: manualCheckId }), {
      success: "Manual observation deleted.",
    }),
  );
}
