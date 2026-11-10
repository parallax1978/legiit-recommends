"use client";

import { X } from "lucide-react";
import {
  AlertDialog as RadixAlert,
  Dialog as RadixDialog,
  DropdownMenu as RadixMenu,
} from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

const overlay =
  "fixed inset-0 z-50 bg-ink/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in";
const panel =
  "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-lift";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export function DialogContent({
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  const width = { sm: "max-w-md", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" }[size];
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className={overlay} />
      <RadixDialog.Content
        className={cn(panel, width)}
        aria-describedby={description ? undefined : undefined}
      >
        <div className="border-line flex items-start justify-between gap-4 border-b px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <RadixDialog.Title className="text-ink text-base font-semibold">
              {title}
            </RadixDialog.Title>
            {description ? (
              <RadixDialog.Description className="text-ink-muted mt-1 text-[13px]">
                {description}
              </RadixDialog.Description>
            ) : (
              <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
            )}
          </div>
          <RadixDialog.Close
            className="text-ink-muted hover:bg-surface-sunken hover:text-ink rounded-full p-1.5"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden="true" />
          </RadixDialog.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
        {footer ? (
          <div className="border-line bg-surface-alt flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3 sm:px-6">
            {footer}
          </div>
        ) : null}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

export const AlertDialog = RadixAlert.Root;
export const AlertDialogTrigger = RadixAlert.Trigger;
export const AlertDialogCancel = RadixAlert.Cancel;
export const AlertDialogAction = RadixAlert.Action;

export function AlertDialogContent({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: ReactNode;
  children?: ReactNode;
  footer: ReactNode;
}) {
  return (
    <RadixAlert.Portal>
      <RadixAlert.Overlay className={overlay} />
      <RadixAlert.Content className={cn(panel, "max-w-md")}>
        <div className="px-5 pt-5 sm:px-6">
          <RadixAlert.Title className="text-ink text-base font-semibold">{title}</RadixAlert.Title>
          <RadixAlert.Description asChild>
            <div className="text-ink-muted mt-2 text-[13px] leading-relaxed">{description}</div>
          </RadixAlert.Description>
          {children ? <div className="mt-4">{children}</div> : null}
        </div>
        <div className="border-line bg-surface-alt mt-5 flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3 sm:px-6">
          {footer}
        </div>
      </RadixAlert.Content>
    </RadixAlert.Portal>
  );
}

export const Menu = RadixMenu.Root;
export const MenuTrigger = RadixMenu.Trigger;

export function MenuContent({
  children,
  align = "end",
  className,
}: {
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
}) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content
        align={align}
        sideOffset={6}
        className={cn(
          "border-line bg-surface shadow-lift z-50 min-w-48 overflow-hidden rounded-xl border p-1",
          className,
        )}
      >
        {children}
      </RadixMenu.Content>
    </RadixMenu.Portal>
  );
}

export function MenuItem({
  className,
  destructive,
  ...props
}: ComponentProps<typeof RadixMenu.Item> & { destructive?: boolean }) {
  return (
    <RadixMenu.Item
      className={cn(
        "data-[highlighted]:bg-surface-sunken flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        destructive ? "text-bad" : "text-ink",
        className,
      )}
      {...props}
    />
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <RadixMenu.Label className="text-ink-muted px-2.5 py-1.5 text-xs font-medium">
      {children}
    </RadixMenu.Label>
  );
}

export function MenuSeparator() {
  return <RadixMenu.Separator className="bg-line my-1 h-px" />;
}
