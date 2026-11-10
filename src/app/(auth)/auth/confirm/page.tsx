import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ConfirmLinkForm } from "@/components/auth-forms";
import { Callout, Skeleton } from "@/components/ui/card";
import { first } from "@/lib/params";

export const metadata: Metadata = { title: "Continue" };

const COPY: Record<string, { title: string; text: string; button: string }> = {
  invite: {
    title: "Accept your invitation",
    text: "Continue to choose a password and join the workspace.",
    button: "Continue",
  },
  recovery: {
    title: "Reset your password",
    text: "Continue to choose a new password.",
    button: "Continue",
  },
};
const DEFAULT_COPY = {
  title: "Finish signing in",
  text: "Continue to open Legiit Recommends.",
  button: "Continue",
};

/**
 * Landing page for links in invitation and recovery emails, and for one-time links an operator
 * creates. Opening it does nothing yet: the link's token is used only when the button is
 * pressed, so automatic link scanners and message previews cannot use it up.
 */
async function Confirm({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const tokenHash = first(params.token_hash);
  const type = first(params.type);
  const copy = COPY[type] ?? DEFAULT_COPY;

  if (!tokenHash || !type) {
    return (
      <>
        <h2 className="text-ink text-2xl font-bold">This link is incomplete</h2>
        <Callout tone="warn" role="alert" className="mt-4">
          Open the link from your email again, or ask for a new one.
        </Callout>
        <p className="text-ink-muted mt-4 text-[13px]">
          <Link href="/sign-in" className="text-brand hover:text-brand-strong font-medium">
            Back to sign in
          </Link>
        </p>
      </>
    );
  }

  return (
    <>
      <h2 className="text-ink text-2xl font-bold">{copy.title}</h2>
      <p className="text-ink-muted mt-1 mb-6 text-[13px]">
        {copy.text} The link in your email works once.
      </p>
      <ConfirmLinkForm
        tokenHash={tokenHash}
        type={type}
        next={first(params.next)}
        label={copy.button}
      />
    </>
  );
}

export default function ConfirmPage(props: PageProps<"/auth/confirm">) {
  return (
    <Suspense fallback={<Skeleton className="h-40 w-full" />}>
      <Confirm searchParams={props.searchParams} />
    </Suspense>
  );
}
