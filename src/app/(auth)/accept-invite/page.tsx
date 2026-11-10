import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AcceptInviteForm } from "@/components/auth-forms";
import { Skeleton } from "@/components/ui/card";
import { getIdentity } from "@/lib/session";

export const metadata: Metadata = { title: "Accept invitation" };

async function Gate() {
  const identity = await getIdentity();
  if (!identity) redirect("/sign-in?error=link_invalid");
  return <AcceptInviteForm email={identity.email} />;
}

export default function AcceptInvitePage() {
  return (
    <>
      <h2 className="text-ink text-2xl font-bold">Accept your invitation</h2>
      <p className="text-ink-muted mt-1 mb-6 text-[13px]">
        Choose a password to finish setting up your account.
      </p>
      <Suspense fallback={<Skeleton className="h-72 w-full" />}>
        <Gate />
      </Suspense>
    </>
  );
}
