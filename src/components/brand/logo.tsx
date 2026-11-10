import { cn } from "@/lib/cn";

/**
 * Original Legiit Recommends mark: a speech bubble holding a check, on the Legiit product
 * gradient tile. `title` is omitted when the mark sits next to the wordmark.
 */
export function LogoMark({
  size = 28,
  className,
  title,
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      className={cn("shrink-0", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient
          id="lr-mark-gradient"
          x1="0"
          y1="0"
          x2="40"
          y2="40"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#8A12DC" />
          <stop offset="100%" stopColor="#1863DC" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="11" fill="url(#lr-mark-gradient)" />
      <path
        d="M12.5 10.5h15a4 4 0 0 1 4 4v8.5a4 4 0 0 1-4 4h-6.2l-5.1 4.2a.9.9 0 0 1-1.5-.7V27h-2.2a4 4 0 0 1-4-4v-8.5a4 4 0 0 1 4-4Z"
        fill="#fff"
        fillOpacity="0.96"
      />
      <path
        d="m15.4 18.9 3.3 3.3 6.1-6.4"
        fill="none"
        stroke="#8A12DC"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark({
  className,
  inverted = false,
}: {
  className?: string;
  inverted?: boolean;
}) {
  return (
    <span
      className={cn(
        "text-[15px] font-bold tracking-tight",
        inverted ? "text-white" : "text-ink",
        className,
      )}
    >
      Legiit <span className={inverted ? "text-brand-soft" : "text-brand"}>Recommends</span>
    </span>
  );
}

export function Logo({
  className,
  inverted = false,
  size = 28,
}: {
  className?: string;
  inverted?: boolean;
  size?: number;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-2", className)}
      aria-label="Legiit Recommends"
      role="img"
    >
      <LogoMark size={size} className="drop-shadow-[0_6px_12px_rgba(138,18,220,0.35)]" />
      <Wordmark inverted={inverted} />
    </span>
  );
}
