import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { SetupForm } from "@/components/auth-forms";
import { ActionButton } from "@/components/ui/action-button";
import { Button } from "@/components/ui/button";
import { Callout, Skeleton } from "@/components/ui/card";
import { joinInvitedWorkspaces, signOut } from "@/lib/actions/auth";
import { getIdentity, getSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Set up your workspace" };

interface SetupStatus {
  workspace_count: number;
  can_create_workspace: boolean;
  pending_invitations: number;
}

async function Gate() {
  const identity = await getIdentity();
  if (!identity) redirect("/sign-in");
  if (await getSession()) redirect("/overview");

  const supabase = await createClient();
  const { data } = await supabase.rpc("setup_status");
  const status = (data ?? {
    workspace_count: 0,
    can_create_workspace: false,
    pending_invitations: 0,
  }) as unknown as SetupStatus;

  if (status.pending_invitations > 0) {
    return (
      <>
        <h2 className="text-ink text-2xl font-bold">You have been invited</h2>
        <p className="text-ink-muted mt-1 mb-6 text-[13px]">
          {status.pending_invitations === 1
            ? "A workspace is"
            : `${status.pending_invitations} workspaces are`}{" "}
          waiting for you.
        </p>
        <ActionButton action={joinInvitedWorkspaces} variant="primary" size="lg" className="w-full">
          Join workspace
        </ActionButton>
      </>
    );
  }

  if (status.can_create_workspace) {
    return (
      <>
        <h2 className="text-ink text-2xl font-bold">Name your workspace</h2>
        <p className="text-ink-muted mt-1 mb-6 text-[13px]">
          Campaigns, connections and members live in a workspace. You are its owner.
        </p>
        <SetupForm />
      </>
    );
  }

  return (
    <>
      <h2 className="text-ink text-2xl font-bold">No workspace access</h2>
      <Callout tone="warn" className="my-6">
        {identity.email} is signed in but is not a member of any workspace. Ask a workspace owner to
        invite this email address.
      </Callout>
      <form action={signOut}>
        <Button type="submit" variant="secondary" className="w-full">
          Sign out
        </Button>
      </form>
    </>
  );
}

export default function SetupPage() {
  return (
    <Suspense fallback={<Skeleton className="h-56 w-full" />}>
      <Gate />
    </Suspense>
  );
}
