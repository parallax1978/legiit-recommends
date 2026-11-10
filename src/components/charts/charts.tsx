"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART_INK, formatAxisTick, formatChartValue, type ValueFormat } from "./theme";

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
}

export type ChartRow = { label: string } & Record<string, string | number | null>;

interface TooltipEntry {
  dataKey?: string | number;
  value?: unknown;
  payload?: Record<string, unknown>;
}

/** One tooltip for every series at the hovered position: the value leads, the name follows. */
function ChartTooltip({
  active,
  label,
  payload,
  series,
  format,
  showTotal,
}: {
  active?: boolean;
  label?: string | number;
  payload?: readonly TooltipEntry[];
  series: ChartSeries[];
  format: ValueFormat;
  showTotal?: boolean;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = (payload[0]?.payload ?? {}) as Record<string, unknown>;
  const entries = series
    .map((item) => ({ item, value: row[item.key], detail: row[`${item.key}_detail`] }))
    .filter((entry) => entry.value !== null && entry.value !== undefined);
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, entry) => sum + Number(entry.value ?? 0), 0);
  return (
    <div className="border-line bg-surface shadow-lift rounded-xl border px-3 py-2 text-xs">
      <p className="text-ink-muted mb-1 font-medium">{label}</p>
      <ul className="flex flex-col gap-1">
        {entries.map(({ item, value, detail }) => (
          <li key={item.key} className="flex items-center gap-2">
            <span
              className="h-0.5 w-3 shrink-0 rounded-full"
              style={{ backgroundColor: item.color }}
              aria-hidden="true"
            />
            <span className="tabular text-ink font-semibold">
              {formatChartValue(Number(value), format)}
            </span>
            <span className="text-ink-muted">
              {item.label}
              {typeof detail === "string" && detail ? ` · ${detail}` : ""}
            </span>
          </li>
        ))}
      </ul>
      {showTotal && entries.length > 1 ? (
        <p className="tabular border-line text-ink mt-1.5 border-t pt-1.5 font-semibold">
          {formatChartValue(total, format)}{" "}
          <span className="text-ink-muted font-normal">total</span>
        </p>
      ) : null}
    </div>
  );
}

const axisTick = { fontSize: 11, fill: CHART_INK.muted };

function maxOf(data: ChartRow[], series: ChartSeries[], stacked: boolean): number {
  let max = 0;
  for (const row of data) {
    const values = series.map((item) => Number(row[item.key] ?? 0));
    max = Math.max(max, stacked ? values.reduce((a, b) => a + b, 0) : Math.max(0, ...values));
  }
  return max;
}

interface SegmentProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
  payload?: Record<string, unknown>;
}

/**
 * A stacked segment: square at the baseline, a 4px rounded data-end on whichever segment ends
 * the stack, and a 2px surface gap (not a stroke) between segments.
 */
function segment(series: ChartSeries[], index: number) {
  function Segment({ x = 0, y = 0, width = 0, height = 0, fill, payload }: SegmentProps) {
    if (!(height > 0) || !(width > 0)) return <g />;
    const row = payload ?? {};
    const isEnd = series.slice(index + 1).every((later) => !(Number(row[later.key] ?? 0) > 0));
    const hasBelow = series.slice(0, index).some((earlier) => Number(row[earlier.key] ?? 0) > 0);
    const gap = hasBelow ? Math.min(2, height / 2) : 0;
    const h = height - gap;
    const r = isEnd ? Math.min(4, width / 2, h) : 0;
    const d = `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + width - r},${y} Q${x + width},${y} ${x + width},${y + r} L${x + width},${y + h} Z`;
    return <path d={d} fill={fill} />;
  }
  return Segment;
}

/** Columns over time: one series, or several stacked into a whole. */
export function TimeBarChart({
  data,
  series,
  format = "number",
  height = 240,
  ariaLabel,
}: {
  data: ChartRow[];
  series: ChartSeries[];
  format?: ValueFormat;
  height?: number;
  ariaLabel: string;
}) {
  const compact = maxOf(data, series, true) >= 10_000;
  return (
    <div role="img" aria-label={ariaLabel} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          barCategoryGap="24%"
          accessibilityLayer
        >
          <CartesianGrid vertical={false} stroke={CHART_INK.grid} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={{ stroke: CHART_INK.axis }}
            tick={axisTick}
            minTickGap={20}
            interval="preserveStartEnd"
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={axisTick}
            width={56}
            tickFormatter={(value: number) => formatAxisTick(value, format, compact)}
            allowDecimals={format !== "number"}
          />
          <Tooltip
            cursor={{ fill: "rgb(15 23 42 / 0.04)" }}
            isAnimationActive={false}
            content={<ChartTooltip series={series} format={format} showTotal />}
          />
          {series.map((item, index) => (
            <Bar
              key={item.key}
              dataKey={item.key}
              name={item.label}
              stackId="stack"
              fill={item.color}
              maxBarSize={24}
              isAnimationActive={false}
              shape={segment(series, index)}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Rates over time, in percent on one axis. Each point carries its counts in `<key>_detail` so
 * the tooltip always shows the denominator. An optional reference line marks a baseline rate.
 */
export function RateLineChart({
  data,
  series,
  height = 260,
  reference,
  ariaLabel,
}: {
  data: ChartRow[];
  series: ChartSeries[];
  height?: number;
  reference?: { value: number; label: string } | null;
  ariaLabel: string;
}) {
  return (
    <div role="img" aria-label={ariaLabel} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={{ top: 16, right: 12, bottom: 0, left: 0 }}
          accessibilityLayer
        >
          <CartesianGrid vertical={false} stroke={CHART_INK.grid} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={{ stroke: CHART_INK.axis }}
            tick={axisTick}
            minTickGap={20}
            interval="preserveStartEnd"
            padding={{ left: 12, right: 12 }}
          />
          <YAxis
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            tickLine={false}
            axisLine={false}
            tick={axisTick}
            width={44}
            tickFormatter={(value: number) => `${value}%`}
          />
          <Tooltip
            cursor={{ stroke: CHART_INK.axis, strokeWidth: 1 }}
            isAnimationActive={false}
            content={<ChartTooltip series={series} format="percent" />}
          />
          {reference ? (
            <ReferenceLine
              y={reference.value}
              stroke={CHART_INK.muted}
              strokeWidth={1}
              label={{
                value: reference.label,
                position: "insideTopRight",
                fontSize: 11,
                fill: CHART_INK.muted,
              }}
            />
          ) : null}
          {series.map((item) => (
            <Line
              key={item.key}
              type="linear"
              dataKey={item.key}
              name={item.label}
              stroke={item.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              connectNulls={false}
              isAnimationActive={false}
              dot={{ r: 4, fill: item.color, stroke: CHART_INK.surface, strokeWidth: 2 }}
              activeDot={{ r: 5, fill: item.color, stroke: CHART_INK.surface, strokeWidth: 2 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
