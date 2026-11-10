"use client";

import { useSyncExternalStore } from "react";
import { formatDate, formatDateTime } from "@/lib/format";

const subscribe = () => () => {};
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const serverZone = () => "UTC";

/**
 * A timestamp in the viewer's own timezone. The server renders UTC and the browser swaps in the
 * local zone after hydration; the zone abbreviation is always shown so it is never ambiguous.
 * Pass `timeZone` to pin it to a campaign's timezone instead.
 */
export function LocalTime({
  value,
  timeZone,
  dateOnly = false,
}: {
  value: string | null | undefined;
  timeZone?: string | null;
  dateOnly?: boolean;
}) {
  const zone = useSyncExternalStore(subscribe, browserZone, serverZone);
  const effective = timeZone ?? zone;
  if (!value) return <span className="text-ink-muted">—</span>;
  return (
    <time dateTime={value} title={formatDateTime(value, "UTC")} suppressHydrationWarning>
      {dateOnly ? formatDate(value, effective) : formatDateTime(value, effective)}
    </time>
  );
}
