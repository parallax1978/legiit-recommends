"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useActionState } from "react";
import {
  acceptInvite,
  completeSetup,
  requestPasswordReset,
  signIn,
  updatePassword,
} from "@/lib/actions/auth";
import type { ActionResult } from "@/lib/result";
import { Callout } from "./ui/card";
import { Field, Input } from "./ui/form";
import { SubmitButton } from "./ui/submit-button";

function errorOf(state: ActionResult | null, field: string): string | null {
  return state && !state.ok ? (state.fieldErrors?.[field] ?? null) : null;
}

function FormMessage({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  if (state.ok)
    return state.message ? (
      <Callout tone="good" role="status">
        {state.message}
      </Callout>
    ) : null;
  if (state.fieldErrors && Object.keys(state.fieldErrors).length > 0) return null;
  return (
    <Callout tone="bad" role="alert">
      {state.message}
    </Callout>
  );
}

const LINK_ERRORS: Record<string, string> = {
  link_invalid: "That link is invalid or has expired. Request a new one.",
};

export function SignInForm() {
  const params = useSearchParams();
  const [state, action] = useActionState(signIn, null);
  const linkError = LINK_ERRORS[params.get("error") ?? ""];
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      {linkError && !state ? (
        <Callout tone="warn" role="alert">
          {linkError}
        </Callout>
      ) : null}
      <FormMessage state={state} />
      <input type="hidden" name="next" value={params.get("next") ?? ""} />
      <Field label="Email" htmlFor="email" error={errorOf(state, "email")}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          aria-invalid={Boolean(errorOf(state, "email"))}
        />
      </Field>
      <Field label="Password" htmlFor="password" error={errorOf(state, "password")}>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={Boolean(errorOf(state, "password"))}
        />
      </Field>
      <SubmitButton size="lg" className="mt-1 w-full">
        Sign in
      </SubmitButton>
      <p className="text-ink-muted text-center text-[13px]">
        <Link href="/forgot-password" className="text-brand hover:text-brand-strong font-medium">
          Forgot your password?
        </Link>
      </p>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [state, action] = useActionState(requestPasswordReset, null);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <FormMessage state={state} />
      <Field label="Email" htmlFor="email" error={errorOf(state, "email")}>
        <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
      </Field>
      <SubmitButton size="lg" className="mt-1 w-full">
        Send reset link
      </SubmitButton>
      <p className="text-ink-muted text-center text-[13px]">
        <Link href="/sign-in" className="text-brand hover:text-brand-strong font-medium">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}

function PasswordFields({ state }: { state: ActionResult | null }) {
  return (
    <>
      <Field
        label="New password"
        htmlFor="password"
        hint="At least 10 characters."
        error={errorOf(state, "password")}
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
        />
      </Field>
      <Field label="Confirm password" htmlFor="confirm" error={errorOf(state, "confirm")}>
        <Input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
        />
      </Field>
    </>
  );
}

export function ResetPasswordForm() {
  const [state, action] = useActionState(updatePassword, null);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <FormMessage state={state} />
      <PasswordFields state={state} />
      <SubmitButton size="lg" className="mt-1 w-full">
        Save password
      </SubmitButton>
    </form>
  );
}

export function AcceptInviteForm({ email }: { email: string }) {
  const [state, action] = useActionState(acceptInvite, null);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <FormMessage state={state} />
      <Field label="Email" htmlFor="invite-email">
        <Input id="invite-email" value={email} readOnly disabled />
      </Field>
      <Field label="Your name" htmlFor="display_name" optional>
        <Input id="display_name" name="display_name" autoComplete="name" maxLength={120} />
      </Field>
      <PasswordFields state={state} />
      <SubmitButton size="lg" className="mt-1 w-full">
        Accept invitation
      </SubmitButton>
    </form>
  );
}

export function SetupForm() {
  const [state, action] = useActionState(completeSetup, null);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <FormMessage state={state} />
      <Field
        label="Workspace name"
        htmlFor="workspace_name"
        hint="Shown to everyone you invite. You can change it later."
        error={errorOf(state, "workspace_name")}
      >
        <Input id="workspace_name" name="workspace_name" required maxLength={80} autoFocus />
      </Field>
      <SubmitButton size="lg" className="mt-1 w-full">
        Create workspace
      </SubmitButton>
    </form>
  );
}
