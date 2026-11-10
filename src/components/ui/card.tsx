import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("border-line bg-surface shadow-card rounded-2xl border", className)}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-3 px-5 pt-5 sm:px-6",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-ink text-[15px] font-semibold">{title}</h2>
        {description ? <p className="text-ink-muted mt-0.5 text-[13px]">{description}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-5 py-5 sm:px-6", className)} {...props} />;
}

export type Tone = "neutral" | "brand" | "good" | "warn" | "bad" | "info";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-sunken text-ink-muted",
  brand: "bg-brand-faint text-brand-strong",
  good: "bg-good-soft text-good",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  info: "bg-info-soft text-info",
};

export function Badge({
  tone = "neutral",
  className,
  dot = false,
  children,
}: {
  tone?: Tone;
  className?: string;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {dot ? <span className="size-1.5 rounded-full bg-current" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

const calloutTones: Record<Tone, string> = {
  neutral: "border-line bg-surface-alt text-ink",
  brand: "border-brand-soft bg-brand-faint text-ink",
  good: "border-green-200 bg-good-soft text-ink",
  warn: "border-amber-200 bg-warn-soft text-ink",
  bad: "border-red-200 bg-bad-soft text-ink",
  info: "border-blue-200 bg-info-soft text-ink",
};

export function Callout({
  tone = "neutral",
  title,
  children,
  action,
  className,
  role,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  role?: "alert" | "status";
}) {
  return (
    <div
      role={role}
      className={cn(
        "flex flex-wrap items-start justify-between gap-3 rounded-xl border px-4 py-3 text-[13px]",
        calloutTones[tone],
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? (
          <div className={cn("text-ink-muted", title ? "mt-0.5" : "")}>{children}</div>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "border-line-strong bg-surface flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="bg-brand-faint text-brand flex size-11 items-center justify-center rounded-full">
          {icon}
        </div>
      ) : null}
      <div>
        <p className="text-ink text-[15px] font-semibold">{title}</p>
        {description ? (
          <p className="text-ink-muted mx-auto mt-1 max-w-md text-[13px]">{description}</p>
        ) : null}
      </div>
      {action ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div>
      ) : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("bg-surface-sunken animate-pulse rounded-lg", className)}
      aria-hidden="true"
    />
  );
}

export function Stat({
  label,
  value,
  detail,
  tone,
  className,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div
      className={cn("border-line bg-surface shadow-card rounded-2xl border p-4 sm:p-5", className)}
    >
      <p className="text-ink-muted text-xs font-medium">{label}</p>
      <p
        className={cn(
          "tabular mt-1.5 text-2xl font-semibold tracking-tight",
          tone === "bad" ? "text-bad" : tone === "good" ? "text-good" : "text-ink",
        )}
      >
        {value}
      </p>
      {detail ? <p className="text-ink-muted mt-1 text-xs">{detail}</p> : null}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? <div className="text-ink-muted mb-1 text-xs">{eyebrow}</div> : null}
        <h1 className="text-ink text-[22px] leading-tight font-bold">{title}</h1>
        {description ? (
          <p className="text-ink-muted mt-1 max-w-2xl text-[13px]">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
