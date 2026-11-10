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
const TRANSIENT_RETRIES = 4;

function refArgs(ref: LeaseRef) {
  return {
    p_job_id: ref.job_id,
    p_lease_token: ref.lease_token,
    p_fencing_token: ref.fencing_token,
  };
}

/** Database port backed by supabase-js with a service-role (secret) key. */
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped service-role client
export function createSupabaseEngineDb(client: SupabaseClient<any, any, any>): EngineDb {
  /**
   * Every call is one database transaction. When Postgres aborts it as a deadlock victim or for
   * a serialization failure, nothing was written, so the same call is simply made again. This
   * matters most for commits: the provider request has already been paid for and its result
   * must not be dropped because of a transient lock conflict.
   */
  async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      const { data, error } = await client.rpc(fn, args);
      if (!error) return data as T;
      const transient = error.code === "40P01" || error.code === "40001";
      if (!transient || attempt >= TRANSIENT_RETRIES) {
        throw new DatabaseError(fn, error.message, error.code);
      }
      await new Promise((resolve) => setTimeout(resolve, 40 * attempt + Math.random() * 80));
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
      await rpc("svc_exclude_check", {
        ...refArgs(ref),
        p_reason: reason,
        p_rendered_prompt: renderedPrompt,
      });
    },

    async attemptInFlight(ref, attemptId, responseId, pollInSeconds) {
      await rpc("svc_attempt_in_flight", {
        ...refArgs(ref),
        p_attempt_id: attemptId,
        p_response_id: responseId,
        p_poll_in_seconds: pollInSeconds,
      });
    },

    async pollPending(ref, attemptId, pollInSeconds) {
      await rpc("svc_poll_pending", {
        ...refArgs(ref),
        p_attempt_id: attemptId,
        p_poll_in_seconds: pollInSeconds,
      });
    },

    commitResult: (ref, attemptId, result, classification) => {
      // The echo of effective settings is only needed by model verification.
      const { echo: _echo, ...stored } = result;
      return rpc<CommitResult>("svc_commit_result", {
        ...refArgs(ref),
        p_attempt_id: attemptId,
        p_result: stored,
        p_classification: classification,
      });
    },

    failAttempt: (ref, attemptId, failure) =>
      rpc<FailResult>("svc_fail_attempt", {
        ...refArgs(ref),
        p_attempt_id: attemptId,
        p_error: failure,
      }),

    async releaseWork(ref, delaySeconds) {
      await rpc("svc_release_work", { ...refArgs(ref), p_delay_seconds: delaySeconds });
    },

    getConnectionSecret: (connectionId) =>
      rpc<string | null>("svc_get_connection_secret", { p_connection_id: connectionId }),

    async tick(plan) {
      await rpc("svc_tick", { p_plan: plan });
    },
  };
}
