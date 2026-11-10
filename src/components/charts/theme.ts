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

/** Axis ticks: full numbers below 10,000, compact above; one style per axis. */
export function formatAxisTick(value: number, format: ValueFormat, compact: boolean): string {
  if (format === "percent") return `${value}%`;
  const body = compact
    ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
        value,
      )
    : new Intl.NumberFormat("en-US", {
        maximumFractionDigits: value !== 0 && Math.abs(value) < 1 ? 3 : 2,
      }).format(value);
  return format === "usd" ? `$${body}` : body;
}
