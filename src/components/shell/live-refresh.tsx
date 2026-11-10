"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";
import { getBrowserClient } from "@/lib/supabase/browser";

const TABLES = ["campaigns", "jobs", "runs", "fresh_checks", "provider_connections"] as const;
const FALLBACK_INTERVAL_MS = 30_000;
const DEBOUNCE_MS = 1_200;

function subscribeOnline(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

/**
 * Keeps server-rendered screens current: database changes for the workspace arrive over
 * Supabase Realtime (authorized by row level security) and trigger a debounced refresh; a slow
 * interval covers a dropped socket. Forms being edited are left alone.
 */
export function LiveRefresh({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  const [realtime, setRealtime] = useState<"connecting" | "live" | "down">("connecting");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editing = /\/(edit|new)$/.test(pathname);
  const editingRef = useRef(editing);

  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  useEffect(() => {
    const refresh = () => {
      if (editingRef.current || document.visibilityState !== "visible") return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), DEBOUNCE_MS);
    };

    const supabase = getBrowserClient();
    let channel = supabase.channel(`workspace-${workspaceId}`);
    for (const table of TABLES) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `workspace_id=eq.${workspaceId}` },
        refresh,
      );
    }
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") setRealtime("live");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED")
        setRealtime("down");
    });

    const interval = setInterval(refresh, FALLBACK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", refresh);

    return () => {
      if (timer.current) clearTimeout(timer.current);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", refresh);
      void supabase.removeChannel(channel);
    };
  }, [router, workspaceId]);

  const state = !online
    ? "offline"
    : editing
      ? "paused"
      : realtime === "live"
        ? "live"
        : realtime === "down"
          ? "polling"
          : "connecting";
  const label = {
    offline: "Offline — showing the last loaded data",
    paused: "Live updates paused while editing",
    live: "Live",
    polling: "Reconnecting — refreshing every 30 seconds",
    connecting: "Connecting…",
  }[state];
  const short = {
    offline: "Offline",
    paused: "Editing",
    live: "Live",
    polling: "Reconnecting",
    connecting: "Connecting",
  }[state];

  return (
    <span
      role="status"
      title={label}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        state === "live"
          ? "bg-good-soft text-good"
          : state === "offline"
            ? "bg-bad-soft text-bad"
            : "bg-surface-sunken text-ink-muted",
      )}
    >
      <span
        className={cn("size-1.5 rounded-full bg-current", state === "live" ? "animate-pulse" : "")}
        aria-hidden="true"
      />
      <span aria-hidden="true">{short}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
