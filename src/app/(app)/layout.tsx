import Link from "next/link";
import { Suspense } from "react";
import { AppFrame } from "@/components/shell/app-frame";
import { Callout } from "@/components/ui/card";
import { PageSkeleton } from "@/components/ui/misc";
import { ROLE_LABELS, hasRole, requireSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

async function Shell({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const supabase = await createClient();
  const { data: failing } = await supabase
    .from("provider_connections")
    .select("id, name, status_message")
    .eq("workspace_id", session.workspace.id)
    .eq("status", "error")
    .is("archived_at", null);

  const owner = hasRole(session.role, "owner");
  const banners =
    session.workspace.emergencyStop || (failing?.length ?? 0) > 0 ? (
      <div className="flex flex-col gap-2 px-4 pt-4 sm:px-6 lg:px-8">
        {session.workspace.emergencyStop ? (
          <Callout
            tone="bad"
            role="alert"
            title="Emergency stop is on"
            action={
              <Link
                href="/settings?tab=workspace"
                className="text-bad text-[13px] font-semibold underline underline-offset-2"
              >
                {owner ? "Manage" : "Details"}
              </Link>
            }
          >
            No requests are being sent to the provider for this workspace.
            {session.workspace.emergencyStopReason
              ? ` Reason: ${session.workspace.emergencyStopReason}`
              : ""}
          </Callout>
        ) : null}
        {(failing ?? []).map((connection) => (
          <Callout
            key={connection.id}
            tone="warn"
            role="alert"
            title={`Connection "${connection.name}" needs attention`}
            action={
              <Link
                href="/settings?tab=connections"
                className="text-warn text-[13px] font-semibold underline underline-offset-2"
              >
                {owner ? "Fix connection" : "Details"}
              </Link>
            }
          >
            {connection.status_message ?? "The last request to the provider failed."} Work that uses
            it is on hold.
          </Callout>
        ))}
      </div>
    ) : null;

  return (
    <AppFrame
      user={{ email: session.email, displayName: session.displayName }}
      workspace={{
        id: session.workspace.id,
        name: session.workspace.name,
        roleLabel: ROLE_LABELS[session.role],
      }}
      workspaces={session.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        roleLabel: ROLE_LABELS[workspace.role],
      }))}
      banners={banners}
    >
      <Suspense fallback={<PageSkeleton />}>{children}</Suspense>
    </AppFrame>
  );
}

function ShellFallback() {
  return (
    <div className="min-h-dvh lg:pl-64" aria-busy="true">
      <div className="border-line bg-surface fixed inset-y-0 left-0 hidden w-64 border-r lg:block" />
      <div className="border-line bg-surface h-14 border-b" />
      <div className="px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <div className="mx-auto w-full max-w-7xl">
          <PageSkeleton />
        </div>
      </div>
    </div>
  );
}

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <Suspense fallback={<ShellFallback />}>
      <Shell>{children}</Shell>
    </Suspense>
  );
}
