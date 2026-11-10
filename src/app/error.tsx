"use client";

import { Button } from "@/components/ui/button";
import { STALE_PAGE_MESSAGE, STALE_PAGE_TITLE, isStalePage } from "@/lib/action-failure";

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  // See the note in (app)/error.tsx: after a deployment an open tab has to be reloaded.
  const stale = isStalePage(error);
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-ink text-xl font-bold">
        {stale ? STALE_PAGE_TITLE : "Something went wrong"}
      </h1>
      <p className="text-ink-muted max-w-sm text-[13px]">
        {stale
          ? STALE_PAGE_MESSAGE
          : "The page could not be loaded. Nothing was changed. If this keeps happening, check the operational status in Settings."}
      </p>
      {error.digest ? (
        <p className="text-ink-soft font-mono text-xs">Reference: {error.digest}</p>
      ) : null}
      {stale ? (
        <Button onClick={() => window.location.reload()}>Reload the page</Button>
      ) : (
        // retry() asks the server again. reset() would only re-render the same failed answer.
        <Button onClick={() => retry()}>Try again</Button>
      )}
    </main>
  );
}
