// Human-readable labels and tones for every stored status. Screens never print raw enum values.

import type { Tone } from "@/components/ui/card";

export interface StatusLabel {
  label: string;
  tone: Tone;
  /** One sentence explaining the state, shown as a tooltip or helper text. */
  hint?: string;
}

const UNKNOWN: StatusLabel = { label: "Unknown", tone: "neutral" };

function lookup(map: Record<string, StatusLabel>, key: string | null | undefined): StatusLabel {
  return (key && map[key]) || { ...UNKNOWN, label: key ? humanize(key) : UNKNOWN.label };
}

export function humanize(value: string): string {
  const text = value.replace(/[_-]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const CAMPAIGN: Record<string, StatusLabel> = {
  draft: {
    label: "Draft",
    tone: "neutral",
    hint: "Not launched. Nothing is sent to the provider.",
  },
  scheduled: { label: "Scheduled", tone: "info", hint: "Launched and waiting for its start time." },
  baseline: {
    label: "Baseline checks",
    tone: "brand",
    hint: "Collecting baseline fresh checks before conversations start.",
  },
  running: { label: "Running", tone: "good", hint: "Conversations are being run on schedule." },
  paused: {
    label: "Paused",
    tone: "warn",
    hint: "No new work is dispatched until the campaign is resumed.",
  },
  finalizing: {
    label: "Final checks",
    tone: "brand",
    hint: "Conversations have ended. Final fresh checks are being collected.",
  },
  completed: { label: "Completed", tone: "neutral", hint: "All scheduled work has finished." },
  canceled: {
    label: "Canceled",
    tone: "bad",
    hint: "Stopped by a person. No further work will run.",
  },
};
export const campaignStatus = (status: string | null | undefined) => lookup(CAMPAIGN, status);

export const CAMPAIGN_STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "scheduled", label: "Scheduled" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
  { value: "canceled", label: "Canceled" },
  { value: "archived", label: "Archived" },
];

const PAUSE_REASON: Record<string, string> = {
  user: "Paused by a person.",
  configuration: "Paused automatically: the provider rejected the campaign's configuration.",
  model_unavailable:
    "Paused automatically: the selected model is not available to this connection.",
};
export function pauseReason(reason: string | null | undefined): string {
  return (
    (reason && PAUSE_REASON[reason]) ||
    (reason ? `Paused: ${humanize(reason).toLowerCase()}.` : "Paused.")
  );
}

const RUN: Record<string, StatusLabel> = {
  pending: { label: "Queued", tone: "neutral" },
  in_progress: { label: "In progress", tone: "info" },
  completed: { label: "Completed", tone: "good" },
  completed_early: {
    label: "Finished early",
    tone: "good",
    hint: "The business already appeared in the first answer and the campaign is set to finish early.",
  },
  incomplete: {
    label: "Incomplete",
    tone: "warn",
    hint: "A response was cut off before it finished.",
  },
  failed: { label: "Failed", tone: "bad" },
  canceled: { label: "Canceled", tone: "neutral" },
  expired: {
    label: "Expired",
    tone: "warn",
    hint: "The provider no longer has the stored conversation, so it cannot be continued.",
  },
  unresolved: {
    label: "Unresolved",
    tone: "warn",
    hint: "A request may or may not have been processed by the provider.",
  },
};
export const runStatus = (status: string | null | undefined) => lookup(RUN, status);

const TURN: Record<string, StatusLabel> = {
  pending: { label: "Not sent", tone: "neutral" },
  in_flight: { label: "Waiting for response", tone: "info" },
  completed: { label: "Completed", tone: "good" },
  incomplete: { label: "Incomplete", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
  uncertain: {
    label: "Uncertain",
    tone: "warn",
    hint: "The request timed out or the connection dropped. The provider may still have processed it.",
  },
  canceled: { label: "Canceled", tone: "neutral" },
  skipped: { label: "Skipped", tone: "neutral" },
  excluded: { label: "Excluded", tone: "neutral" },
};
export const turnStatus = (status: string | null | undefined) => lookup(TURN, status);
export const checkStatus = turnStatus;

const JOB: Record<string, StatusLabel> = {
  pending: { label: "Scheduled", tone: "neutral" },
  queued: { label: "Queued", tone: "info" },
  running: { label: "Running", tone: "info" },
  waiting: { label: "Waiting to retry", tone: "warn" },
  paused: { label: "Paused", tone: "warn" },
  blocked: { label: "Blocked", tone: "bad" },
  succeeded: { label: "Done", tone: "good" },
  dead: {
    label: "Needs review",
    tone: "bad",
    hint: "Stopped after repeated or permanent failures. An admin can retry it.",
  },
  canceled: { label: "Canceled", tone: "neutral" },
  skipped: { label: "Skipped", tone: "neutral" },
};
export const jobStatus = (status: string | null | undefined) => lookup(JOB, status);

const JOB_KIND: Record<string, string> = {
  conversation: "Conversation",
  test_conversation: "Test conversation",
  check_baseline: "Baseline fresh check",
  check_daily: "Scheduled fresh check",
  check_final: "Final fresh check",
};
export const jobKind = (kind: string | null | undefined) =>
  (kind && JOB_KIND[kind]) || humanize(kind ?? "job");

const REASON: Record<string, string> = {
  missed_slot: "The scheduled time passed before it could start.",
  campaign_paused: "The campaign is paused.",
  emergency_stop: "The workspace emergency stop is on.",
  superseded_by_revision: "Replaced when campaign changes were applied.",
  requeued_after_lost_message: "Re-queued after its queue message was lost.",
  campaign_daily_budget_exhausted: "The campaign's daily budget is used up.",
  campaign_total_budget_exhausted: "The campaign's total budget is used up.",
  connection_daily_budget_exhausted: "The connection's daily spending limit is used up.",
  connection_total_budget_exhausted: "The connection's total spending limit is used up.",
  connection_daily_cap_missing: "The connection has no daily spending limit.",
  connection_not_ready: "The connection is not ready.",
  connection_invalid_credentials: "OpenAI rejected the connection's API key.",
  connection_quota_exhausted: "The OpenAI account has no available quota.",
  price_missing: "No price is recorded for the model.",
  campaign_canceled: "The campaign was canceled.",
  campaign_ended: "The campaign ended.",
};
export function reasonText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return REASON[reason] ?? ERROR_CLASS[reason] ?? `${humanize(reason)}.`;
}

const ERROR_CLASS: Record<string, string> = {
  rate_limited: "Rate limited by the provider.",
  server_error: "The provider reported a temporary error.",
  connection_error: "The provider could not be reached.",
  timeout: "The provider did not answer in time.",
  provider_failed: "The provider reported that the response failed.",
  quota_exhausted: "The provider account has no available quota or reached a spend limit.",
  invalid_credentials: "The provider rejected the API key.",
  model_unavailable: "The model is not available to this connection.",
  permission_denied: "The provider denied access for this key.",
  invalid_request: "The provider rejected the request.",
  chain_expired: "The stored conversation state has expired at the provider.",
  canceled: "Canceled.",
  unknown: "Unclassified error.",
};
export const errorClass = (value: string | null | undefined) =>
  (value && ERROR_CLASS[value]) || (value ? `${humanize(value)}.` : null);

const ATTEMPT: Record<string, StatusLabel> = {
  started: { label: "Sending", tone: "info" },
  in_flight: { label: "Waiting for response", tone: "info" },
  succeeded: { label: "Succeeded", tone: "good" },
  incomplete: { label: "Incomplete", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
  uncertain: { label: "Uncertain", tone: "warn" },
  canceled: { label: "Canceled", tone: "neutral" },
};
export const attemptStatus = (status: string | null | undefined) => lookup(ATTEMPT, status);

const CONNECTION: Record<string, StatusLabel> = {
  not_configured: { label: "No API key", tone: "neutral" },
  ok: { label: "Connected", tone: "good" },
  error: { label: "Needs attention", tone: "bad" },
};
export const connectionStatus = (status: string | null | undefined) => lookup(CONNECTION, status);

export const INCLUSION_OPTIONS = [
  { value: "included", label: "Included in the list" },
  { value: "mentioned_only", label: "Mentioned, not in the list" },
  { value: "not_mentioned", label: "Not mentioned" },
  { value: "ambiguous", label: "Needs review" },
] as const;

const INCLUSION: Record<string, StatusLabel> = {
  included: {
    label: "Included",
    tone: "good",
    hint: "The business appears as an item in the recommendation list.",
  },
  mentioned_only: {
    label: "Mentioned only",
    tone: "info",
    hint: "The business is named, but not as an item in the list.",
  },
  not_mentioned: { label: "Not mentioned", tone: "neutral" },
  ambiguous: {
    label: "Needs review",
    tone: "warn",
    hint: "The rules could not decide. It is not counted until a person reviews it.",
  },
};
export const inclusionStatus = (value: string | null | undefined) => lookup(INCLUSION, value);

const PURPOSE: Record<string, string> = {
  conversation_turn: "Conversation turns",
  fresh_check: "Fresh checks",
  model_probe: "Model verification",
  variation_generation: "Variation generation",
  classification: "Model classification",
};
export const purposeLabel = (purpose: string | null | undefined) =>
  (purpose && PURPOSE[purpose]) || humanize(purpose ?? "other");
export const PURPOSES = Object.keys(PURPOSE);

const PHASE: Record<string, string> = { baseline: "Baseline", daily: "Scheduled", final: "Final" };
export const phaseLabel = (phase: string | null | undefined) =>
  (phase && PHASE[phase]) || humanize(phase ?? "");

const KIND: Record<string, { label: string; plural: string; help: string }> = {
  initial_question: {
    label: "Initial question",
    plural: "Initial questions",
    help: "Opens the conversation by asking for recommendations.",
  },
  inclusion_request: {
    label: "Inclusion request",
    plural: "Inclusion requests",
    help: "Asks the model to consider the business.",
  },
  revision_request: {
    label: "Revised-list request",
    plural: "Revised-list requests",
    help: "Asks for the updated list.",
  },
  extra_step: {
    label: "Additional message",
    plural: "Additional messages",
    help: "Optional further user messages after the third turn.",
  },
  fresh_check: {
    label: "Fresh-check question",
    plural: "Fresh-check questions",
    help: "Asked on its own, with no conversation history.",
  },
};
export const templateKind = (kind: string | null | undefined) =>
  (kind && KIND[kind]) || { label: humanize(kind ?? ""), plural: humanize(kind ?? ""), help: "" };
export const CONVERSATION_KINDS = [
  "initial_question",
  "inclusion_request",
  "revision_request",
  "extra_step",
] as const;

const DATA_SHARING: Record<string, StatusLabel> = {
  enabled: { label: "Enabled", tone: "warn" },
  disabled: { label: "Disabled", tone: "good" },
  unknown: { label: "Unknown", tone: "neutral" },
};
export const dataSharing = (value: string | null | undefined) => lookup(DATA_SHARING, value);
