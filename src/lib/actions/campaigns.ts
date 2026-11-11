"use server";

import { redirect } from "next/navigation";
import {
  STANDARD_VALUE_COLUMNS,
  toStandardFormValues,
  type StandardFormValues,
} from "@/lib/campaign-defaults";
import { resolveSchedule } from "@/lib/campaign-schedule";
import type { LaunchCheck, PlanPreview } from "@/lib/queries/types";
import { fail, fromDbError, type ActionResult } from "@/lib/result";
import { getIdentity } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { isValidTimeZone } from "@/lib/timezone";
import { NOT_SIGNED_IN, isUuid, mutate, text } from "./helpers";

const INVALID = fail("That campaign could not be found.", "not_found");

function plain<T>(result: ActionResult<T>): ActionResult {
  return result.ok ? { ok: true, message: result.message } : result;
}

export async function createCampaign(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const workspaceId = text(formData, "workspace_id");
  const name = text(formData, "name");
  const description = text(formData, "description");
  if (!isUuid(workspaceId)) return INVALID;
  if (name.length < 1 || name.length > 120)
    return fail("Check the highlighted fields.", "invalid", {
      name: "Enter a campaign name between 1 and 120 characters.",
    });
  const result = await mutate<string>(
    (db) =>
      db.rpc("create_campaign", {
        p_workspace_id: workspaceId,
        p_name: name,
        p_description: description || undefined,
      }),
    { refresh: false },
  );
  if (!result.ok) return result;
  redirect(`/campaigns/${result.data}/edit`);
}

/** Everything the editor holds. Numbers arrive as text exactly as typed; blank means "not set". */
export interface CampaignDraftInput {
  name: string;
  description: string;
  business_name: string;
  website_url: string;
  business_aliases: string[];
  domain_aliases: string[];
  category: string;
  location: string;
  language: string;
  steps: { label: string; template_ids: string[] }[];
  selection_mode: string;
  selection_seed: string;
  on_existing_inclusion: string;
  connection_id: string;
  model: string;
  model_params: Record<string, string>;
  max_output_tokens: string;
  execution_mode: string;
  check_same_model: boolean;
  check_model: string;
  check_params: Record<string, string>;
  check_max_output_tokens: string;
  timezone: string;
  start_local: string;
  end_mode: string;
  end_local: string;
  duration_days: string;
  active_weekdays: number[];
  active_start: string;
  active_end: string;
  conversations_per_day: string;
  total_conversation_limit: string;
  max_concurrency: string;
  requests_per_minute: string;
  tokens_per_minute: string;
  jitter_seconds: string;
  missed_slot_behavior: string;
  catch_up_max_delay_minutes: string;
  catch_up_max_per_day: string;
  probe_set_id: string;
  baseline_samples: string;
  daily_checks: string;
  final_samples: string;
  daily_budget_usd: string;
  total_budget_usd: string;
}

export interface DraftSaved {
  revisionId: string;
  check: LaunchCheck;
  preview: PlanPreview;
  /** What is stored for the settings that take a standard value when they are saved blank. */
  stored: StandardFormValues | null;
}

type FieldErrors = Record<string, string>;

function wholeNumber(value: string, field: string, errors: FieldErrors): number | null {
  if (value.trim() === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number)) {
    errors[field] = "Enter a whole number.";
    return null;
  }
  return number;
}

function decimal(value: string, field: string, errors: FieldErrors): number | null {
  if (value.trim() === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    errors[field] = "Enter a number.";
    return null;
  }
  return number;
}

function minutes(value: string, field: string, errors: FieldErrors): number | null {
  if (value.trim() === "") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  const total = match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
  if (!match || Number(match[2]) > 59 || total > 1440) {
    errors[field] = "Enter a time such as 09:00.";
    return null;
  }
  return total;
}

function modelParams(
  input: Record<string, string>,
  prefix: string,
  errors: FieldErrors,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (input.reasoning_effort) out.reasoning_effort = input.reasoning_effort;
  if (input.verbosity) out.verbosity = input.verbosity;
  for (const key of ["temperature", "top_p"] as const) {
    const raw = (input[key] ?? "").trim();
    if (raw === "") continue;
    const number = Number(raw);
    if (!Number.isFinite(number)) errors[`${prefix}${key}`] = "Enter a number.";
    else out[key] = number;
  }
  return out;
}

/**
 * Saves the working copy of a campaign and returns the launch check and workload estimate for
 * what was saved. Saving never starts paid work: only the explicit Launch action does.
 */
export async function saveCampaignDraft(
  campaignId: string,
  input: CampaignDraftInput,
): Promise<ActionResult<DraftSaved>> {
  if (!isUuid(campaignId)) return INVALID;
  if (!(await getIdentity())) return NOT_SIGNED_IN;

  const errors: FieldErrors = {};
  if (input.name.trim().length < 1 || input.name.trim().length > 120)
    errors.name = "Enter a campaign name between 1 and 120 characters.";

  const timezone = input.timezone.trim();
  if (timezone && !isValidTimeZone(timezone)) errors.timezone = "Choose a valid IANA timezone.";
  const zone = timezone && isValidTimeZone(timezone) ? timezone : null;

  const schedule = resolveSchedule(input, zone, errors);

  const activeStart = minutes(input.active_start, "active_hours", errors);
  const activeEnd = minutes(input.active_end, "active_hours", errors);
  if (activeStart !== null && activeEnd !== null && activeEnd <= activeStart)
    errors.active_hours =
      "The end of the active hours must be after the start. Use 24:00 for the end of the day.";
  if (activeStart !== null && activeStart > 1439)
    errors.active_hours = "Active hours must start before 24:00.";

  const config: Record<string, unknown> = {
    business_name: input.business_name,
    website_url: input.website_url,
    business_aliases: input.business_aliases.map((alias) => alias.trim()).filter(Boolean),
    domain_aliases: input.domain_aliases.map((alias) => alias.trim()).filter(Boolean),
    category: input.category,
    location: input.location,
    language: input.language,
    connection_id: isUuid(input.connection_id) ? input.connection_id : null,
    model: input.model,
    model_params: modelParams(input.model_params, "", errors),
    max_output_tokens: wholeNumber(input.max_output_tokens, "max_output_tokens", errors),
    execution_mode: ["auto", "sync", "background"].includes(input.execution_mode)
      ? input.execution_mode
      : "auto",
    check_model: input.check_same_model ? null : input.check_model || null,
    check_params: input.check_same_model ? null : modelParams(input.check_params, "check_", errors),
    check_max_output_tokens: input.check_same_model
      ? null
      : wholeNumber(input.check_max_output_tokens, "check_max_output_tokens", errors),
    ...schedule,
    timezone: zone,
    active_weekdays: input.active_weekdays.length
      ? [...new Set(input.active_weekdays)].filter(
          (day) => Number.isInteger(day) && day >= 1 && day <= 7,
        )
      : null,
    active_start_minute: activeStart,
    active_end_minute: activeEnd,
    conversations_per_day: wholeNumber(
      input.conversations_per_day,
      "conversations_per_day",
      errors,
    ),
    total_conversation_limit: wholeNumber(
      input.total_conversation_limit,
      "total_conversation_limit",
      errors,
    ),
    max_concurrency: wholeNumber(input.max_concurrency, "max_concurrency", errors),
    requests_per_minute: wholeNumber(input.requests_per_minute, "requests_per_minute", errors),
    tokens_per_minute: wholeNumber(input.tokens_per_minute, "tokens_per_minute", errors),
    jitter_seconds: wholeNumber(input.jitter_seconds, "jitter_seconds", errors) ?? 0,
    missed_slot_behavior: ["skip", "catch_up"].includes(input.missed_slot_behavior)
      ? input.missed_slot_behavior
      : null,
    catch_up_max_delay_minutes:
      input.missed_slot_behavior === "catch_up"
        ? wholeNumber(input.catch_up_max_delay_minutes, "catch_up", errors)
        : null,
    catch_up_max_per_day:
      input.missed_slot_behavior === "catch_up"
        ? wholeNumber(input.catch_up_max_per_day, "catch_up", errors)
        : null,
    daily_budget_usd: decimal(input.daily_budget_usd, "daily_budget_usd", errors),
    total_budget_usd: decimal(input.total_budget_usd, "total_budget_usd", errors),
    probe_set_id: isUuid(input.probe_set_id) ? input.probe_set_id : null,
    baseline_samples: wholeNumber(input.baseline_samples, "checks", errors),
    daily_checks: wholeNumber(input.daily_checks, "checks", errors),
    final_samples: wholeNumber(input.final_samples, "checks", errors),
    on_existing_inclusion: ["continue", "finish_early"].includes(input.on_existing_inclusion)
      ? input.on_existing_inclusion
      : null,
    selection_mode: input.selection_mode === "seeded_random" ? "seeded_random" : "balanced",
    selection_seed: input.selection_seed.trim() || null,
  };

  const steps = input.steps.map((step) => ({
    label: step.label,
    template_ids: step.template_ids.filter(isUuid),
  }));
  if (steps.length < 3) errors.steps = "The conversation needs its three steps.";
  if (Object.keys(errors).length > 0)
    return fail("Some values could not be saved. Check the highlighted fields.", "invalid", errors);

  const supabase = await createClient();
  const saved = await supabase.rpc("save_campaign_draft", {
    p_campaign_id: campaignId,
    p_patch: JSON.parse(
      JSON.stringify({ name: input.name, description: input.description, config, steps }),
    ),
  });
  if (saved.error) return fromDbError(saved.error);

  const [check, preview, stored] = await Promise.all([
    supabase.rpc("campaign_launch_check", { p_campaign_id: campaignId }),
    supabase.rpc("campaign_plan_preview", { p_campaign_id: campaignId }),
    // A setting saved blank takes its standard value: read back what the form should now show.
    supabase
      .from("campaign_revisions")
      .select(STANDARD_VALUE_COLUMNS)
      .eq("id", saved.data as string)
      .maybeSingle(),
  ]);
  if (check.error) return fromDbError(check.error);
  if (preview.error) return fromDbError(preview.error);
  return {
    ok: true,
    message: "Draft saved.",
    data: {
      revisionId: saved.data as string,
      check: check.data as unknown as LaunchCheck,
      preview: preview.data as unknown as PlanPreview,
      // The draft itself was saved, so a failed read here only leaves the blanks as they were.
      stored: stored.data ? toStandardFormValues(stored.data) : null,
    },
  };
}

/**
 * Gives a draft that has no timezone the one the browser reports. It never replaces a timezone,
 * and the person can change it in the editor like any other setting.
 */
export async function suggestCampaignTimezone(
  campaignId: string,
  timezone: string,
): Promise<boolean> {
  if (!isUuid(campaignId) || !isValidTimeZone(timezone)) return false;
  if (!(await getIdentity())) return false;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("suggest_campaign_timezone", {
    p_campaign_id: campaignId,
    p_timezone: timezone,
  });
  return !error && data === true;
}

export async function discardCampaignDraft(campaignId: string): Promise<ActionResult> {
  if (!isUuid(campaignId)) return INVALID;
  return plain(
    await mutate((db) => db.rpc("discard_campaign_draft", { p_campaign_id: campaignId }), {
      success:
        "Pending changes discarded. The campaign keeps running with its current configuration.",
    }),
  );
}

export async function duplicateCampaign(campaignId: string): Promise<ActionResult<string>> {
  if (!isUuid(campaignId)) return INVALID;
  return mutate<string>((db) => db.rpc("duplicate_campaign", { p_campaign_id: campaignId }), {
    success: "Campaign duplicated as a new draft. Its schedule was cleared.",
  });
}

export async function setCampaignArchived(
  campaignId: string,
  archived: boolean,
): Promise<ActionResult> {
  if (!isUuid(campaignId)) return INVALID;
  return plain(
    await mutate(
      (db) => db.rpc("set_campaign_archived", { p_campaign_id: campaignId, p_archived: archived }),
      { success: archived ? "Campaign archived." : "Campaign restored." },
    ),
  );
}

export async function deleteCampaign(campaignId: string): Promise<ActionResult> {
  if (!isUuid(campaignId)) return INVALID;
  return plain(
    await mutate((db) => db.rpc("delete_campaign", { p_campaign_id: campaignId }), {
      success: "Campaign deleted.",
    }),
  );
}

/** The only action that starts paid campaign work. */
export async function launchCampaign(
  campaignId: string,
  expectedRevisionId: string,
): Promise<ActionResult> {
  if (!isUuid(campaignId) || !isUuid(expectedRevisionId)) return INVALID;
  return plain(
    await mutate(
      (db) =>
        db.rpc("launch_campaign", {
          p_campaign_id: campaignId,
          p_expected_revision_id: expectedRevisionId,
          p_validation: { reviewed_in: "web" },
        }),
      {
        success: "Campaign launched.",
      },
    ),
  );
}

export async function applyCampaignChanges(
  campaignId: string,
  expectedRevisionId: string,
): Promise<ActionResult> {
  if (!isUuid(campaignId) || !isUuid(expectedRevisionId)) return INVALID;
  const result = await mutate<{ revision_id: string; new_comparison_group: boolean }>(
    (db) =>
      db.rpc("apply_campaign_changes", {
        p_campaign_id: campaignId,
        p_expected_revision_id: expectedRevisionId,
        p_validation: { reviewed_in: "web" },
      }) as never,
    {},
  );
  if (!result.ok) return result;
  return {
    ok: true,
    message: result.data?.new_comparison_group
      ? "Changes applied to future work. Fresh-check settings changed, so a new comparison group starts with its own baseline."
      : "Changes applied to future work. Conversations already run keep the configuration they used.",
  };
}
