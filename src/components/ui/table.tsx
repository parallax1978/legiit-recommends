import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** Horizontally scrollable on small screens so wide tables never break the page layout. */
export function TableWrap({
  className,
  children,
  label,
}: {
  className?: string;
  children: React.ReactNode;
  label?: string;
}) {
  return (
    <div
      className={cn(
        "border-line bg-surface shadow-card overflow-x-auto rounded-2xl border",
        className,
      )}
      role="region"
      aria-label={label}
      tabIndex={label ? 0 : undefined}
    >
      {children}
    </div>
  );
}

export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <table
      className={cn("w-full min-w-max border-collapse text-left text-[13px]", className)}
      {...props}
    />
  );
}

export function Th({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      scope="col"
      className={cn(
        "border-line bg-surface-alt text-ink-muted border-b px-4 py-2.5 text-xs font-semibold whitespace-nowrap first:pl-5 last:pr-5",
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: ComponentProps<"td">) {
  return (
    <td
      className={cn(
        "border-line text-ink border-b px-4 py-3 align-top first:pl-5 last:pr-5",
        className,
      )}
      {...props}
    />
  );
}

export function Tr({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr className={cn("hover:bg-surface-alt/60 last:[&>td]:border-b-0", className)} {...props} />
  );
}
