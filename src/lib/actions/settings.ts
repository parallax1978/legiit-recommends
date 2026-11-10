"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { fail, type ActionResult } from "@/lib/result";
import { WORKSPACE_COOKIE } from "@/lib/session";
import { amount, integer, isUuid, mutate, operate, text } from "./helpers";

const INVALID = fail("Check the highlighted fields.", "invalid");

// --- Profile and workspace --------------------------------------------------------------------

export async function updateProfile(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const name = text(formData, "display_name");
  if (name.length > 120)
    return fail("Use at most 120 characters.", "invalid", {
      display_name: "Use at most 120 characters.",
    });
  const result = await mutate((db) => db.rpc("update_profile", { p_display_name: name }), {
    success: "Profile saved.",
  });
  return result.ok ? { ok: true, message: result.message } : result;
}

export async function updateWorkspace(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const workspaceId = text(formData, "workspace_id");
  const name = text(formData, "name");
  const retention = integer(text(formData, "retention_days"));
  const errors: Record<string, string> = {};
  if (name.length < 1 || name.length > 80)
    errors.name = "Enter a name between 1 and 80 characters.";
  if (Number.isNaN(retention) || (retention !== null && (retention < 1 || retention > 3650)))
    errors.retention_days =
      "Enter a number of days between 1 and 3650, or leave blank to keep everything.";
  if (!isUuid(workspaceId) || Object.keys(errors).length > 0)
    return { ...INVALID, fieldErrors: errors };
  const result = await mutate(
    (db) =>
      db.rpc("update_workspace", {
        p_workspace_id: workspaceId,
        p_name: name,
        p_retention_days: retention as number,
      }),
    {
      success: "Workspace settings saved.",
    },
  );
  return result.ok ? { ok: true, message: result.message } : result;
}

export async function setEmergencyStop(
  workspaceId: string,
  enabled: boolean,
  reason: string | null,
): Promise<ActionResult> {
  if (!isUuid(workspaceId)) return INVALID;
  const result = await mutate(
    (db) =>
      db.rpc("set_emergency_stop", {
        p_workspace_id: workspaceId,
        p_enabled: enabled,
        p_reason: reason ?? undefined,
      }),
    {
      success: enabled
        ? "Emergency stop is on. No provider requests will be sent."
        : "Emergency stop released. Paused work is being re-queued.",
    },
  );
  return result.ok ? { ok: true, message: result.message } : result;
}

export async function deleteWorkspace(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const workspaceId = text(formData, "workspace_id");
  const confirm = text(formData, "confirm_name");
  if (!isUuid(workspaceId)) return INVALID;
  const result = await mutate(
    (db) => db.rpc("delete_workspace", { p_workspace_id: workspaceId, p_confirm_name: confirm }),
    { refresh: false },
  );
  if (!result.ok) return result;
  (await cookies()).delete(WORKSPACE_COOKIE);
  redirect("/overview");
}

// --- Members ----------------------------------------------------------------------------------

export async function inviteMember(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const workspaceId = text(formData, "workspace_id");
  const email = text(formData, "email").toLowerCase();
  const role = text(formData, "role");
  if (!isUuid(workspaceId)) return INVALID;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return { ...INVALID, fieldErrors: { email: "Enter a valid email address." } };
  const result = await operate<{ outcome: string }>(
    "members.invite",
    { workspace_id: workspaceId, email, role },
    {
      success: (data) =>
        data.outcome === "added"
          ? `${email} already has an account and was added to the workspace.`
          : data.outcome === "already_member"
            ? `${email} is already a member.`
            : `Invitation sent to ${email}.`,
    },
  );
  return result.ok ? { ok: true, message: result.message } : result;
}

/** Sends a pending invitation again: a fresh email with a fresh link replaces the old one. */
export async function resendInvitation(
  workspaceId: string,
  email: string,
  role: "owner" | "admin" | "member",
): Promise<ActionResult> {
  if (!isUuid(workspaceId) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return INVALID;
  const result = await operate<{ outcome: string }>(
    "members.invite",
    { workspace_id: workspaceId, email: email.toLowerCase(), role },
    {
      success: (data) =>
        data.outcome === "invited"
          ? `A new invitation was sent to ${email}.`
          : `${email} has joined the workspace in the meantime.`,
    },
  );
  return result.ok ? { ok: true, message: result.message } : result;
}

export async function updateMemberRole(
  workspaceId: string,
  userId: string,
  role: "owner" | "admin" | "member",
): Promise<ActionResult> {
  if (!isUuid(workspaceId) || !isUuid(userId)) return INVALID;
  const result = await mutate(
    (db) =>
      db.rpc("update_member_role", {
        p_workspace_id: workspaceId,
        p_user_id: userId,
        p_role: role,
      }),
    { success: "Role updated." },
  );
  return result.ok ? { ok: true, message: result.message } : result;
}

export async function removeMember(workspaceId: string, userId: string): Promise<ActionResult> {
  if (!isUuid(workspaceId) || !isUuid(userId)) return INVALID;
  const result = await mutate(
    (db) => db.rpc("remove_member", { p_workspace_id: workspaceId, p_user_id: userId }),
    { success: "Member removed." },
  );
  return result.ok ? { ok: true, message: result.message } : result;
}

export async function revokeInvitation(invitationId: string): Promise<ActionResult> {
  if (!isUuid(invitationId)) return INVALID;
  const result = await mutate(
    (db) => db.rpc("revoke_invitation", { p_invitation_id: invitationId }),
    { success: "Invitation revoked." },
  );
  return result.ok ? { ok: true, message: result.message } : result;
}

// --- Connections ------------------------------------------------------------------------------

function connectionLimits(formData: FormData) {
  const errors: Record<string, string> = {};
  const daily = amount(text(formData, "daily_budget_usd"));
  const total = amount(text(formData, "total_budget_usd"));
  const concurrent = integer(text(formData, "max_concurrent_requests"));
  const rpm = integer(text(formData, "requests_per_minute"));
  const tpm = integer(text(formData, "tokens_per_minute"));
  if (daily === null || Number.isNaN(daily) || daily <= 0)
    errors.daily_budget_usd = "Enter a daily spending limit greater than 0.";
  if (Number.isNaN(total) || (total !== null && total <= 0))
    errors.total_budget_usd = "Enter an amount greater than 0, or leave blank for no total limit.";
  if (concurrent === null || Number.isNaN(concurrent) || concurrent < 1 || concurrent > 64)
    errors.max_concurrent_requests = "Enter a whole number between 1 and 64.";
  if (Number.isNaN(rpm) || (rpm !== null && rpm < 1))
    errors.requests_per_minute = "Enter a whole number, or leave blank for no cap.";
  if (Number.isNaN(tpm) || (tpm !== null && tpm < 1000))
    errors.tokens_per_minute = "Enter at least 1000, or leave blank for no cap.";
  return { errors, daily, total, concurrent, rpm, tpm };
}

export async function createConnection(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const workspaceId = text(formData, "workspace_id");
  const name = text(formData, "name");
  const limits = connectionLimits(formData);
  if (name.length < 1 || name.length > 80)
    limits.errors.name = "Enter a name between 1 and 80 characters.";
  if (!isUuid(workspaceId) || Object.keys(limits.errors).length > 0)
    return { ...INVALID, fieldErrors: limits.errors };
  const result = await mutate(
    (db) =>
      db.rpc("create_connection", {
        p_workspace_id: workspaceId,
        p_name: name,
        p_daily_budget_usd: limits.daily as number,
        p_total_budget_usd: limits.total ?? undefined,
        p_max_concurrent_requests: limits.concurrent as number,
        p_requests_per_minute: limits.rpm ?? undefined,
        p_tokens_per_minute: limits.tpm ?? undefined,
      }),
    { success: "Connection created. Add its API key next." },
  );
  return result.ok ? { ok: true, message: result.message } : result;
}

export async function updateConnection(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const connectionId = text(formData, "connection_id");
  const name = text(formData, "name");
  const limits = connectionLimits(formData);
  if (name.length < 1 || name.length > 80)
    limits.errors.name = "Enter a name between 1 and 80 characters.";
  if (!isUuid(connectionId) || Object.keys(limits.errors).length > 0)
    return { ...INVALID, fieldErrors: limits.errors };
  const result = await mutate(
    (db) =>
      db.rpc("update_connection", {
        p_connection_id: connectionId,
        p_patch: {
          name,
          daily_budget_usd: limits.daily,
          total_budget_usd: limits.total,
          max_concurrent_requests: limits.concurrent,
          requests_per_minute: limits.rpm,
          tokens_per_minute: limits.tpm,
          store_fresh_check_responses: formData.get("store_fresh_check_responses") === "on",
        },
      }),
    { success: "Connection settings saved." },
  );
  return result.ok ? { ok: true, message: result.message } : result;
}

/** Stores (or replaces) the API key. The key goes straight to the backend function and Vault. */
export async function setConnectionCredential(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const connectionId = text(formData, "connection_id");
  const apiKey = text(formData, "api_key");
  if (!isUuid(connectionId)) return INVALID;
  if (apiKey.length < 20)
    return { ...INVALID, fieldErrors: { api_key: "Paste the full API key." } };
  const result = await operate<{ models: number }>(
    "connection.set_credential",
    { connection_id: connectionId, api_key: apiKey },
    { success: (data) => `Key verified and stored. ${data.models} models are visible to it.` },
  );
  return result.ok ? { ok: true, message: result.message } : result;
}

export async function testConnection(connectionId: string): Promise<ActionResult> {
  if (!isUuid(connectionId)) return INVALID;
  const result = await operate<{ models: number }>(
    "connection.test",
    { connection_id: connectionId },
    { success: (data) => `Connection works. ${data.models} models are visible to this key.` },
  );
  return result.ok ? { ok: true, message: result.message } : result;
}

export async function verifyModel(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const connectionId = text(formData, "connection_id");
  const modelId = text(formData, "model_id");
  const cap = integer(text(formData, "max_output_tokens"));
  const errors: Record<string, string> = {};
  if (!modelId) errors.model_id = "Choose a model.";
  if (cap === null || Number.isNaN(cap) || cap < 16)
    errors.max_output_tokens = "Enter the largest output cap you plan to use (at least 16).";
  if (!isUuid(connectionId) || Object.keys(errors).length > 0)
    return { ...INVALID, fieldErrors: errors };
  const result = await operate(
    "model.verify",
    { connection_id: connectionId, model_id: modelId, max_output_tokens: cap },
    { success: `${modelId} verified. Its supported settings are now available to campaigns.` },
  );
  return result.ok ? { ok: true, message: result.message } : result;
}

export async function declareDataSharing(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const connectionId = text(formData, "connection_id");
  const setting = text(formData, "setting");
  const verifiedOn = text(formData, "verified_on");
  const note = text(formData, "note");
  const errors: Record<string, string> = {};
  if (!["enabled", "disabled", "unknown"].includes(setting))
    errors.setting = "Choose the setting shown in your OpenAI organization.";
  if (setting !== "unknown" && !/^\d{4}-\d{2}-\d{2}$/.test(verifiedOn))
    errors.verified_on = "Enter the date you checked it.";
  if (!isUuid(connectionId) || Object.keys(errors).length > 0)
    return { ...INVALID, fieldErrors: errors };
  const result = await mutate(
    (db) =>
      db.rpc("declare_data_sharing", {
        p_connection_id: connectionId,
        p_setting: setting as "enabled" | "disabled" | "unknown",
        p_verified_on: (verifiedOn || null) as string,
        p_note: note || undefined,
      }),
    { success: "Data-sharing record saved." },
  );
  return result.ok ? { ok: true, message: result.message } : result;
}

export async function archiveConnection(connectionId: string): Promise<ActionResult> {
  if (!isUuid(connectionId)) return INVALID;
  const result = await mutate(
    (db) => db.rpc("archive_connection", { p_connection_id: connectionId }),
    { success: "Connection archived and its key deleted." },
  );
  return result.ok ? { ok: true, message: result.message } : result;
}

// --- Pricing ----------------------------------------------------------------------------------

export async function addModelPrice(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const workspaceId = text(formData, "workspace_id");
  const errors: Record<string, string> = {};
  const modelId = text(formData, "model_id");
  const sourceUrl = text(formData, "source_url");
  const verifiedOn = text(formData, "verified_on");
  const numbers: Record<string, number | null> = {};
  for (const key of [
    "input_usd_per_mtok",
    "cached_input_usd_per_mtok",
    "output_usd_per_mtok",
    "cache_write_30m_usd_per_mtok",
    "cache_write_12h_usd_per_mtok",
    "long_context_input_multiplier",
    "long_context_output_multiplier",
  ]) {
    const value = amount(text(formData, key));
    if (Number.isNaN(value) || (value !== null && value < 0))
      errors[key] = "Enter a number of 0 or more.";
    numbers[key] = value;
  }
  const threshold = integer(text(formData, "long_context_threshold_tokens"));
  if (Number.isNaN(threshold) || (threshold !== null && threshold < 1))
    errors.long_context_threshold_tokens = "Enter a whole number of tokens, or leave blank.";
  if (!modelId) errors.model_id = "Enter the exact model ID.";
  if (numbers.input_usd_per_mtok === null) errors.input_usd_per_mtok = "Enter the input price.";
  if (numbers.output_usd_per_mtok === null) errors.output_usd_per_mtok = "Enter the output price.";
  if (!/^https:\/\/\S+$/.test(sourceUrl))
    errors.source_url = "Enter the https URL of the price list you used.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(verifiedOn))
    errors.verified_on = "Enter the date you checked the price.";
  if (!isUuid(workspaceId) || Object.keys(errors).length > 0)
    return { ...INVALID, fieldErrors: errors };
  const result = await mutate(
    (db) =>
      db.rpc("add_model_price", {
        p_workspace_id: workspaceId,
        p_price: {
          model_id: modelId,
          ...numbers,
          long_context_threshold_tokens: threshold,
          source_url: sourceUrl,
          verified_on: verifiedOn,
          notes: text(formData, "notes") || null,
        },
      }),
    { success: `Price version saved for ${modelId}. It applies to work reserved from now on.` },
  );
  return result.ok ? { ok: true, message: result.message } : result;
}
