// How the schedule fields of the campaign form become what is stored. Pure, so the cases are
// tested: the start is optional, and a length in days does not need one.

import { zonedInputToUtc } from "@/lib/timezone";

export interface ScheduleFields {
  start_local: string;
  end_mode: string;
  end_local: string;
  duration_days: string;
}

export interface StoredSchedule {
  start_at: string | null;
  end_at: string | null;
  schedule_end_mode: "duration" | "end_time";
  duration_days: number | null;
}

export const MAX_DURATION_DAYS = 1095;

/**
 * A campaign without a start time starts when it is launched. A length in days is stored as a
 * number, never as an end time worked out here: the database counts it from the start, or from
 * the launch when the start is left open, on the campaign's own clock. Problems are added to
 * `errors` under the field they belong to.
 */
export function resolveSchedule(
  input: ScheduleFields,
  zone: string | null,
  errors: Record<string, string>,
): StoredSchedule {
  const needsZone = "Choose the campaign timezone before setting times.";
  let startAt: string | null = null;
  let endAt: string | null = null;
  if (input.start_local) {
    if (!zone) errors.timezone ??= needsZone;
    else {
      const start = zonedInputToUtc(input.start_local, zone);
      if (!start) errors.start_at = "Enter a valid start date and time.";
      else startAt = start.toISOString();
    }
  }

  const endMode = input.end_mode === "end_time" ? "end_time" : "duration";
  let durationDays: number | null = null;
  if (endMode === "duration") {
    const raw = input.duration_days.trim();
    if (raw !== "") {
      const days = Number(raw);
      if (!Number.isInteger(days)) errors.end_at = "Enter a whole number.";
      else if (days < 1 || days > MAX_DURATION_DAYS)
        errors.end_at = `Enter a duration between 1 and ${MAX_DURATION_DAYS} days.`;
      else durationDays = days;
    }
  } else if (input.end_local) {
    if (!zone) errors.timezone ??= needsZone;
    else {
      const end = zonedInputToUtc(input.end_local, zone);
      if (!end) errors.end_at = "Enter a valid end date and time.";
      else endAt = end.toISOString();
    }
  }
  if (startAt && endAt && endAt <= startAt) errors.end_at = "The end must be after the start.";

  return {
    start_at: startAt,
    end_at: endAt,
    schedule_end_mode: endMode,
    duration_days: durationDays,
  };
}
