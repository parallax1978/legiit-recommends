// Display formatting. All numbers shown in the app go through these so tables line up and
// "no data" is never rendered as a zero or a made-up value.

export const NO_VALUE = "—";

export function formatUsd(
  value: number | string | null | undefined,
  options: { precise?: boolean } = {},
): string {
  if (value === null || value === undefined || value === "") return NO_VALUE;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return NO_VALUE;
  const small = Math.abs(amount) > 0 && Math.abs(amount) < 1;
  const digits = options.precise || small ? 4 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: amount === 0 ? 2 : Math.min(digits, 2),
    maximumFractionDigits: amount === 0 ? 2 : digits,
  }).format(amount);
}

export function formatNumber(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return NO_VALUE;
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat("en-US").format(number) : NO_VALUE;
}

export function formatCompact(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return NO_VALUE;
  const number = Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
        number,
      )
    : NO_VALUE;
}

/** A rate with its denominator. Returns null when there is nothing valid to divide by. */
export function rate(
  numerator: number | string | null | undefined,
  denominator: number | string | null | undefined,
): number | null {
  const d = Number(denominator);
  if (!Number.isFinite(d) || d <= 0) return null;
  return Number(numerator ?? 0) / d;
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  return `${(value * 100).toFixed(digits)}%`;
}

/** "12 of 40 (30%)" — always shows the valid denominator next to the rate. */
export function formatShare(numerator: number | string, denominator: number | string): string {
  const d = Number(denominator);
  if (!d) return `0 of 0`;
  return `${formatNumber(numerator)} of ${formatNumber(d)} (${formatPercent(Number(numerator) / d)})`;
}

/** Difference between two rates in percentage points, e.g. "+12.5 pp". */
export function formatPointChange(current: number | null, baseline: number | null): string {
  if (current === null || baseline === null) return NO_VALUE;
  const points = (current - baseline) * 100;
  const rounded = Math.abs(points) < 0.05 ? 0 : points;
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : "±"}${Math.abs(rounded).toFixed(1)} pp`;
}

export function formatDateTime(
  value: string | Date | null | undefined,
  timeZone?: string | null,
): string {
  if (!value) return NO_VALUE;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return NO_VALUE;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timeZone ?? "UTC",
    timeZoneName: "short",
  }).format(date);
}

export function formatDate(
  value: string | Date | null | undefined,
  timeZone?: string | null,
): string {
  if (!value) return NO_VALUE;
  // Plain calendar dates (YYYY-MM-DD) are not shifted by a timezone.
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number) as [number, number, number];
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year, month - 1, day)));
  }
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return NO_VALUE;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: timeZone ?? "UTC",
  }).format(date);
}

/** Time of day only, e.g. "3:33 AM", in the given timezone. */
export function formatClock(
  value: string | Date | null | undefined,
  timeZone?: string | null,
): string {
  if (!value) return NO_VALUE;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return NO_VALUE;
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timeZone ?? "UTC",
  }).format(date);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return NO_VALUE;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function minutesToTime(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "";
  const clamped = Math.min(Math.max(minutes, 0), 1440);
  if (clamped === 1440) return "24:00";
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

export function timeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes <= 1440 ? minutes : null;
}

export const WEEKDAYS = [
  { value: 1, short: "Mon", long: "Monday" },
  { value: 2, short: "Tue", long: "Tuesday" },
  { value: 3, short: "Wed", long: "Wednesday" },
  { value: 4, short: "Thu", long: "Thursday" },
  { value: 5, short: "Fri", long: "Friday" },
  { value: 6, short: "Sat", long: "Saturday" },
  { value: 7, short: "Sun", long: "Sunday" },
] as const;

export function describeWeekdays(days: number[] | null | undefined): string {
  if (!days || days.length === 0) return NO_VALUE;
  if (days.length === 7) return "Every day";
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.join() === "1,2,3,4,5") return "Weekdays";
  if (sorted.join() === "6,7") return "Weekends";
  return sorted.map((day) => WEEKDAYS[day - 1]?.short ?? "").join(", ");
}
