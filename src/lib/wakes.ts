/** What happened to the database's recent wake-up calls to the queue consumer. */
export interface WakeSummary {
  window_minutes: number;
  requested: number;
  accepted: number;
  rejected: number;
  failed: number;
  unanswered: number;
  last_accepted_at: string | null;
  last_problem: { at: string; status_code: number | null; error: string | null } | null;
}

export interface WakeHealth {
  ok: boolean;
  /** One line for the status table. */
  detail: string;
  /** What to do about it, when the consumer is not answering. */
  problem: string | null;
}

/**
 * Whether the queue consumer is actually being reached. "Activated" only means the address and
 * secret are stored; this looks at how the worker answered the last wake-ups.
 */
export function describeWakes(
  activated: boolean,
  wakes: WakeSummary | null | undefined,
): WakeHealth {
  if (!activated) return { ok: false, detail: "Not activated", problem: null };
  if (!wakes || wakes.requested === 0) {
    return { ok: true, detail: "Activated · no wake-ups needed recently", problem: null };
  }
  const troubled = wakes.rejected + wakes.failed + wakes.unanswered;
  if (troubled === 0) {
    return {
      ok: true,
      detail: `Activated · ${plural(wakes.accepted, "wake-up")} accepted in the last ${wakes.window_minutes} minutes`,
      problem: null,
    };
  }
  // The latest answer decides: a problem that has since cleared is history, not an alarm.
  const lastOk = wakes.last_accepted_at ? Date.parse(wakes.last_accepted_at) : null;
  const lastBad = wakes.last_problem ? Date.parse(wakes.last_problem.at) : null;
  if (lastOk !== null && (lastBad === null || lastOk > lastBad)) {
    return {
      ok: true,
      detail: `Activated · answering again (${plural(troubled, "earlier wake-up")} failed)`,
      problem: null,
    };
  }

  const code = wakes.last_problem?.status_code ?? null;
  const cause =
    code !== null
      ? `HTTP ${code}`
      : (wakes.last_problem?.error ?? (wakes.unanswered > 0 ? "no answer" : "request failed"));
  const problem =
    code === 401
      ? "The worker is rejecting the database's wake-ups: the worker secret stored in the database does not match the one the function has. Run npm run deploy:supabase for this project to install one value on both sides."
      : code === 404
        ? "The worker function was not found at the stored address. Deploy it with npm run deploy:supabase."
        : code === 503
          ? "The worker starts but cannot reach the database with its service key, so it cannot claim any work. Check the worker function's logs in the Supabase dashboard; running npm run deploy:supabase redeploys it with the project's current keys."
          : "The worker is not answering the database's wake-ups, so queued work is not being sent. Check the worker function's logs in the Supabase dashboard, then run npm run queues:activate -- --status.";
  return {
    ok: false,
    detail: `${troubled} of ${plural(wakes.requested, "wake-up")} failed (${cause})`,
    problem,
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
