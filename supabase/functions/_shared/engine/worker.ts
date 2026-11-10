// Queue consumer: processes exactly one unit of work per call.
//
// A unit is a single conversation turn, a single fresh check, or a single status poll of a
// background response. The function is runtime-agnostic (Deno Edge Function in production, Node
// in tests) and keeps no state: everything it needs comes from the claimed unit, and everything
// it learns is written back through one transactional database call.
//
// Failure model: if this function stops at any point (crash, deploy, timeout), the queue message
// becomes visible again after its visibility timeout and another invocation resumes from the
// last committed state. A request that was already sent is then recorded as "uncertain" and its
// budget reservation is kept unresolved; nothing is ever replayed from the start of a conversation.

import { shouldRunInBackground } from "../core/capabilities.ts";
import { classifyResponse, mentionsTarget } from "../core/detection.ts";
import { estimateSingleInputTokens, estimateTurnInputTokens } from "../core/estimate.ts";
import { selectCombination } from "../core/selection.ts";
import { hasRenderingProblem, renderTemplate } from "../core/templates.ts";
import { buildFreshCheckRequest, buildTurnRequest, describeRequest } from "../provider/requests.ts";
import type {
  ProviderClient,
  ProviderFactory,
  ProviderOutcome,
  ResponsesRequest,
} from "../provider/types.ts";
import type { EngineDb, LeaseRef, RunPlan, Unit } from "./db.ts";

export interface EngineConfig {
  workerId: string;
  /** Deadline for one synchronous generation request. Must be shorter than the job lease. */
  syncTimeoutMs: number;
  /** Deadline for short calls: creating or polling a background response. */
  shortTimeoutMs: number;
  /** Background responses still running after this long are cancelled. */
  backgroundMaxMs: number;
}

export const DEFAULT_ENGINE_CONFIG: Omit<EngineConfig, "workerId"> = {
  syncTimeoutMs: 100_000,
  shortTimeoutMs: 30_000,
  backgroundMaxMs: 30 * 60_000,
};

/** Test seam: lets a test stop the worker at a precise point, as a crash would. */
export interface FaultHooks {
  afterBeginAttempt?(unit: Unit, attemptId: string): void | Promise<void>;
  afterProviderCall?(unit: Unit, attemptId: string, outcome: ProviderOutcome): void | Promise<void>;
}

export interface EngineDeps {
  db: EngineDb;
  createProvider: ProviderFactory;
  config: EngineConfig;
  log?(event: string, details: Record<string, unknown>): void;
  faults?: FaultHooks;
}

export type UnitOutcome =
  | { status: "idle" }
  | {
      status: "processed";
      job_id: string;
      kind: "turn" | "check" | "poll" | "materialize_only";
      result: string;
    };

const POLL_SCHEDULE_SECONDS = [3, 5, 10, 15, 30];

function pollDelay(pollCount: number): number {
  return POLL_SCHEDULE_SECONDS[Math.min(pollCount, POLL_SCHEDULE_SECONDS.length - 1)]!;
}

function refOf(unit: Unit): LeaseRef {
  return { job_id: unit.job_id, lease_token: unit.lease_token, fencing_token: unit.fencing_token };
}

async function providerFor(deps: EngineDeps, unit: Unit): Promise<ProviderClient | null> {
  const apiKey = await deps.db.getConnectionSecret(unit.connection_id);
  return apiKey ? deps.createProvider(apiKey) : null;
}

const MISSING_KEY_FAILURE = {
  class: "invalid_credentials" as const,
  uncertain: false,
  http_status: null,
  type: null,
  code: "missing_api_key",
  param: null,
  message: "No API key is stored for this connection.",
  retry_after_ms: null,
  provider_request_id: null,
  response_id: null,
  latency_ms: 0,
};

/** Our own backend failed before the provider was contacted. Retried like a network problem. */
const NOT_SENT_FAILURE = {
  class: "connection_error" as const,
  uncertain: false,
  http_status: null,
  type: null,
  code: "not_sent",
  param: null,
  message: "The request was not sent.",
  retry_after_ms: null,
  provider_request_id: null,
  response_id: null,
  latency_ms: 0,
};

/** Selects one saved wording per step and renders the exact prompts for a new run. */
export function planRun(unit: Unit): RunPlan {
  const run = unit.run!;
  const sequence = unit.sequence!;
  const steps = [...sequence.steps].sort((a, b) => a.step_index - b.step_index);
  if (steps.length === 0 || steps.some((step) => step.templates.length === 0)) {
    return { combination_index: null, target_in_initial_prompt: false, turns: [] };
  }
  const selection = selectCombination({
    mode: run.selection_mode,
    seed: run.selection_seed,
    ordinal: run.ordinal,
    counts: steps.map((step) => step.templates.length),
  });
  const turns = steps.map((step, index) => {
    const template = step.templates[selection.indices[index]!]!;
    return {
      step_index: step.step_index,
      step_kind: step.kind,
      template_id: template.template_id,
      template_version_id: template.template_version_id,
      rendered_prompt: renderTemplate(template.body, sequence.variables),
    };
  });
  const combinationIndex =
    selection.combinationIndex <= 9_000_000_000_000_000_000n
      ? selection.combinationIndex.toString()
      : null;
  return {
    combination_index: combinationIndex,
    // Visible in results: this run's opening question already named the business.
    target_in_initial_prompt: mentionsTarget(turns[0]?.rendered_prompt ?? "", run.target),
    turns,
  };
}

async function settle(
  deps: EngineDeps,
  unit: Unit,
  attemptId: string,
  outcome: ProviderOutcome,
  pollCount: number,
): Promise<string> {
  const ref = refOf(unit);
  if (outcome.kind === "result") {
    const target = unit.kind === "conversation" ? unit.run!.target : unit.analysis_target!;
    // Classification happens only after the answer exists, and only locally.
    const classification =
      outcome.result.status === "completed"
        ? classifyResponse(outcome.result.output_text, target)
        : null;
    const committed = await deps.db.commitResult(ref, attemptId, outcome.result, classification);
    return committed.ok
      ? `committed:${committed.next ?? "done"}`
      : `commit_rejected:${committed.action ?? "unknown"}`;
  }
  if (outcome.kind === "pending") {
    if (pollCount === 0) {
      await deps.db.attemptInFlight(ref, attemptId, outcome.pending.response_id, pollDelay(0));
    } else {
      await deps.db.pollPending(ref, attemptId, pollDelay(pollCount));
    }
    return "in_flight";
  }
  const failed = await deps.db.failAttempt(ref, attemptId, outcome.failure);
  return `failed:${outcome.failure.class}:${failed.action ?? "recorded"}`;
}

async function sendAndSettle(
  deps: EngineDeps,
  unit: Unit,
  request: Omit<ResponsesRequest, "client_request_id">,
  background: boolean,
  renderedPrompt: string | null,
  estInputTokens: number,
): Promise<string> {
  const begin = await deps.db.beginAttempt(refOf(unit), {
    mode: background ? "background" : "sync",
    est_input_tokens: estInputTokens,
    max_output_tokens: request.max_output_tokens,
    request_params: describeRequest(request),
    rendered_prompt: renderedPrompt,
  });
  if (!begin.ok) return `gate:${begin.action}${begin.reason ? `:${begin.reason}` : ""}`;

  await deps.faults?.afterBeginAttempt?.(unit, begin.attempt_id);

  let provider: ProviderClient | null;
  try {
    provider = await providerFor(deps, unit);
  } catch (error) {
    // The key could not be read, so nothing was sent. Say so: an attempt left as "started"
    // would later be treated as a request that may have been billed.
    const failed = await deps.db.failAttempt(refOf(unit), begin.attempt_id, {
      ...NOT_SENT_FAILURE,
      message: `The request was not sent: the stored API key could not be read (${String(
        error instanceof Error ? error.message : error,
      ).slice(0, 200)}).`,
    });
    return `failed:connection_error:${failed.action ?? "recorded"}`;
  }
  if (!provider) {
    const failed = await deps.db.failAttempt(refOf(unit), begin.attempt_id, MISSING_KEY_FAILURE);
    return `failed:invalid_credentials:${failed.action ?? "recorded"}`;
  }

  const outcome = await provider.createResponse(
    { ...request, client_request_id: begin.attempt_id },
    { timeoutMs: background ? deps.config.shortTimeoutMs : deps.config.syncTimeoutMs },
  );

  await deps.faults?.afterProviderCall?.(unit, begin.attempt_id, outcome);
  return settle(deps, unit, begin.attempt_id, outcome, 0);
}

async function handleTurn(deps: EngineDeps, claimed: Unit): Promise<UnitOutcome> {
  let unit = claimed;
  if (!unit.run!.materialized) {
    const materialized = await deps.db.materializeRun(refOf(unit), planRun(unit));
    if (!materialized.ok) {
      return {
        status: "processed",
        job_id: unit.job_id,
        kind: "materialize_only",
        result: `gate:${materialized.action}`,
      };
    }
    unit = { ...unit, ...materialized };
  }
  const run = unit.run!;
  const turn = unit.turn;
  if (!turn) {
    await deps.db.releaseWork(refOf(unit), 30);
    return { status: "processed", job_id: unit.job_id, kind: "turn", result: "nothing_to_do" };
  }

  const params = run.model_params ?? {};
  const background = shouldRunInBackground({
    mode: run.execution_mode ?? "auto",
    params,
    maxOutputTokens: run.max_output_tokens,
    backgroundSupported: unit.background_supported,
    previousAttemptTimedOut: unit.last_error_class === "timeout",
  });

  // Turns after the first continue the stored response chain of this run and no other.
  const request = buildTurnRequest({
    model: run.model,
    params,
    maxOutputTokens: run.max_output_tokens,
    prompt: turn.rendered_prompt,
    previousResponseId: turn.step_index > 1 ? run.last_response_id : null,
    background,
    clientRequestId: "",
  });
  const estInput = estimateTurnInputTokens(
    turn.rendered_prompt,
    turn.step_index > 1 ? (unit.previous_usage ?? null) : null,
  );
  const result = await sendAndSettle(deps, unit, request, background, null, estInput);
  return { status: "processed", job_id: unit.job_id, kind: "turn", result };
}

async function handleCheck(deps: EngineDeps, unit: Unit): Promise<UnitOutcome> {
  const check = unit.check!;
  const prompt = check.rendered_prompt ?? renderTemplate(check.question_body, check.variables);

  if (hasRenderingProblem(prompt)) {
    await deps.db.excludeCheck(refOf(unit), "question_not_renderable", prompt);
    return {
      status: "processed",
      job_id: unit.job_id,
      kind: "check",
      result: "excluded:question_not_renderable",
    };
  }
  // Guard: a fresh check must not name the target. The target is read here only to compare.
  if (unit.analysis_target && mentionsTarget(prompt, unit.analysis_target)) {
    await deps.db.excludeCheck(refOf(unit), "target_leak", prompt);
    return {
      status: "processed",
      job_id: unit.job_id,
      kind: "check",
      result: "excluded:target_leak",
    };
  }

  const params = check.params ?? {};
  const background = shouldRunInBackground({
    mode: check.execution_mode ?? "auto",
    params,
    maxOutputTokens: check.max_output_tokens,
    backgroundSupported: unit.background_supported,
    previousAttemptTimedOut: unit.last_error_class === "timeout",
  });
  const request = buildFreshCheckRequest({
    model: check.model,
    params,
    maxOutputTokens: check.max_output_tokens,
    question: prompt,
    store: check.store_response,
    background,
    clientRequestId: "",
  });
  const result = await sendAndSettle(
    deps,
    unit,
    request,
    background,
    prompt,
    estimateSingleInputTokens(prompt),
  );
  return { status: "processed", job_id: unit.job_id, kind: "check", result };
}

async function handlePoll(deps: EngineDeps, unit: Unit): Promise<UnitOutcome> {
  const poll = unit.poll!;
  const done = (result: string): UnitOutcome => ({
    status: "processed",
    job_id: unit.job_id,
    kind: "poll",
    result,
  });

  const age = Date.now() - Date.parse(poll.started_at);
  // A response whose status cannot be learned is not followed for ever. Without this, a key
  // that was revoked or removed while a response was running would keep its job polling
  // every minute indefinitely, with its budget reservation held.
  const giveUp = async (reason: string): Promise<UnitOutcome> => {
    const failed = await deps.db.failAttempt(refOf(unit), poll.attempt_id, {
      class: "timeout",
      uncertain: true,
      http_status: null,
      type: null,
      code: "background_unreachable",
      param: null,
      message: `The status of the background response could not be checked for ${Math.round(
        age / 60_000,
      )} minutes (${reason}). It may still have completed and been billed.`,
      retry_after_ms: null,
      provider_request_id: null,
      response_id: poll.response_id,
      latency_ms: age,
    });
    return done(`failed:timeout:${failed.action ?? "recorded"}`);
  };

  const provider = await providerFor(deps, unit);
  if (!provider) {
    if (age > deps.config.backgroundMaxMs) return giveUp("no API key is stored");
    await deps.db.pollPending(refOf(unit), poll.attempt_id, 60);
    return done("poll_deferred:no_credentials");
  }

  let outcome = await provider.retrieveResponse(poll.response_id, {
    timeoutMs: deps.config.shortTimeoutMs,
  });

  if (outcome.kind === "failure") {
    const { failure } = outcome;
    // The response itself is gone at the provider: its outcome can no longer be learned.
    if (failure.http_status === 404) {
      const failed = await deps.db.failAttempt(refOf(unit), poll.attempt_id, {
        ...failure,
        class: "provider_failed",
        uncertain: true,
        response_id: poll.response_id,
        message: "The background response could no longer be retrieved from the provider.",
      });
      return done(`failed:provider_failed:${failed.action ?? "recorded"}`);
    }
    // A failed status check says nothing about the response. Keep it in flight and look again,
    // but only for as long as a background response is allowed to run at all.
    if (failure.response_id === null) {
      if (age > deps.config.backgroundMaxMs) return giveUp(failure.class);
      await deps.db.pollPending(
        refOf(unit),
        poll.attempt_id,
        Math.max(pollDelay(poll.poll_count + 1), 15),
      );
      return done(`poll_deferred:${failure.class}`);
    }
  }

  if (outcome.kind === "pending") {
    if (age > deps.config.backgroundMaxMs) {
      const canceled = await provider.cancelResponse(poll.response_id, {
        timeoutMs: deps.config.shortTimeoutMs,
      });
      if (
        canceled.kind === "pending" ||
        (canceled.kind === "failure" && canceled.failure.response_id === null)
      ) {
        // Could not confirm cancellation: the response may still complete and be billed.
        const failed = await deps.db.failAttempt(refOf(unit), poll.attempt_id, {
          class: "timeout",
          uncertain: true,
          http_status: null,
          type: null,
          code: "background_timeout",
          param: null,
          message:
            "The background response did not finish in time and its cancellation could not be confirmed.",
          retry_after_ms: null,
          provider_request_id: null,
          response_id: poll.response_id,
          latency_ms: age,
        });
        return done(`failed:timeout:${failed.action ?? "recorded"}`);
      }
      outcome = canceled;
    }
  }

  const result = await settle(deps, unit, poll.attempt_id, outcome, poll.poll_count + 1);
  return done(result);
}

/** Claims and processes at most one unit. Never throws for provider problems. */
export async function processOneUnit(deps: EngineDeps): Promise<UnitOutcome> {
  const unit = await deps.db.receiveWork(deps.config.workerId);
  if (!unit) return { status: "idle" };

  let outcome: UnitOutcome;
  if (unit.poll) outcome = await handlePoll(deps, unit);
  else if (unit.kind === "conversation") outcome = await handleTurn(deps, unit);
  else outcome = await handleCheck(deps, unit);

  deps.log?.("unit_processed", {
    job_id: unit.job_id,
    job_kind: unit.job_kind,
    ...(outcome.status === "processed" ? { kind: outcome.kind, result: outcome.result } : {}),
  });
  return outcome;
}
