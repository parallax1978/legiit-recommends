"use client";

import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-ink text-xl font-bold">Something went wrong</h1>
      <p className="text-ink-muted max-w-sm text-[13px]">
        The page could not be loaded. Nothing was changed. If this keeps happening, check the
        operational status in Settings.
      </p>
      {error.digest ? (
        <p className="text-ink-soft font-mono text-xs">Reference: {error.digest}</p>
      ) : null}
      <Button onClick={reset}>Try again</Button>
    </main>
  );
}
