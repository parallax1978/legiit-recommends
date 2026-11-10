import type { Metadata } from "next";
import { Suspense } from "react";
import { SignInForm } from "@/components/auth-forms";
import { Skeleton } from "@/components/ui/card";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <>
      <h2 className="text-ink text-2xl font-bold">Sign in</h2>
      <p className="text-ink-muted mt-1 mb-6 text-[13px]">
        Access is by invitation from a workspace owner.
      </p>
      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <SignInForm />
      </Suspense>
    </>
  );
}
