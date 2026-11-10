import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { formatNumber, formatPercent } from "@/lib/format";
import { INCLUSION_COLORS } from "./theme";

/**
 * One ratio against a limit. The fill carries severity and the track is a lighter step of the
 * same ramp, so the state reads across the whole bar. The figures are always printed beside it.
 */
export function Meter({
  value,
  max,
  label,
  className,
  warnAt = 0.8,
}: {
  value: number;
  max: number | null;
  /** Accessible name, e.g. "Daily budget used". */
  label: string;
  className?: string;
  warnAt?: number;
}) {
  if (max === null || !(max > 0)) {
    return (
      <div
        className={cn("bg-surface-sunken h-2 rounded-full", className)}
        role="img"
        aria-label={`${label}: no limit set`}
      />
    );
  }
  const ratio = value / max;
  const level = ratio >= 1 ? "over" : ratio >= warnAt ? "near" : "ok";
  const track = { ok: "bg-brand-faint", near: "bg-warn-soft", over: "bg-bad-soft" }[level];
  const fill = { ok: "bg-brand", near: "bg-amber-500", over: "bg-bad" }[level];
  return (
    <div
      className={cn("h-2 overflow-hidden rounded-full", track, className)}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
      aria-valuetext={`${formatPercent(ratio)} used`}
    >
      <div
        className={cn("h-full rounded-full", fill)}
        style={{ width: `${Math.min(Math.max(ratio, 0), 1) * 100}%` }}
      />
    </div>
  );
}

export interface InclusionCounts {
  included: number;
  mentioned_only: number;
  not_mentioned: number;
  needs_review: number;
}

const PARTS: { key: keyof InclusionCounts; label: string }[] = [
  { key: "included", label: "Included" },
  { key: "mentioned_only", label: "Mentioned only" },
  { key: "not_mentioned", label: "Not mentioned" },
  { key: "needs_review", label: "Needs review" },
];

/** Thin segmented bar showing how classified responses split. Used beside the figures. */
export function InclusionBar({
  counts,
  className,
}: {
  counts: InclusionCounts;
  className?: string;
}) {
  const total = PARTS.reduce((sum, part) => sum + counts[part.key], 0);
  const name =
    total === 0
      ? "No classified responses"
      : PARTS.filter((part) => counts[part.key] > 0)
          .map((part) => `${part.label} ${formatNumber(counts[part.key])}`)
          .join(", ");
  return (
    <div
      className={cn(
        "flex h-2 w-full gap-0.5 overflow-hidden rounded-full",
        total === 0 ? "bg-surface-sunken" : "",
        className,
      )}
      role="img"
      aria-label={name}
      title={name}
    >
      {total > 0
        ? PARTS.filter((part) => counts[part.key] > 0).map((part) => (
            <span
              key={part.key}
              className="h-full rounded-full"
              style={{
                flexGrow: counts[part.key],
                flexBasis: 0,
                minWidth: 3,
                backgroundColor: INCLUSION_COLORS[part.key],
              }}
            />
          ))
        : null}
    </div>
  );
}

export function InclusionLegend({ className }: { className?: string }) {
  return (
    <ul className={cn("text-ink-muted flex flex-wrap gap-x-4 gap-y-1 text-xs", className)}>
      {PARTS.map((part) => (
        <li key={part.key} className="flex items-center gap-1.5">
          <span
            className="size-2.5 rounded-[3px]"
            style={{ backgroundColor: INCLUSION_COLORS[part.key] }}
            aria-hidden="true"
          />
          {part.label}
        </li>
      ))}
    </ul>
  );
}

/** A named ratio with its bar and its figures: rows of these form a meter list. */
export function RateRow({
  label,
  hint,
  included,
  valid,
  extra,
}: {
  label: ReactNode;
  hint?: ReactNode;
  included: number;
  valid: number;
  extra?: ReactNode;
}) {
  const ratio = valid > 0 ? included / valid : null;
  return (
    <div className="grid grid-cols-1 items-center gap-x-4 gap-y-1.5 py-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,11rem)]">
      <div className="min-w-0">
        <p className="text-ink text-[13px] font-medium">{label}</p>
        {hint ? <p className="text-ink-muted text-xs">{hint}</p> : null}
      </div>
      <div
        className="bg-brand-faint h-2 overflow-hidden rounded-full"
        role="img"
        aria-label={ratio === null ? "No valid responses yet" : `${formatPercent(ratio)} included`}
      >
        {ratio !== null ? (
          <div className="bg-brand h-full rounded-full" style={{ width: `${ratio * 100}%` }} />
        ) : null}
      </div>
      <div className="text-[13px] sm:text-right">
        {ratio === null ? (
          <span className="text-ink-muted">No valid responses yet</span>
        ) : (
          <>
            <span className="tabular text-ink font-semibold">{formatPercent(ratio, 1)}</span>{" "}
            <span className="tabular text-ink-muted">
              ({formatNumber(included)} of {formatNumber(valid)})
            </span>
          </>
        )}
        {extra ? <div className="text-ink-muted text-xs">{extra}</div> : null}
      </div>
    </div>
  );
}
