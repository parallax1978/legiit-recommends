// The standard values a draft campaign gets for settings its owner did not choose. The database
// applies them (app_private.fill_revision_defaults, on create and on every save). This module is
// what the editor needs to stay in step with that: the one value it can already work out, and
// what was stored for the fields it sent blank.

import { minutesToTime } from "@/lib/format";

/** Upper bound of the standard output cap. The same number as in fill_revision_defaults. */
export const STANDARD_OUTPUT_CAP = 2000;

/** The output cap a campaign starts with for a model verified up to `verified` tokens. */
export function standardOutputCap(verified: number): number {
  return Math.min(verified, STANDARD_OUTPUT_CAP);
}

/** The columns that have a standard value, as the database stores them. */
export interface StoredStandardValues {
  active_weekdays: number[] | null;
  active_start_minute: number | null;
  active_end_minute: number | null;
  max_concurrency: number | null;
  missed_slot_behavior: string | null;
  on_existing_inclusion: string | null;
  baseline_samples: number | null;
  daily_checks: number | null;
  final_samples: number | null;
  max_output_tokens: number | null;
}

export const STANDARD_VALUE_COLUMNS =
  "active_weekdays, active_start_minute, active_end_minute, max_concurrency, missed_slot_behavior, on_existing_inclusion, baseline_samples, daily_checks, final_samples, max_output_tokens";

/** The same fields as the editor holds them: numbers as text, minutes as HH:MM. */
export interface StandardFormValues {
  active_weekdays: number[];
  active_start: string;
  active_end: string;
  max_concurrency: string;
  missed_slot_behavior: string;
  on_existing_inclusion: string;
  baseline_samples: string;
  daily_checks: string;
  final_samples: string;
  max_output_tokens: string;
}

const numberText = (value: number | null): string => (value === null ? "" : String(value));

export function toStandardFormValues(stored: StoredStandardValues): StandardFormValues {
  return {
    active_weekdays: stored.active_weekdays ?? [],
    active_start: minutesToTime(stored.active_start_minute),
    active_end: minutesToTime(stored.active_end_minute),
    max_concurrency: numberText(stored.max_concurrency),
    missed_slot_behavior: stored.missed_slot_behavior ?? "",
    on_existing_inclusion: stored.on_existing_inclusion ?? "",
    baseline_samples: numberText(stored.baseline_samples),
    daily_checks: numberText(stored.daily_checks),
    final_samples: numberText(stored.final_samples),
    max_output_tokens: numberText(stored.max_output_tokens),
  };
}

/**
 * Copies stored values into the fields of a form that are still blank, and leaves every field
 * that holds something alone: what the person typed since the save is never replaced.
 */
export function fillBlanks<T extends object>(form: T, stored: Partial<T>): T {
  const next = { ...form };
  for (const key of Object.keys(stored) as (keyof T)[]) {
    const current = form[key];
    const value = stored[key];
    const blank = Array.isArray(current) ? current.length === 0 : current === "";
    if (blank && value !== undefined) next[key] = value;
  }
  return next;
}
