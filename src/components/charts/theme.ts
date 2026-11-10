// Chart colors. Every palette here was checked with the dataviz palette validator against the
// white card surface (#ffffff):
//
//   categorical  #8a12dc,#eb6834,#1baf7a,#2a78d6,#e87ba4   (adjacent pairs, light mode)
//     lightness band PASS · chroma floor PASS · CVD separation PASS (worst ΔE 9.2)
//     normal-vision floor PASS (worst ΔE 24.0) · contrast WARN for aqua and magenta, which is
//     why every chart ships a legend and a table view.
//   ordinal      #5b0b93,#8a12dc,#b57af0                   (--ordinal: monotone, light end 3.0:1)
//
// Colors follow the entity, never its position in the current view: a filter that removes a
// series must not repaint the others.

import { isBelowDisplay } from "@/lib/format";

export const CATEGORICAL = ["#8a12dc", "#eb6834", "#1baf7a", "#2a78d6", "#e87ba4"] as const;

/** Usage by purpose: a fixed slot per purpose. */
export const PURPOSE_COLORS: Record<string, string> = {
  conversation_turn: CATEGORICAL[0],
  fresh_check: CATEGORICAL[1],
  model_probe: CATEGORICAL[2],
  variation_generation: CATEGORICAL[3],
  classification: CATEGORICAL[4],
};

/** Inclusion outcome is an ordered scale, so it uses one hue; "needs review" sits outside it. */
export const INCLUSION_COLORS = {
  included: "#5b0b93",
  mentioned_only: "#8a12dc",
  not_mentioned: "#b57af0",
  needs_review: "#cbd5e1",
} as const;

export const CHART_INK = {
  primary: "#0f172a",
  muted: "#64748b",
  grid: "#e5e7eb",
  axis: "#cbd5e1",
  surface: "#ffffff",
  deemphasis: "#cbd5e1",
} as const;

export type ValueFormat = "usd" | "number" | "percent";

export function formatChartValue(value: number | null | undefined, format: ValueFormat): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (format === "usd") {
    if (isBelowDisplay(value)) return value < 0 ? "-<$0.0001" : "<$0.0001";
    const digits = Math.abs(value) > 0 && Math.abs(value) < 1 ? 4 : 2;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: digits,
    }).format(value);
  }
  if (format === "percent") return `${Math.round(value * 10) / 10}%`;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

/**
 * Axis ticks in one style per axis, chosen from the largest value on that axis: compact from
 * 10,000 up, and below 1 enough decimals that neighbouring ticks never read the same. A day of
 * model spend is often a fraction of a cent, which two or three decimals would print as "$0"
 * on every gridline.
 */
export function formatAxisTick(value: number, format: ValueFormat, axisMax: number): string {
  if (format === "percent") return `${value}%`;
  const max = Math.abs(axisMax);
  let body: string;
  if (max >= 10_000) {
    body = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
      value,
    );
  } else {
    body = new Intl.NumberFormat("en-US", {
      // Money below a dollar keeps its cents ("$0.30", not "$0.3"); zero stays a plain 0.
      minimumFractionDigits: format === "usd" && max < 1 && value !== 0 ? 2 : 0,
      maximumFractionDigits: axisFractionDigits(max),
    }).format(value);
  }
  return format === "usd" ? `$${body}` : body;
}

/** Decimals needed to tell the ticks of an axis apart when its largest value is `max`. */
export function axisFractionDigits(max: number): number {
  if (!(max > 0) || max >= 1) return 2;
  return Math.min(8, Math.max(2, Math.ceil(-Math.log10(max)) + 1));
}

/** Room for the tick labels of a value axis, in pixels. */
export function axisWidth(format: ValueFormat, axisMax: number): number {
  if (format === "percent") return 44;
  const max = Math.abs(axisMax);
  const digits = max >= 10_000 ? 0 : axisFractionDigits(max);
  return digits > 3 ? 56 + (digits - 3) * 7 : 56;
}
