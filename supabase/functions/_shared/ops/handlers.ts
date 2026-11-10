// Owner and admin operations that need the provider or elevated access.
//
// Called from the `ops` Edge Function after the caller's session has been verified. Every
// handler authorizes the acting user against the workspace again (through the svc_* SQL
// functions, which check the actor's role themselves), so neither a submitted workspace id nor a
// campaign, connection or run id grants access on its own.
//
// Runtime-agnostic: used by the Deno function in production and by Node in tests.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CapabilityProfile, ModelParams } from "../core/capabilities.ts";
import { findMentions, type DetectionTarget } from "../core/detection.ts";
import { TEMPLATE_KINDS, type TemplateKind, type TemplateValues } from "../core/templates.ts";
import {
  buildClassificationRequest,
  estimateClassificationInputTokens,
  parseClassification,
} from "../provider/classify.ts";
import {
  buildGenerationRequest,
  estimateGenerationInputTokens,
  generationOutputCap,
  parseGeneration,
} from "../provider/generate.ts";
import { planProbe, probeModel } from "../provider/probe.ts";
import { describeRequest } from "../provider/requests.ts";
import type { ProviderFactory, ProviderFailure, ProviderOutcome } from "../provider/types.ts";

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service-role client
type Admin = SupabaseClient<any, any, any>;

export interface OpsContext {
  admin: Admin;
  /** The verified, signed-in user on whose behalf the operation runs. */
  userId: string;
  createProvider: ProviderFactory;
  /** Public URL of the web app, used in invitation emails. */
  siteUrl?: string;
}

export type OpsResult =
  { ok: true; [key: string]: unknown } | { ok: false; code: string; message: string };

type Role = "owner" | "admin" | "member";

const fail = (code: string, message: string): OpsResult => ({ ok: false, code, message });

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/** Converts a database error raised by app_private.fail/forbid into a result. */
function fromDbError(error: {
  message: string;
  details?: string | null;
  code?: string;
}): OpsResult {
  if (error.code === "42501") return fail("forbidden", error.message);
  return fail(
    error.details && /^[a-z_]+$/.test(error.details) ? error.details : "database_error",
    error.message,
  );
}

async function roleIn(ctx: OpsContext, workspaceId: string): Promise<Role | null> {
  const { data } = await ctx.admin.rpc("svc_member_role", {
    p_workspace_id: workspaceId,
    p_user_id: ctx.userId,
  });
  return (data as Role | null) ?? null;
}

function allows(role: Role | null, minimum: "owner" | "admin"): boolean {
  if (!role) return false;
  return minimum === "owner" ? role === "owner" : role === "owner" || role === "admin";
}

const NOT_FOUND = fail("not_found", "Not found or access denied.");

/** Operational message for a provider failure, safe to show to workspace members. */
export function describeFailure(failure: ProviderFailure): { code: string; message: string } {
  const detail = failure.message ? ` (${failure.message.slice(0, 300)})` : "";
  switch (failure.class) {
    case "invalid_credentials":
      return {
        code: failure.class,
        message: `OpenAI rejected the API key. Check that it is correct, active and allowed for this project.${detail}`,
      };
    case "quota_exhausted":
      return {
        code: failure.class,
        message: `The OpenAI account has no available quota or has reached a spend limit.${detail}`,
      };
    case "permission_denied":
      return { code: failure.class, message: `OpenAI denied access for this key.${detail}` };
    case "model_unavailable":
      return { code: failure.class, message: `The model is not available to this key.${detail}` };
    case "rate_limited":
      return {
        code: failure.class,
        message: "OpenAI is rate limiting this key right now. Try again in a moment.",
      };
    case "timeout":
      return { code: failure.class, message: "OpenAI did not answer in time. Try again." };
    case "connection_error":
      return { code: failure.class, message: "Could not reach OpenAI. Try again." };
    case "server_error":
    case "provider_failed":
      return {
        code: failure.class,
        message: `OpenAI reported a temporary error. Try again.${detail}`,
      };
    default:
      return { code: failure.class, message: `OpenAI rejected the request.${detail}` };
  }
}

interface ConnectionRow {
  id: string;
  workspace_id: string;
  status: string;
  archived_at: string | null;
}

async function loadConnection(
  ctx: OpsContext,
  connectionId: unknown,
): Promise<ConnectionRow | null> {
  if (!isUuid(connectionId)) return null;
  const { data } = await ctx.admin
    .from("provider_connections")
    .select("id, workspace_id, status, archived_at")
    .eq("id", connectionId)
    .maybeSingle();
  return (data as ConnectionRow | null) ?? null;
}

function adhocOutcome(
  outcome: ProviderOutcome,
  sentParams?: Record<string, unknown>,
): Record<string, unknown> {
  const params = sentParams ? { request_params: sentParams } : {};
  if (outcome.kind === "result") {
    const { result } = outcome;
    return {
      ...params,
      status: result.status === "completed" ? "succeeded" : "incomplete",
      usage: result.usage,
      response_id: result.response_id,
      returned_model: result.returned_model,
      service_tier: result.service_tier,
      response_status: result.status,
      http_status: result.http_status,
      provider_request_id: result.provider_request_id,
      latency_ms: result.latency_ms,
    };
  }
  if (outcome.kind === "pending") {
    // Accepted but never seen finishing: its cost is unknown.
    return {
      ...params,
      status: "uncertain",
      response_id: outcome.pending.response_id,
      error_class: "timeout",
      error_message: "The background response did not finish while it was being followed.",
      latency_ms: outcome.pending.latency_ms,
    };
  }
  const { failure } = outcome;
  return {
    ...params,
    status: failure.uncertain ? "uncertain" : "failed",
    ...(failure.usage ? { usage: failure.usage } : {}),
    response_id: failure.response_id,
    http_status: failure.http_status,
    error_class: failure.class,
    error_type: failure.type,
    error_code: failure.code,
    error_param: failure.param,
    error_message: failure.message,
    provider_request_id: failure.provider_request_id,
    latency_ms: failure.latency_ms,
  };
}

// ---------------------------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------------------------

/** Tests a new API key, and only then stores it in Vault (replacing any previous key). */
export async function setCredential(
  ctx: OpsContext,
  input: { connection_id?: unknown; api_key?: unknown },
): Promise<OpsResult> {
  const connection = await loadConnection(ctx, input.connection_id);
  if (!connection || !allows(await roleIn(ctx, connection.workspace_id), "owner")) return NOT_FOUND;
  const apiKey = typeof input.api_key === "string" ? input.api_key.trim() : "";
  if (apiKey.length < 20 || /\s/.test(apiKey))
    return fail("invalid_api_key", "That does not look like an API key.");

  const listed = await ctx.createProvider(apiKey).listModels({ timeoutMs: 25_000 });
  if (!listed.ok) {
    // The previous key (if any) stays in place and keeps working.
    return { ok: false, ...describeFailure(listed.failure) };
  }

  const stored = await ctx.admin.rpc("svc_store_connection_secret", {
    p_connection_id: connection.id,
    p_actor: ctx.userId,
    p_api_key: apiKey,
  });
  if (stored.error) return fromDbError(stored.error);

  await ctx.admin.rpc("svc_record_connection_status", {
    p_connection_id: connection.id,
    p_ok: true,
    p_actor: ctx.userId,
  });
  await ctx.admin.rpc("svc_upsert_provider_models", {
    p_connection_id: connection.id,
    p_models: listed.models,
  });
  return { ok: true, models: listed.models.length };
}

/** Checks the stored key against the provider and refreshes the list of visible models. */
export async function testConnection(
  ctx: OpsContext,
  input: { connection_id?: unknown },
): Promise<OpsResult> {
  const connection = await loadConnection(ctx, input.connection_id);
  if (!connection || !allows(await roleIn(ctx, connection.workspace_id), "admin")) return NOT_FOUND;

  const { data: apiKey } = await ctx.admin.rpc("svc_get_connection_secret", {
    p_connection_id: connection.id,
  });
  if (!apiKey) return fail("not_configured", "No API key is stored for this connection yet.");

  const listed = await ctx.createProvider(apiKey as string).listModels({ timeoutMs: 25_000 });
  if (!listed.ok) {
    const described = describeFailure(listed.failure);
    // Only definite answers about the key change the stored status; a network blip does not.
    if (
      ["invalid_credentials", "quota_exhausted", "permission_denied"].includes(listed.failure.class)
    ) {
      await ctx.admin.rpc("svc_record_connection_status", {
        p_connection_id: connection.id,
        p_ok: false,
        p_code: described.code,
        p_message: described.message,
        p_actor: ctx.userId,
      });
    }
    return { ok: false, ...described };
  }
  await ctx.admin.rpc("svc_record_connection_status", {
    p_connection_id: connection.id,
    p_ok: true,
    p_actor: ctx.userId,
  });
  await ctx.admin.rpc("svc_upsert_provider_models", {
    p_connection_id: connection.id,
    p_models: listed.models,
  });
  return { ok: true, models: listed.models.length };
}

/**
 * Verifies that a model the key can see works with the Responses workflow, and records which
 * parameters it accepts. Sends real (tiny) requests: budget is reserved first and every request
 * is written to the usage ledger.
 */
export async function verifyModel(
  ctx: OpsContext,
  input: { connection_id?: unknown; model_id?: unknown; max_output_tokens?: unknown },
): Promise<OpsResult> {
  const connection = await loadConnection(ctx, input.connection_id);
  if (!connection || !allows(await roleIn(ctx, connection.workspace_id), "owner")) return NOT_FOUND;
  const modelId = typeof input.model_id === "string" ? input.model_id.trim() : "";
  const cap = Number(input.max_output_tokens);
  if (!modelId) return fail("invalid_model", "Choose a model to verify.");
  if (!Number.isInteger(cap) || cap < 16 || cap > 1_000_000) {
    return fail(
      "invalid_output_cap",
      "Enter the largest output cap to verify, between 16 and 1,000,000 tokens.",
    );
  }

  const { data: listedModel } = await ctx.admin
    .from("provider_models")
    .select("model_id, is_listed")
    .eq("connection_id", connection.id)
    .eq("model_id", modelId)
    .maybeSingle();
  if (!listedModel || !listedModel.is_listed) {
    return fail(
      "model_not_listed",
      "This model is not in the list of models visible to the connection's key. Refresh the list and choose again.",
    );
  }

  const plan = planProbe(cap);
  const begun = await ctx.admin.rpc("svc_begin_adhoc", {
    p_workspace_id: connection.workspace_id,
    p_actor: ctx.userId,
    p_connection_id: connection.id,
    p_purpose: "model_probe",
    p_model: modelId,
    p_requests: plan.map((step) => ({
      est_input_tokens: step.est_input_tokens,
      max_output_tokens: step.max_output_tokens,
      request_params: { probe: step.key, ...step.request_params },
    })),
  });
  if (begun.error) return fromDbError(begun.error);
  const reservation = begun.data as {
    ok: boolean;
    code?: string;
    message?: string;
    attempt_ids?: string[];
  };
  if (!reservation.ok)
    return fail(reservation.code ?? "blocked", reservation.message ?? "The request was blocked.");

  const attemptByKey = new Map(
    plan.map((step, index) => [step.key, reservation.attempt_ids![index]!]),
  );
  const finish = async (key: string, outcome: Record<string, unknown>) => {
    await ctx.admin.rpc("svc_finish_adhoc", {
      p_attempt_id: attemptByKey.get(key),
      p_outcome: outcome,
    });
  };

  const { data: apiKey } = await ctx.admin.rpc("svc_get_connection_secret", {
    p_connection_id: connection.id,
  });
  if (!apiKey) {
    for (const step of plan) await finish(step.key, { status: "unused" });
    return fail("not_configured", "No API key is stored for this connection yet.");
  }

  const result = await probeModel(ctx.createProvider(apiKey as string), modelId, cap, {
    onOutcome: (key, outcome, sent) => finish(key, adhocOutcome(outcome, { probe: key, ...sent })),
    onUnused: (key) => finish(key, { status: "unused" }),
  });

  const saved = await ctx.admin.rpc("svc_save_model_verification", {
    p_connection_id: connection.id,
    p_actor: ctx.userId,
    p_model_id: modelId,
    p_verified: result.verified,
    p_capabilities: result.capabilities,
    p_error: result.error,
  });
  if (saved.error) return fromDbError(saved.error);
  if (!result.verified) {
    return fail("verification_failed", result.error ?? "The model could not be verified.");
  }
  return { ok: true, capabilities: result.capabilities };
}

// ---------------------------------------------------------------------------------------------
// Variation generation
// ---------------------------------------------------------------------------------------------

interface RevisionRow {
  workspace_id: string;
  campaign_id: string;
  connection_id: string | null;
  model: string | null;
  business_name: string | null;
  website_url: string | null;
  business_aliases: string[] | null;
  domain_aliases: string[] | null;
  category: string | null;
  location: string | null;
  language: string | null;
}

const REVISION_COLUMNS =
  "workspace_id, campaign_id, connection_id, model, business_name, website_url, business_aliases, domain_aliases, category, location, language";

async function workingRevision(ctx: OpsContext, campaignId: string): Promise<RevisionRow | null> {
  const { data: campaign } = await ctx.admin
    .from("campaigns")
    .select("draft_revision_id, active_revision_id")
    .eq("id", campaignId)
    .maybeSingle();
  const revisionId = campaign?.draft_revision_id ?? campaign?.active_revision_id;
  if (!revisionId) return null;
  const { data } = await ctx.admin
    .from("campaign_revisions")
    .select(REVISION_COLUMNS)
    .eq("id", revisionId)
    .maybeSingle();
  return (data as RevisionRow | null) ?? null;
}

function targetOf(revision: RevisionRow): DetectionTarget | null {
  if (!revision.business_name) return null;
  return {
    business_name: revision.business_name,
    website_url: revision.website_url,
    business_aliases: revision.business_aliases ?? [],
    domain_aliases: revision.domain_aliases ?? [],
  };
}

async function modelCapabilities(
  ctx: OpsContext,
  connectionId: string,
  model: string,
): Promise<CapabilityProfile | null> {
  const { data } = await ctx.admin
    .from("provider_models")
    .select("capabilities, verification_status")
    .eq("connection_id", connectionId)
    .eq("model_id", model)
    .maybeSingle();
  return data?.verification_status === "verified" ? (data.capabilities as CapabilityProfile) : null;
}

/**
 * Generates candidate wordings for review. Nothing is saved to the template library here: the
 * person reviews and edits the candidates and saves the ones they want.
 */
export async function generateVariations(
  ctx: OpsContext,
  input: {
    workspace_id?: unknown;
    campaign_id?: unknown;
    connection_id?: unknown;
    model?: unknown;
    kind?: unknown;
    count?: unknown;
    examples?: unknown;
    guidance?: unknown;
    values?: unknown;
  },
): Promise<OpsResult> {
  if (!isUuid(input.workspace_id)) return NOT_FOUND;
  const workspaceId = input.workspace_id;
  if (!allows(await roleIn(ctx, workspaceId), "admin")) return NOT_FOUND;

  const kind = input.kind as TemplateKind;
  if (!TEMPLATE_KINDS.includes(kind))
    return fail("invalid_kind", "Choose which kind of prompt to generate.");
  const count = Number(input.count);
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    return fail("invalid_count", "Choose how many variations to generate, between 1 and 50.");
  }

  let revision: RevisionRow | null = null;
  if (input.campaign_id != null) {
    if (!isUuid(input.campaign_id)) return NOT_FOUND;
    revision = await workingRevision(ctx, input.campaign_id);
    if (!revision || revision.workspace_id !== workspaceId) return NOT_FOUND;
  }

  const connectionId = isUuid(input.connection_id) ? input.connection_id : revision?.connection_id;
  const model =
    typeof input.model === "string" && input.model.trim() ? input.model.trim() : revision?.model;
  if (!connectionId || !model)
    return fail("model_required", "Choose a connection and a verified model for generation.");
  const connection = await loadConnection(ctx, connectionId);
  if (!connection || connection.workspace_id !== workspaceId) return NOT_FOUND;
  const capabilities = await modelCapabilities(ctx, connection.id, model);
  if (!capabilities)
    return fail(
      "model_not_verified",
      `Model "${model}" has not been verified for this connection.`,
    );

  const supplied = (input.values && typeof input.values === "object" ? input.values : {}) as Record<
    string,
    unknown
  >;
  const pick = (key: keyof TemplateValues) => {
    const value = supplied[key] ?? revision?.[key as keyof RevisionRow];
    return typeof value === "string" ? value : null;
  };
  const values: TemplateValues = {
    category: pick("category"),
    location: pick("location"),
    language: pick("language"),
  };
  const examples = Array.isArray(input.examples)
    ? input.examples
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .slice(0, 20)
    : [];
  const context = {
    kind,
    count,
    values,
    examples,
    guidance: typeof input.guidance === "string" ? input.guidance.slice(0, 500) : null,
  };

  const reasoning =
    capabilities.reasoning_efforts.length > 0 && capabilities.default_reasoning_effort !== "none";
  const maxOutput = Math.min(
    generationOutputCap(count, reasoning),
    capabilities.max_output_tokens_limit ?? Infinity,
  );
  const params: ModelParams = {};
  const request = buildGenerationRequest(context, model, params, maxOutput);

  const recorded = await ctx.admin.rpc("svc_record_generation", {
    p_workspace_id: workspaceId,
    p_actor: ctx.userId,
    p_connection_id: connection.id,
    p_campaign_id: revision?.campaign_id ?? null,
    p_kind: kind,
    p_requested_count: count,
    p_model: model,
    p_context: { values, examples, guidance: context.guidance },
  });
  if (recorded.error) return fromDbError(recorded.error);
  const generationId = recorded.data as string;

  const begun = await ctx.admin.rpc("svc_begin_adhoc", {
    p_workspace_id: workspaceId,
    p_actor: ctx.userId,
    p_connection_id: connection.id,
    p_purpose: "variation_generation",
    p_model: model,
    p_requests: [
      {
        est_input_tokens: estimateGenerationInputTokens(request),
        max_output_tokens: maxOutput,
        request_params: describeRequest(request),
      },
    ],
    p_campaign_id: revision?.campaign_id ?? null,
    p_generation_id: generationId,
  });
  if (begun.error) return fromDbError(begun.error);
  const reservation = begun.data as {
    ok: boolean;
    code?: string;
    message?: string;
    attempt_ids?: string[];
  };
  if (!reservation.ok) {
    await ctx.admin.rpc("svc_finish_generation", {
      p_generation_id: generationId,
      p_candidates: null,
      p_error: reservation.message,
    });
    return fail(reservation.code ?? "blocked", reservation.message ?? "The request was blocked.");
  }
  const attemptId = reservation.attempt_ids![0]!;

  const { data: apiKey } = await ctx.admin.rpc("svc_get_connection_secret", {
    p_connection_id: connection.id,
  });
  if (!apiKey) {
    await ctx.admin.rpc("svc_finish_adhoc", {
      p_attempt_id: attemptId,
      p_outcome: { status: "unused" },
    });
    return fail("not_configured", "No API key is stored for this connection yet.");
  }

  const outcome = await ctx
    .createProvider(apiKey as string)
    .createResponse({ ...request, client_request_id: attemptId }, { timeoutMs: 100_000 });
  await ctx.admin.rpc("svc_finish_adhoc", {
    p_attempt_id: attemptId,
    p_outcome: adhocOutcome(outcome),
  });

  if (outcome.kind !== "result") {
    const described =
      outcome.kind === "failure"
        ? describeFailure(outcome.failure)
        : { code: "timeout", message: "The provider did not finish the response." };
    await ctx.admin.rpc("svc_finish_generation", {
      p_generation_id: generationId,
      p_candidates: null,
      p_error: described.message,
    });
    return { ok: false, ...described };
  }

  const parsed = parseGeneration(
    outcome.result.output_text,
    context,
    revision ? targetOf(revision) : null,
  );
  const incomplete = outcome.result.status === "incomplete";
  await ctx.admin.rpc("svc_finish_generation", {
    p_generation_id: generationId,
    p_candidates: parsed.candidates,
    p_error: parsed.candidates.length === 0 ? "The model returned no usable variations." : null,
  });
  if (parsed.candidates.length === 0) {
    return fail(
      "no_candidates",
      incomplete
        ? "The model ran out of output tokens before producing variations. Try fewer variations."
        : "The model returned no usable variations. Try again or adjust the guidance.",
    );
  }
  return {
    ok: true,
    generation_id: generationId,
    candidates: parsed.candidates,
    rejected: parsed.rejected,
    truncated: incomplete,
    usage: outcome.result.usage,
  };
}

// ---------------------------------------------------------------------------------------------
// Optional model-based classification
// ---------------------------------------------------------------------------------------------

export async function classifyWithModel(
  ctx: OpsContext,
  input: { subject_type?: unknown; subject_id?: unknown },
): Promise<OpsResult> {
  const subjectType = input.subject_type;
  if (
    !isUuid(input.subject_id) ||
    !["run_turn", "fresh_check", "manual_check"].includes(subjectType as string)
  ) {
    return NOT_FOUND;
  }
  const subjectId = input.subject_id;

  let workspaceId: string | null = null;
  let campaignId: string | null = null;
  let text: string | null = null;
  let target: DetectionTarget | null = null;

  if (subjectType === "run_turn") {
    const { data } = await ctx.admin
      .from("run_turns")
      .select("workspace_id, campaign_id, output_text, status, runs(target)")
      .eq("id", subjectId)
      .maybeSingle();
    if (data) {
      workspaceId = data.workspace_id;
      campaignId = data.campaign_id;
      text = data.status === "completed" ? data.output_text : null;
      const run = (Array.isArray(data.runs) ? data.runs[0] : data.runs) as {
        target: DetectionTarget;
      } | null;
      target = run?.target ?? null;
    }
  } else {
    const table = subjectType === "fresh_check" ? "fresh_checks" : "manual_checks";
    const column = subjectType === "fresh_check" ? "output_text" : "response_text";
    const { data } = await ctx.admin
      .from(table)
      .select(`workspace_id, campaign_id, ${column}`)
      .eq("id", subjectId)
      .maybeSingle();
    if (data) {
      const row = data as unknown as Record<string, string | null>;
      workspaceId = row.workspace_id ?? null;
      campaignId = row.campaign_id ?? null;
      text = row[column] ?? null;
    }
  }
  if (!workspaceId || !campaignId) return NOT_FOUND;
  if (!allows(await roleIn(ctx, workspaceId), "admin")) return NOT_FOUND;
  if (!text || !text.trim()) return fail("no_answer", "There is no completed answer to classify.");

  const revision = await workingRevision(ctx, campaignId);
  if (!revision || !revision.connection_id || !revision.model) {
    return fail("model_required", "The campaign has no connection and model to classify with.");
  }
  target = target ?? targetOf(revision);
  if (!target) return fail("no_target", "The campaign has no business to look for.");
  const capabilities = await modelCapabilities(ctx, revision.connection_id, revision.model);
  if (!capabilities)
    return fail(
      "model_not_verified",
      `Model "${revision.model}" has not been verified for this connection.`,
    );

  const reasoning =
    capabilities.reasoning_efforts.length > 0 && capabilities.default_reasoning_effort !== "none";
  const maxOutput = reasoning ? 2000 : 300;
  const request = buildClassificationRequest(text, target, revision.model, {}, maxOutput);

  const begun = await ctx.admin.rpc("svc_begin_adhoc", {
    p_workspace_id: workspaceId,
    p_actor: ctx.userId,
    p_connection_id: revision.connection_id,
    p_purpose: "classification",
    p_model: revision.model,
    p_requests: [
      {
        est_input_tokens: estimateClassificationInputTokens(request),
        max_output_tokens: maxOutput,
        request_params: describeRequest(request),
      },
    ],
    p_campaign_id: campaignId,
  });
  if (begun.error) return fromDbError(begun.error);
  const reservation = begun.data as {
    ok: boolean;
    code?: string;
    message?: string;
    attempt_ids?: string[];
  };
  if (!reservation.ok)
    return fail(reservation.code ?? "blocked", reservation.message ?? "The request was blocked.");
  const attemptId = reservation.attempt_ids![0]!;

  const { data: apiKey } = await ctx.admin.rpc("svc_get_connection_secret", {
    p_connection_id: revision.connection_id,
  });
  if (!apiKey) {
    await ctx.admin.rpc("svc_finish_adhoc", {
      p_attempt_id: attemptId,
      p_outcome: { status: "unused" },
    });
    return fail("not_configured", "No API key is stored for this connection yet.");
  }
  const outcome = await ctx
    .createProvider(apiKey as string)
    .createResponse({ ...request, client_request_id: attemptId }, { timeoutMs: 60_000 });
  await ctx.admin.rpc("svc_finish_adhoc", {
    p_attempt_id: attemptId,
    p_outcome: adhocOutcome(outcome),
  });

  if (outcome.kind !== "result") {
    return outcome.kind === "failure"
      ? { ok: false, ...describeFailure(outcome.failure) }
      : fail("timeout", "The provider did not finish the response.");
  }
  const parsed = parseClassification(outcome.result.output_text);
  if (!parsed)
    return fail(
      "unreadable",
      "The model's answer could not be read as a classification. The response stays in review.",
    );

  const saved = await ctx.admin.rpc("svc_record_model_classification", {
    p_actor: ctx.userId,
    p_subject_type: subjectType,
    p_subject_id: subjectId,
    p_classification: { ...parsed, matched_spans: findMentions(text, target) },
    p_attempt_id: attemptId,
  });
  if (saved.error) return fromDbError(saved.error);
  return { ok: true, classification: parsed };
}

// ---------------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------------

/** Invites a person by email (owner only). Existing confirmed accounts are added directly. */
export async function inviteMember(
  ctx: OpsContext,
  input: { workspace_id?: unknown; email?: unknown; role?: unknown },
): Promise<OpsResult> {
  if (!isUuid(input.workspace_id)) return NOT_FOUND;
  if (!allows(await roleIn(ctx, input.workspace_id), "owner")) return NOT_FOUND;
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const role = input.role;
  if (role !== "owner" && role !== "admin" && role !== "member")
    return fail("invalid_role", "Choose a role.");

  const recorded = await ctx.admin.rpc("svc_invite_member", {
    p_workspace_id: input.workspace_id,
    p_actor: ctx.userId,
    p_email: email,
    p_role: role,
  });
  if (recorded.error) return fromDbError(recorded.error);
  const outcome = recorded.data as { outcome: string; invitation_id?: string; user_id?: string };
  if (outcome.outcome !== "invited") return { ok: true, outcome: outcome.outcome };

  // An account that exists but was never confirmed did not come through an accepted
  // invitation: its password, if it has one, was not chosen by the person being invited.
  // Replace it with one nobody knows before the invitation link can confirm the account.
  if (outcome.user_id) {
    const scrambled = await ctx.admin.auth.admin.updateUserById(outcome.user_id, {
      password: `${crypto.randomUUID()}${crypto.randomUUID()}`,
    });
    if (scrambled.error) {
      await ctx.admin.rpc("svc_cancel_invitation", {
        p_invitation_id: outcome.invitation_id,
        p_reason: scrambled.error.message,
      });
      return fail("invite_failed", "The invitation could not be prepared. Try again.");
    }
  }

  const { error } = await ctx.admin.auth.admin.inviteUserByEmail(email, {
    ...(ctx.siteUrl ? { redirectTo: `${ctx.siteUrl.replace(/\/$/, "")}/accept-invite` } : {}),
  });
  if (error) {
    await ctx.admin.rpc("svc_cancel_invitation", {
      p_invitation_id: outcome.invitation_id,
      p_reason: error.message,
    });
    return fail("invite_failed", `The invitation email could not be sent: ${error.message}`);
  }
  return { ok: true, outcome: "invited" };
}

// ---------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------

export const OPS_ACTIONS = {
  "connection.set_credential": setCredential,
  "connection.test": testConnection,
  "model.verify": verifyModel,
  "variations.generate": generateVariations,
  "classification.run": classifyWithModel,
  "members.invite": inviteMember,
} as const;

export type OpsAction = keyof typeof OPS_ACTIONS;

export async function runOpsAction(
  ctx: OpsContext,
  action: string,
  input: Record<string, unknown>,
): Promise<OpsResult> {
  // Own properties only: a plain lookup would also find what every object inherits
  // ("constructor", "toString", …) and call it as if it were a handler.
  if (!Object.hasOwn(OPS_ACTIONS, action)) return fail("unknown_action", "Unknown operation.");
  const handler = OPS_ACTIONS[action as OpsAction] as (
    ctx: OpsContext,
    input: Record<string, unknown>,
  ) => Promise<OpsResult>;
  return handler(ctx, input);
}

/** True for the only shape a handler may return; anything else must not be sent to a caller. */
export function isOpsResult(value: unknown): value is OpsResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  );
}
