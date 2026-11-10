import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Link-based tabs: the active tab lives in the URL, so it survives refresh and can be shared. */
export function Tabs({
  tabs,
  active,
  label,
}: {
  tabs: { id: string; label: ReactNode; href: string; count?: number | null }[];
  active: string;
  label: string;
}) {
  return (
    <nav
      aria-label={label}
      className="border-line -mx-4 mb-6 overflow-x-auto border-b px-4 sm:mx-0 sm:px-0"
    >
      <ul className="flex min-w-max gap-1">
        {tabs.map((tab) => {
          const current = tab.id === active;
          return (
            <li key={tab.id}>
              <Link
                href={tab.href}
                aria-current={current ? "page" : undefined}
                scroll={false}
                className={cn(
                  "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium whitespace-nowrap transition-colors",
                  current
                    ? "border-brand text-brand-strong"
                    : "text-ink-muted hover:border-line-strong hover:text-ink border-transparent",
                )}
              >
                {tab.label}
                {tab.count ? (
                  <span className="tabular bg-surface-sunken text-ink-muted rounded-full px-1.5 text-[11px]">
                    {tab.count}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function buildHref(
  path: string,
  params: Record<string, string | number | null | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export function Pagination({
  page,
  pageSize,
  total,
  path,
  params,
}: {
  page: number;
  pageSize: number;
  total: number;
  path: string;
  params: Record<string, string | number | null | undefined>;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const link =
    "rounded-full border border-line-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-surface-alt";
  const off = "rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft";
  return (
    <nav
      aria-label="Pagination"
      className="text-ink-muted mt-4 flex flex-wrap items-center justify-between gap-3 text-xs"
    >
      <p className="tabular">
        {from.toLocaleString("en-US")}–{to.toLocaleString("en-US")} of{" "}
        {total.toLocaleString("en-US")}
      </p>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link className={link} href={buildHref(path, { ...params, page: page - 1 })}>
            Previous
          </Link>
        ) : (
          <span className={off} aria-disabled="true">
            Previous
          </span>
        )}
        <span className="tabular">
          Page {page} of {pages}
        </span>
        {page < pages ? (
          <Link className={link} href={buildHref(path, { ...params, page: page + 1 })}>
            Next
          </Link>
        ) : (
          <span className={off} aria-disabled="true">
            Next
          </span>
        )}
      </div>
    </nav>
  );
}

/** Label/value rows for configuration summaries. `stacked` puts each value under its label (side panels). */
export function DefinitionList({
  items,
  className,
  stacked = false,
}: {
  items: { term: ReactNode; value: ReactNode }[];
  className?: string;
  stacked?: boolean;
}) {
  if (stacked) {
    return (
      <dl className={cn("flex flex-col gap-3 text-[13px]", className)}>
        {items.map((item, index) => (
          <div key={index}>
            <dt className="text-ink-muted text-xs">{item.term}</dt>
            <dd className="text-ink mt-0.5 min-w-0 break-words">{item.value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl
      className={cn(
        "grid grid-cols-1 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]",
        className,
      )}
    >
      {items.map((item, index) => (
        <div key={index} className="contents">
          <dt className="text-ink-muted">{item.term}</dt>
          <dd className="text-ink min-w-0 break-words sm:mb-0">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Shown in place of content the viewer's role does not allow. */
export function PermissionNote({ children }: { children: ReactNode }) {
  return (
    <p
      className="border-line bg-surface-alt text-ink-muted rounded-xl border px-4 py-3 text-[13px]"
      role="note"
    >
      {children}
    </p>
  );
}

export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="bg-surface-sunken mb-6 h-7 w-56 animate-pulse rounded-lg" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="bg-surface-sunken h-24 animate-pulse rounded-2xl" />
        ))}
      </div>
      <div className="bg-surface-sunken mt-6 h-72 animate-pulse rounded-2xl" />
    </div>
  );
}

/**
 * Wraps a page's data-loading content in its own boundary. The boundary lives inside the page
 * (below every shared layout), so both direct visits and client navigations show the skeleton
 * immediately while live data streams in.
 */
export function Screen({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageSkeleton />}>{children}</Suspense>;
}
