"use client";

import { Button } from "@/components/ui/button";
import { STALE_PAGE_MESSAGE, STALE_PAGE_TITLE, isStalePage } from "@/lib/action-failure";

/** Shown inside the app shell when a screen fails to load, so navigation stays available. */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  // A form submitted from a tab that was opened before a deployment: the server no longer has
  // that action. Only a full reload fetches the current app, so "Try again" would fail again.
  const stale = isStalePage(error);
  return (
    <div
      className="border-line-strong bg-surface flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed px-6 py-16 text-center"
      role="alert"
    >
      <h1 className="text-ink text-lg font-bold">
        {stale ? STALE_PAGE_TITLE : "This screen could not be loaded"}
      </h1>
      <p className="text-ink-muted max-w-md text-[13px]">
        {stale
          ? STALE_PAGE_MESSAGE
          : "Nothing was changed. This usually means the connection to the backend was interrupted. Check your connection and try again; if it keeps happening, an owner can look at Settings, Operational status."}
      </p>
      {error.digest ? (
        <p className="text-ink-muted font-mono text-xs">Reference: {error.digest}</p>
      ) : null}
      {stale ? (
        <Button onClick={() => window.location.reload()}>Reload the page</Button>
      ) : (
        // retry() asks the server again. reset() would only re-render the same failed answer.
        <Button onClick={() => retry()}>Try again</Button>
      )}
    </div>
  );
}
