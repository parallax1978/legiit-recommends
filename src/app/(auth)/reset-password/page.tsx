import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ResetPasswordForm } from "@/components/auth-forms";
import { Skeleton } from "@/components/ui/card";
import { getIdentity, signedInWithPassword } from "@/lib/session";

export const metadata: Metadata = { title: "Choose a new password" };

async function Gate() {
  // Reached through the one-time link in the recovery email, which signs the user in.
  const identity = await getIdentity();
  if (!identity) redirect("/sign-in?error=link_invalid");
  // Someone signed in with a password changes it in Settings, where the current one is asked for.
  if (signedInWithPassword(identity)) redirect("/settings?tab=profile");
  return <ResetPasswordForm />;
}

export default function ResetPasswordPage() {
  return (
    <>
      <h2 className="text-ink text-2xl font-bold">Choose a new password</h2>
      <p className="text-ink-muted mt-1 mb-6 text-[13px]">
        You will stay signed in on this device.
      </p>
      <Suspense fallback={<Skeleton className="h-48 w-full" />}>
        <Gate />
      </Suspense>
    </>
  );
}
