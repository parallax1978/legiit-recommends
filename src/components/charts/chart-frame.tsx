"use client";

import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface ChartTable {
  columns: { key: string; label: string; numeric?: boolean }[];
  rows: Record<string, string | number | null>[];
}

export interface LegendItem {
  label: string;
  color: string;
  shape?: "rect" | "line";
}

export function ChartLegend({ items }: { items: LegendItem[] }) {
  if (items.length < 2) return null;
  return (
    <ul className="text-ink-muted flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={
              item.shape === "line" ? "h-0.5 w-3.5 rounded-full" : "size-2.5 rounded-[3px]"
            }
            style={{ backgroundColor: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * The container every chart sits in: title, legend, and a table view that carries the same
 * numbers for screen readers, keyboard users and anyone who prefers the figures.
 */
export function ChartFrame({
  title,
  description,
  legend,
  table,
  children,
  className,
  empty,
}: {
  title: string;
  description?: ReactNode;
  legend?: LegendItem[];
  table: ChartTable;
  children: ReactNode;
  className?: string;
  /** When set, shown instead of the chart (no data yet). */
  empty?: ReactNode;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const id = useId();
  const toggle = (value: "chart" | "table", label: string) => (
    <button
      type="button"
      onClick={() => setView(value)}
      aria-pressed={view === value}
      className={cn(
        "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
        view === value ? "bg-surface text-ink shadow-card" : "text-ink-muted hover:text-ink",
      )}
    >
      {label}
    </button>
  );

  return (
    <figure
      className={cn("border-line bg-surface shadow-card rounded-2xl border p-5 sm:p-6", className)}
      aria-labelledby={`${id}-title`}
    >
      <figcaption className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="text-ink text-[15px] font-semibold">
            {title}
          </h2>
          {description ? <p className="text-ink-muted mt-0.5 text-[13px]">{description}</p> : null}
        </div>
        {empty ? null : (
          <div
            className="bg-surface-sunken flex shrink-0 items-center rounded-full p-0.5"
            role="group"
            aria-label={`${title}: view`}
          >
            {toggle("chart", "Chart")}
            {toggle("table", "Table")}
          </div>
        )}
      </figcaption>

      {empty ? (
        <div className="border-line-strong text-ink-muted flex min-h-40 items-center justify-center rounded-xl border border-dashed px-4 py-8 text-center text-[13px]">
          {empty}
        </div>
      ) : view === "chart" ? (
        <div className="flex flex-col gap-3">
          {legend ? <ChartLegend items={legend} /> : null}
          {children}
        </div>
      ) : (
        <div
          className="border-line max-h-80 overflow-auto rounded-xl border"
          tabIndex={0}
          role="region"
          aria-label={`${title}: data table`}
        >
          <table className="w-full min-w-max border-collapse text-left text-[13px]">
            <thead>
              <tr>
                {table.columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={cn(
                      "border-line bg-surface-alt text-ink-muted sticky top-0 border-b px-3 py-2 text-xs font-semibold",
                      column.numeric ? "text-right" : "",
                    )}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, index) => (
                <tr key={index} className="border-line border-b last:border-b-0">
                  {table.columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn(
                        "text-ink px-3 py-2",
                        column.numeric ? "tabular text-right" : "",
                      )}
                    >
                      {row[column.key] ?? "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}
