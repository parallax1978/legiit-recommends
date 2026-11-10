// The worker's view of the database: a small port over the svc_* SQL functions.
//
// Each call is one transaction in Postgres. All durable state, leases, budget reservations and
// queue operations live behind these functions; the worker itself keeps nothing between calls.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExecutionMode, ModelParams } from "../core/capabilities.ts";
import type { Classification, DetectionTarget } from "../core/detection.ts";
import type { PreviousUsage } from "../core/estimate.ts";
import type { SelectionMode } from "../core/selection.ts";
import type { TemplateKind, TemplateValues } from "../core/templates.ts";
import type { ProviderFailure, ProviderResult } from "../provider/types.ts";

/** Identifies a claimed job. Every state change presents it; a stale holder is turned away. */
export interface LeaseRef {
  job_id: string;
  lease_token: string;
  fencing_token: number;
}

export interface PollInfo {
  attempt_id: string;
  response_id: string;
  poll_count: number;
  started_at: string;
}

export interface UnitRun {
  id: string;
  kind: "scheduled" | "test";
  ordinal: number;
  status: string;
  model: string;
  model_params: ModelParams | null;
  max_output_tokens: number;
  execution_mode: ExecutionMode | null;
  on_existing_inclusion: "continue" | "finish_early";
  target: DetectionTarget;
  selection_mode: SelectionMode;
  selection_seed: string;
  steps_total: number | null;
  steps_completed: number;
  last_response_id: string | null;
  last_response_at: string | null;
  materialized: boolean;
}

export interface UnitTurn {
  id: string;
  step_index: number;
  step_kind: TemplateKind;
  rendered_prompt: string;
  attempt_count: number;
  status: string;
}

export interface UnitSequence {
  variables: TemplateValues;
  steps: {
    step_index: number;
    kind: TemplateKind;
    templates: { template_id: string; template_version_id: string; body: string }[];
  }[];
}

export interface UnitCheck {
  id: string;
  phase: "baseline" | "daily" | "final";
  status: string;
  question_body: string;
  /** Non-identifying variables only (category, location, language). */
  variables: TemplateValues;
  rendered_prompt: string | null;
  model: string;
  params: ModelParams | null;
  max_output_tokens: number;
  execution_mode: ExecutionMode | null;
  store_response: boolean;
  attempt_count: number;
}

export interface Unit extends LeaseRef {
  msg_id: number;
  kind: "conversation" | "check";
  job_kind: string;
  workspace_id: string;
  campaign_id: string;
  connection_id: string;
  lease_expires_at: string;
  attempts: number;
  max_attempts: number;
  last_error_class: string | null;
  background_supported: boolean;
  poll: PollInfo | null;
  run?: UnitRun;
  turn?: UnitTurn | null;
  previous_usage?: PreviousUsage | null;
  sequence?: UnitSequence;
  check?: UnitCheck;
  /** Local-only: used to guard and classify fresh checks. Never sent to the provider. */
  analysis_target?: DetectionTarget;
}

export interface RunPlan {
  combination_index: string | null;
  target_in_initial_prompt: boolean;
  turns: {
    step_index: number;
    step_kind: TemplateKind;
    template_id: string;
    template_version_id: string;
    rendered_prompt: string;
  }[];
}

export type GateAction =
  "stale" | "paused" | "canceled" | "blocked" | "deferred" | "skipped" | "dead";

export type BeginAttemptResult =
  | {
      ok: true;
      attempt_id: string;
      attempt_number: number;
      reserved_usd: number;
      previous_response_id: string | null;
    }
  | { ok: false; action: GateAction; reason?: string };

export type MaterializeResult =
  ({ ok: true } & Unit) | { ok: false; action: GateAction; reason?: string };

export interface CommitResult {
  ok: boolean;
  action?: string;
  next?: "continue" | "done" | "paused" | "canceled";
  cost_usd?: number;
}

export interface FailResult {
  ok: boolean;
  action?: "retry" | "dead" | "blocked" | "canceled" | "stale" | "unknown_attempt";
  delay_seconds?: number;
  attempts?: number;
}

export interface BeginAttemptArgs {
  mode: "sync" | "background";
  est_input_tokens: number;
  max_output_tokens: number;
  request_params: Record<string, unknown>;
  rendered_prompt?: string | null;
}

export interface EngineDb {
  receiveWork(workerId: string): Promise<Unit | null>;
  materializeRun(ref: LeaseRef, plan: RunPlan): Promise<MaterializeResult>;
  beginAttempt(ref: LeaseRef, args: BeginAttemptArgs): Promise<BeginAttemptResult>;
  excludeCheck(ref: LeaseRef, reason: string, renderedPrompt: string | null): Promise<void>;
  attemptInFlight(
    ref: LeaseRef,
    attemptId: string,
    responseId: string,
    pollInSeconds: number,
  ): Promise<void>;
  pollPending(ref: LeaseRef, attemptId: string, pollInSeconds: number): Promise<void>;
  commitResult(
    ref: LeaseRef,
    attemptId: string,
    result: ProviderResult,
    classification: Classification | null,
  ): Promise<CommitResult>;
  failAttempt(ref: LeaseRef, attemptId: string, failure: ProviderFailure): Promise<FailResult>;
  releaseWork(ref: LeaseRef, delaySeconds: number): Promise<void>;
  getConnectionSecret(connectionId: string): Promise<string | null>;
  /** One dispatcher pass (and optionally a planner pass). Wakes workers for whatever is ready. */
  tick(plan: boolean): Promise<void>;
}

export class DatabaseError extends Error {
  constructor(
    public readonly fn: string,
    message: string,
    public readonly code?: string,
  ) {
    super(`${fn}: ${message}`);
    this.name = "DatabaseError";
  }
}

/** How many times a call aborted by a deadlock or serialization failure is made in total. */
const CONFLICT_ATTEMPTS = 4;

/**
 * Waits between repeats of a call whose outcome is unknown, about forty seconds in all. That is
 * long enough to ride out a gateway restart and well inside the lease a worker holds on its job.
 */
const UNKNOWN_OUTCOME_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 8000, 8000, 8000];

/** Postgres says nothing was written: the transaction was a deadlock victim or could not serialize. */
const CONFLICT_CODES = new Set(["40P01", "40001"]);

/**
 * The call may or may not have run: the gateway or the connection failed, the database was
 * restarting or out of connections, or the statement was cut short.
 */
const UNKNOWN_OUTCOME_CODES = new Set([
  "PGRST000",
  "PGRST001",
  "PGRST002",
  "PGRST003",
  "57014",
  "57P01",
  "57P03",
  "53300",
  "08000",
  "08003",
  "08006",
]);

/**
 * How a failed call may be repeated.
 *   "conflict": only when Postgres reports that nothing was written. For calls that must not
 *     run twice: claiming a job, reserving budget for a new attempt.
 *   "safe": also when the outcome is unknown. For calls that end in the same state however
 *     often they run: recording a result or a failure is keyed to the attempt, and the calls
 *     that hand a job back are refused once the lease has been given up.
 */
type RetryPolicy = "conflict" | "safe";

export function isUnknownOutcome(error: { code?: string; message?: string }, status: number) {
  if (status === 0 || status === 408 || (status >= 502 && status <= 504)) return true;
  if (error.code) return UNKNOWN_OUTCOME_CODES.has(error.code);
  // A 5xx that carries no database or API error code did not come from the database (a proxy's
  // 500, 520 to 524, 530): it says nothing about whether the call was carried out.
  if (status >= 500) return true;
  return /fetch failed|network|timed? ?out|connection (reset|refused|closed)|socket/i.test(
    error.message ?? "",
  );
}

function refArgs(ref: LeaseRef) {
  return {
    p_job_id: ref.job_id,
    p_lease_token: ref.lease_token,
    p_fencing_token: ref.fencing_token,
  };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Database port backed by supabase-js with a service-role (secret) key. */
export function createSupabaseEngineDb(
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service-role client
  client: SupabaseClient<any, any, any>,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): EngineDb {
  const sleep = options.sleep ?? defaultSleep;

  /**
   * Every call is one database transaction, reached through the API gateway.
   *
   * A deadlock victim or serialization failure wrote nothing, so any call is simply made again.
   * A gateway error, dropped connection or timeout leaves the outcome unknown; calls marked
   * "safe" are repeated then as well. That matters most once the provider has answered: the
   * request is already paid for, and one bad second between the function and the database must
   * not turn its answer into a request "with an unknown outcome".
   */
  async function rpc<T>(
    fn: string,
    args: Record<string, unknown>,
    policy: RetryPolicy = "conflict",
  ): Promise<T> {
    let conflicts = 0;
    let unknown = 0;
    for (;;) {
      const { data, error, status } = await client.rpc(fn, args);
      if (!error) return data as T;
      if (CONFLICT_CODES.has(error.code ?? "") && conflicts < CONFLICT_ATTEMPTS - 1) {
        conflicts += 1;
        await sleep(40 * conflicts + Math.random() * 80);
        continue;
      }
      if (
        policy === "safe" &&
        isUnknownOutcome(error, status ?? 0) &&
        unknown < UNKNOWN_OUTCOME_DELAYS_MS.length
      ) {
        await sleep(UNKNOWN_OUTCOME_DELAYS_MS[unknown]!);
        unknown += 1;
        continue;
      }
      throw new DatabaseError(fn, error.message, error.code);
    }
  }

  return {
    receiveWork: (workerId) => rpc<Unit | null>("svc_receive_work", { p_worker_id: workerId }),

    materializeRun: (ref, plan) =>
      rpc<MaterializeResult>("svc_materialize_run", { ...refArgs(ref), p_plan: plan }),

    beginAttempt: (ref, args) =>
      rpc<BeginAttemptResult>("svc_begin_attempt", {
        ...refArgs(ref),
        p_mode: args.mode,
        p_est_input_tokens: args.est_input_tokens,
        p_max_output_tokens: args.max_output_tokens,
        p_request_params: args.request_params,
        p_rendered_prompt: args.rendered_prompt ?? null,
      }),

    async excludeCheck(ref, reason, renderedPrompt) {
      await rpc(
        "svc_exclude_check",
        { ...refArgs(ref), p_reason: reason, p_rendered_prompt: renderedPrompt },
        "safe",
      );
    },

    async attemptInFlight(ref, attemptId, responseId, pollInSeconds) {
      await rpc(
        "svc_attempt_in_flight",
        {
          ...refArgs(ref),
          p_attempt_id: attemptId,
          p_response_id: responseId,
          p_poll_in_seconds: pollInSeconds,
        },
        "safe",
      );
    },

    async pollPending(ref, attemptId, pollInSeconds) {
      await rpc(
        "svc_poll_pending",
        { ...refArgs(ref), p_attempt_id: attemptId, p_poll_in_seconds: pollInSeconds },
        "safe",
      );
    },

    commitResult: (ref, attemptId, result, classification) => {
      // The echo of effective settings is only needed by model verification.
      const { echo: _echo, ...stored } = result;
      return rpc<CommitResult>(
        "svc_commit_result",
        {
          ...refArgs(ref),
          p_attempt_id: attemptId,
          p_result: stored,
          p_classification: classification,
        },
        "safe",
      );
    },

    failAttempt: (ref, attemptId, failure) =>
      rpc<FailResult>(
        "svc_fail_attempt",
        { ...refArgs(ref), p_attempt_id: attemptId, p_error: failure },
        "safe",
      ),

    async releaseWork(ref, delaySeconds) {
      await rpc("svc_release_work", { ...refArgs(ref), p_delay_seconds: delaySeconds }, "safe");
    },

    getConnectionSecret: (connectionId) =>
      rpc<string | null>("svc_get_connection_secret", { p_connection_id: connectionId }, "safe"),

    async tick(plan) {
      await rpc("svc_tick", { p_plan: plan }, "safe");
    },
  };
}
