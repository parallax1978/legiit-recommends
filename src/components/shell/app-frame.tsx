"use client";

import {
  BarChart3,
  BookOpenText,
  ChevronsUpDown,
  CircleDollarSign,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu as MenuIcon,
  MessagesSquare,
  ScanSearch,
  Settings,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { Logo } from "@/components/brand/logo";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/dialog";
import { actionFailure, toastFailure } from "@/lib/action-failure";
import { switchWorkspace } from "@/lib/actions/auth";
import { cn } from "@/lib/cn";
import { submitSignOut } from "@/lib/sign-out";
import { LiveRefresh } from "./live-refresh";

export interface FrameWorkspace {
  id: string;
  name: string;
  roleLabel: string;
}

interface AppFrameProps {
  user: { email: string; displayName: string | null };
  workspace: FrameWorkspace;
  workspaces: FrameWorkspace[];
  banners?: ReactNode;
  children: ReactNode;
}

const NAV = [
  { href: "/overview", label: "Overview", icon: LayoutDashboard },
  { href: "/campaigns", label: "Campaigns", icon: Megaphone },
  { href: "/conversations", label: "Conversations", icon: MessagesSquare },
  { href: "/fresh-checks", label: "Fresh Checks", icon: ScanSearch },
  { href: "/results", label: "Results", icon: BarChart3 },
  { href: "/library", label: "Prompt Library", icon: BookOpenText },
  { href: "/usage", label: "Usage", icon: CircleDollarSign },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <ul className="flex flex-col gap-0.5">
      {NAV.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-medium transition-colors",
                active
                  ? "bg-brand-faint text-brand-strong"
                  : "text-ink-muted hover:bg-surface-sunken hover:text-ink",
              )}
            >
              <item.icon
                className={cn("size-4 shrink-0", active ? "text-brand" : "text-ink-soft")}
                aria-hidden="true"
              />
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function WorkspaceSwitcher({
  workspace,
  workspaces,
}: {
  workspace: FrameWorkspace;
  workspaces: FrameWorkspace[];
}) {
  const [, startTransition] = useTransition();
  const body = (
    <span className="flex min-w-0 flex-1 flex-col text-left">
      <span className="text-ink truncate text-[13px] font-semibold">{workspace.name}</span>
      <span className="text-ink-muted text-[11px]">{workspace.roleLabel}</span>
    </span>
  );
  if (workspaces.length <= 1) {
    return (
      <div className="border-line bg-surface-alt flex items-center gap-2 rounded-xl border px-3 py-2">
        {body}
      </div>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        className="border-line bg-surface-alt hover:border-line-strong flex w-full items-center gap-2 rounded-xl border px-3 py-2"
        aria-label={`Workspace: ${workspace.name}. Switch workspace`}
      >
        {body}
        <ChevronsUpDown className="text-ink-soft size-4 shrink-0" aria-hidden="true" />
      </MenuTrigger>
      <MenuContent align="start" className="w-60">
        <MenuLabel>Switch workspace</MenuLabel>
        {workspaces.map((option) => (
          <MenuItem
            key={option.id}
            disabled={option.id === workspace.id}
            onSelect={() =>
              // In a transition, so the redirect of a successful switch is followed and a failure
              // (an out-of-date tab, no connection) is said out loud instead of doing nothing.
              startTransition(async () => {
                try {
                  await switchWorkspace(option.id);
                } catch (error) {
                  toastFailure(actionFailure(error));
                }
              })
            }
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{option.name}</span>
              <span className="text-ink-muted text-[11px]">{option.roleLabel}</span>
            </span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function UserMenu({ user }: { user: AppFrameProps["user"] }) {
  const name = user.displayName || user.email;
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <Menu>
      <MenuTrigger
        className="hover:bg-surface-sunken flex items-center gap-2 rounded-full p-0.5 pr-2"
        aria-label={`Account menu for ${name}`}
      >
        <span
          className="brand-gradient flex size-8 items-center justify-center rounded-full text-xs font-bold text-white"
          aria-hidden="true"
        >
          {initial}
        </span>
        <span className="text-ink hidden max-w-40 truncate text-[13px] font-medium sm:block">
          {name}
        </span>
      </MenuTrigger>
      <MenuContent className="w-60">
        <MenuLabel>
          <span className="block truncate">{user.email}</span>
        </MenuLabel>
        <MenuSeparator />
        <MenuItem asChild>
          <Link href="/settings?tab=profile">
            <Settings className="text-ink-muted size-4" aria-hidden="true" />
            Account settings
          </Link>
        </MenuItem>
        <MenuItem onSelect={submitSignOut}>
          <LogOut className="text-ink-muted size-4" aria-hidden="true" />
          Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function AppFrame({ user, workspace, workspaces, banners, children }: AppFrameProps) {
  const [open, setOpen] = useState(false);

  const sidebar = (onNavigate?: () => void) => (
    <div className="flex h-full flex-col gap-5 px-4 py-5">
      <Link
        href="/overview"
        onClick={onNavigate}
        className="rounded-lg px-1"
        aria-label="Legiit Recommends overview"
      >
        <Logo />
      </Link>
      <WorkspaceSwitcher workspace={workspace} workspaces={workspaces} />
      <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto">
        <NavLinks onNavigate={onNavigate} />
      </nav>
      <p className="text-ink-muted px-1 text-[11px] leading-relaxed">
        Results shown here come from the OpenAI API. They are not ChatGPT app results.
      </p>
    </div>
  );

  return (
    <div className="min-h-dvh lg:pl-64">
      <a
        href="#main"
        className="focus:bg-brand sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-full focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to content
      </a>

      <aside className="border-line bg-surface fixed inset-y-0 left-0 z-30 hidden w-64 border-r lg:block">
        {sidebar()}
      </aside>

      {open ? (
        <div
          className="fixed inset-0 z-50 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
        >
          <button
            type="button"
            className="bg-ink/40 absolute inset-0"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
          />
          <div className="border-line bg-surface shadow-lift relative h-full w-72 max-w-[85vw] border-r">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-ink-muted hover:bg-surface-sunken absolute top-4 right-3 rounded-full p-2"
              aria-label="Close navigation"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
            {sidebar(() => setOpen(false))}
          </div>
        </div>
      ) : null}

      <header className="border-line bg-surface/90 sticky top-0 z-20 flex h-14 items-center gap-3 border-b px-4 backdrop-blur sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-ink-muted hover:bg-surface-sunken rounded-full p-2 lg:hidden"
          aria-label="Open navigation"
          aria-expanded={open}
        >
          <MenuIcon className="size-5" aria-hidden="true" />
        </button>
        <Link href="/overview" className="lg:hidden" aria-label="Legiit Recommends overview">
          <Logo size={24} />
        </Link>
        <div className="ml-auto flex items-center gap-3">
          <LiveRefresh workspaceId={workspace.id} />
          <UserMenu user={user} />
        </div>
      </header>

      {banners}

      <main id="main" className="px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <div className="mx-auto w-full max-w-7xl">{children}</div>
      </main>
    </div>
  );
}
