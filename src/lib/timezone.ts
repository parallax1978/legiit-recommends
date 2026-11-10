// Converting between a wall-clock time in a campaign's timezone and a UTC instant.
// Schedules are stored in UTC; people enter and read them in the campaign's own timezone.

function partsAt(instant: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const out: Record<string, number> = {};
  for (const part of parts) if (part.type !== "literal") out[part.type] = Number(part.value);
  return out;
}

/** Minutes the zone is ahead of UTC at the given instant. */
export function offsetMinutes(instant: Date, timeZone: string): number {
  const p = partsAt(instant, timeZone);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

export function isValidTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** "2026-11-12T09:30" as wall time in `timeZone` → the UTC instant. Null when unparseable. */
export function zonedInputToUtc(local: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!match || !isValidTimeZone(timeZone)) return null;
  const [, y, mo, d, h, mi, s] = match;
  const guess = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0),
  );
  const first = offsetMinutes(new Date(guess), timeZone);
  let instant = guess - first * 60000;
  const second = offsetMinutes(new Date(instant), timeZone);
  if (second !== first) instant = guess - second * 60000;
  return new Date(instant);
}

/** A UTC instant → "YYYY-MM-DDTHH:mm" wall time in `timeZone` (the datetime-local input format). */
export function utcToZonedInput(value: string | Date | null | undefined, timeZone: string): string {
  if (!value || !isValidTimeZone(timeZone)) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  const p = partsAt(date, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month!)}-${pad(p.day!)}T${pad(p.hour!)}:${pad(p.minute!)}`;
}

export function listTimeZones(): string[] {
  const supported =
    (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.(
      "timeZone",
    ) ?? [];
  return supported.includes("UTC") ? supported : ["UTC", ...supported];
}
