// Shapes returned by the reporting database functions (see supabase/migrations/*functions*).

import type { Database } from "@/lib/supabase/database.types";
import type { WakeSummary } from "@/lib/wakes";

export type Tables = Database["public"]["Tables"];
export type Row<T extends keyof Tables> = Tables[T]["Row"];
export type Fn = Database["public"]["Functions"];
export type CampaignSummary = Fn["campaign_summaries"]["Returns"][number];
export type ConversationMetrics = Fn["campaign_conversation_metrics"]["Returns"][number];
export type CheckMetrics = Fn["campaign_check_metrics"]["Returns"][number];
export type UsageDailyRow = Fn["usage_daily"]["Returns"][number];
export type DailyActivityRow = Fn["campaign_daily_activity"]["Returns"][number];
export type CoverageRow = Fn["variation_coverage"]["Returns"][number];

export interface OverviewSummary {
  as_of: string;
  campaigns: {
    total: number;
    draft: number;
    scheduled: number;
    active: number;
    paused: number;
    completed: number;
  };
  conversations: { completed: number; completed_7d: number; in_progress: number };
  fresh_checks: { completed: number; completed_7d: number; valid: number; included: number };
  usage: { today_usd: number; last_7d_usd: number; last_30d_usd: number; requests_7d: number };
  attention: {
    jobs_dead: number;
    jobs_blocked: number;
    unresolved_attempts: number;
    connections_failing: number;
    connections_ready: number;
    models_verified: number;
    campaigns_paused_by_system: number;
    needs_review: number;
  };
  upcoming: {
    id: string;
    kind: string;
    scheduled_for: string;
    campaign_id: string;
    campaign_name: string;
  }[];
  daily: { day: string; cost_usd: number; requests: number }[];
}

export interface BudgetStatus {
  as_of: string;
  connections: {
    connection_id: string;
    name: string;
    daily_budget_usd: number | null;
    total_budget_usd: number | null;
    spent_today_usd: number;
    reserved_today_usd: number;
    unresolved_today_usd: number;
    spent_total_usd: number;
    open_total_usd: number;
  }[];
  campaigns: {
    campaign_id: string;
    name: string;
    status: string;
    timezone: string | null;
    daily_budget_usd: number | null;
    total_budget_usd: number | null;
    final_check_set_aside_usd: number | null;
    spent_today_usd: number;
    reserved_today_usd: number;
    spent_total_usd: number;
    open_total_usd: number;
    budget_skips: number;
    budget_blocked: number;
  }[];
}

export interface PlanPreview {
  revision_id: string;
  revision_state: string;
  days: { date: string; conversations: number; checks: number }[];
  days_listed: number;
  active_days: number;
  planned_conversations: number;
  limit_reached_on: string | null;
  steps: number | null;
  baseline_checks: number;
  scheduled_checks: number;
  final_checks: number;
  provider_requests: number | null;
  est_run_max_cost_usd: number | null;
  est_check_max_cost_usd: number | null;
  max_cost_usd: number | null;
  max_daily_cost_usd: number | null;
  final_check_set_aside_usd: number | null;
  daily_budget_usd: number | null;
  total_budget_usd: number | null;
  total_budget_shortfall: boolean;
  daily_budget_shortfall: boolean;
  conversations_within_total_budget: number | null;
  conversations_within_daily_budget: number | null;
  observed_runs: number;
  observed_avg_run_cost_usd: number | null;
  observed_estimate_usd: number | null;
  start_at: string | null;
  end_at: string | null;
  timezone: string | null;
}

export interface Problem {
  code: string;
  field: string | null;
  message: string;
}

export interface LaunchCheck {
  revision_id: string;
  problems: Problem[];
  test_problems: Problem[];
}

export interface OperationalStatus {
  as_of: string;
  scheduler: Record<
    string,
    {
      last_started_at: string | null;
      last_ok_at: string | null;
      last_error_at: string | null;
      last_error: string | null;
      seconds_since_ok: number | null;
      last_duration_ms: number | null;
    }
  >;
  consumers_activated: boolean;
  /** Absent only while the database is one migration behind the web app. */
  wakes?: WakeSummary | null;
  queue: { length: number; visible: number; oldest_message_age_seconds: number | null };
  workspace: {
    emergency_stop: boolean;
    jobs: Record<string, number>;
    stalled_leases: number;
    overdue_pending: number;
    unresolved_attempts: number;
    in_flight_requests: number;
    provider_errors_24h: Record<string, number>;
    connections: {
      id: string;
      name: string;
      status: string;
      status_code: string | null;
      status_message: string | null;
      last_tested_at: string | null;
      last_ok_at: string | null;
    }[];
    paused_campaigns: {
      id: string;
      name: string;
      pause_reason: string | null;
      pause_detail: string | null;
    }[];
    budget_exhausted: { campaign_id: string; reason: string | null }[];
  };
}

export interface MatchSpan {
  start: number;
  end: number;
  text: string;
  kind: string;
  term: string;
}
