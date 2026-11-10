"use client";

import { Button } from "@/components/ui/button";

/** Shown inside the app shell when a screen fails to load, so navigation stays available. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      className="border-line-strong bg-surface flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed px-6 py-16 text-center"
      role="alert"
    >
      <h1 className="text-ink text-lg font-bold">This screen could not be loaded</h1>
      <p className="text-ink-muted max-w-md text-[13px]">
        Nothing was changed. This usually means the connection to the backend was interrupted. Check
        your connection and try again; if it keeps happening, an owner can look at Settings,
        Operational status.
      </p>
      {error.digest ? (
        <p className="text-ink-muted font-mono text-xs">Reference: {error.digest}</p>
      ) : null}
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
