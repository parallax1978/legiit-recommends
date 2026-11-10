// What the operator scripts conclude from public.svc_schedule_status(). Pure, so it is tested
// without a database.

export interface ScheduleJob {
  name: string;
  present: boolean;
  active: boolean;
  schedule: string | null;
}

export interface ScheduleStatus {
  jobs: ScheduleJob[];
  planner: { seconds_since_run: number | null; last_error: string | null } | null;
}

/** The planner runs every minute; allow one missed run and some slack before calling it stale. */
export const PLANNER_MAX_AGE_SECONDS = 150;

const EFFECT: Record<string, string> = {
  "lr-plan": "nothing is planned for launched campaigns",
  "lr-dispatch": "queued work is not sent to the worker",
  "lr-maintenance": "old data is not cleaned up",
};

export function describeJobs(status: ScheduleStatus): string {
  return status.jobs
    .map((job) =>
      job.present
        ? `${job.name} (${job.schedule ?? "?"}${job.active ? "" : ", PAUSED"})`
        : `${job.name} (MISSING)`,
    )
    .join(", ");
}

/**
 * Problems with the schedules themselves. A paused schedule is reported and never switched back
 * on by a script: resuming it can start paid work.
 */
export function scheduleProblems(status: ScheduleStatus): string[] {
  const problems: string[] = [];
  for (const job of status.jobs) {
    const effect = EFFECT[job.name] ?? "part of the scheduler does not run";
    if (!job.present) {
      problems.push(
        `The ${job.name} schedule does not exist, so ${effect}. ` +
          "`npm run deploy:supabase` (hosted) or `npm run queues:activate` (local) puts it back.",
      );
    } else if (!job.active) {
      problems.push(
        `The ${job.name} schedule is paused, so ${effect}. Resume it under Dashboard → ` +
          "Integrations → Cron when you want work to continue. Deploying never resumes a paused " +
          "schedule, because that can start paid work.",
      );
    }
  }
  return problems;
}

export type PlannerState =
  | { state: "fresh"; seconds: number }
  | { state: "never" }
  | { state: "stale"; seconds: number }
  | { state: "failing"; error: string };

/** Whether the every-minute planner schedule is demonstrably firing. */
export function plannerState(
  status: ScheduleStatus,
  maxAgeSeconds = PLANNER_MAX_AGE_SECONDS,
): PlannerState {
  const planner = status.planner;
  if (!planner || planner.seconds_since_run === null || planner.seconds_since_run === undefined) {
    return { state: "never" };
  }
  if (planner.seconds_since_run > maxAgeSeconds) {
    return { state: "stale", seconds: planner.seconds_since_run };
  }
  if (planner.last_error) return { state: "failing", error: planner.last_error };
  return { state: "fresh", seconds: planner.seconds_since_run };
}
