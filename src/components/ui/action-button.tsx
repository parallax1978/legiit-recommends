"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import type { ActionResult } from "@/lib/result";
import { Button, type ButtonSize, type ButtonVariant } from "./button";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogTrigger } from "./dialog";

interface ActionButtonProps {
  /** A server action already bound to its arguments. */
  action: () => Promise<ActionResult<unknown>>;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  disabled?: boolean;
  /** When set, the user must confirm in a dialog first. */
  confirm?: { title: string; description: ReactNode; confirmLabel: string; destructive?: boolean };
  successMessage?: string;
  /** Navigate here after success. */
  redirectTo?: string;
  onDone?: (result: ActionResult<unknown>) => void;
}

/** Runs a server action with pending state, a toast for the outcome and optional confirmation. */
export function ActionButton({
  action,
  children,
  variant = "secondary",
  size = "md",
  className,
  disabled,
  confirm,
  successMessage,
  redirectTo,
  onDone,
}: ActionButtonProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const run = () => {
    startTransition(async () => {
      let result: ActionResult<unknown>;
      try {
        result = await action();
      } catch {
        result = {
          ok: false,
          message: "The request could not be completed. Check your connection and try again.",
        };
      }
      setOpen(false);
      if (result.ok) {
        const message = result.message ?? successMessage;
        if (message) toast.success(message);
        if (redirectTo) router.push(redirectTo);
        else router.refresh();
      } else {
        toast.error(result.message);
      }
      onDone?.(result);
    });
  };

  const spinner = pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null;

  if (!confirm) {
    return (
      <Button
        variant={variant}
        size={size}
        className={className}
        disabled={disabled || pending}
        aria-busy={pending}
        onClick={run}
      >
        {spinner}
        {children}
      </Button>
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant={variant} size={size} className={className} disabled={disabled || pending}>
          {children}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        title={confirm.title}
        description={confirm.description}
        footer={
          <>
            <AlertDialogCancel asChild>
              <Button variant="secondary" disabled={pending}>
                Cancel
              </Button>
            </AlertDialogCancel>
            <Button
              variant={confirm.destructive ? "danger" : "primary"}
              disabled={pending}
              aria-busy={pending}
              onClick={run}
            >
              {spinner}
              {confirm.confirmLabel}
            </Button>
          </>
        }
      />
    </AlertDialog>
  );
}
