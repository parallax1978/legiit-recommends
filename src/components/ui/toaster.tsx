"use client";

import { Toaster as Sonner } from "sonner";

export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: "!rounded-xl !border !border-line !bg-surface !text-ink !shadow-lift !text-[13px]",
          description: "!text-ink-muted",
          success: "[&_[data-icon]]:!text-good",
          error: "[&_[data-icon]]:!text-bad",
        },
      }}
    />
  );
}
