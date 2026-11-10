import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth-forms";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <>
      <h2 className="text-ink text-2xl font-bold">Reset your password</h2>
      <p className="text-ink-muted mt-1 mb-6 text-[13px]">
        Enter your email and we will send you a link to choose a new password.
      </p>
      <ForgotPasswordForm />
    </>
  );
}
