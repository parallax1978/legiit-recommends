import type { EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

const ALLOWED_TYPES: EmailOtpType[] = [
  "invite",
  "recovery",
  "email",
  "magiclink",
  "email_change",
  "signup",
];

/**
 * Landing point for links in invitation and recovery emails. Verifies the one-time token hash
 * on the server, which signs the person in, then sends them on to set a password.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const requested = searchParams.get("next") ?? "";
  const fallback =
    type === "invite" ? "/accept-invite" : type === "recovery" ? "/reset-password" : "/overview";
  const next = requested.startsWith("/") && !requested.startsWith("//") ? requested : fallback;

  if (tokenHash && type && ALLOWED_TYPES.includes(type)) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) redirect(next);
  }
  redirect("/sign-in?error=link_invalid");
}
