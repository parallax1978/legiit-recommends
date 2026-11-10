"use client";

import { ActionButton } from "@/components/ui/action-button";
import { resolveUncertainAttempt, restartRun, retryJob } from "@/lib/actions/operations";

export function RetryJobButton({ jobId, label = "Retry" }: { jobId: string; label?: string }) {
  return (
    <ActionButton action={() => retryJob(jobId)} size="sm">
      {label}
    </ActionButton>
  );
}

export function RestartRunButton({ runId }: { runId: string }) {
  return (
    <ActionButton
      action={() => restartRun(runId)}
      size="sm"
      confirm={{
        title: "Start this conversation again?",
        description:
          "A new conversation is run from the first turn with the same prompts and settings, and it is billed as new requests. This conversation and everything recorded for it are kept.",
        confirmLabel: "Start a new conversation",
      }}
    >
      Restart as a new conversation
    </ActionButton>
  );
}

export function ResolveAttemptButtons({ attemptId }: { attemptId: string }) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <ActionButton
        action={() => resolveUncertainAttempt(attemptId, "counted_as_spent")}
        size="sm"
        confirm={{
          title: "Count this request as spent?",
          description:
            "The full reserved amount is recorded as an estimated cost. Choose this when you cannot confirm that the provider did not process the request.",
          confirmLabel: "Count as spent",
        }}
      >
        Count as spent
      </ActionButton>
      <ActionButton
        action={() => resolveUncertainAttempt(attemptId, "released")}
        size="sm"
        confirm={{
          title: "Release this reservation?",
          description:
            "The reserved amount is returned to the budgets and no cost is recorded. Choose this only if you have confirmed, for example in the provider's usage dashboard, that the request was not processed.",
          confirmLabel: "Release reservation",
        }}
      >
        Release
      </ActionButton>
    </div>
  );
}
