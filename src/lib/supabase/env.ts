function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env.local and fill it in (see README).`,
    );
  }
  return value;
}

// Referenced literally so the bundler can inline the public values for the browser.
export const supabaseUrl = () =>
  required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
export const supabasePublishableKey = () =>
  required(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );

/**
 * Attributes for the session cookie, wherever it is written (server, proxy or browser): Secure
 * whenever the page is served over HTTPS, which the library's default leaves out. It follows
 * the request rather than the build mode, so a production build opened over plain HTTP (a
 * local `next start`, a test run) still gets a cookie the browser will store.
 *
 * `protocol` is the request's scheme as the caller has it: "https", "https:" or the value of
 * x-forwarded-proto, which may list several proxies ("https,http"); the first one counts.
 */
export function sessionCookieOptions(protocol: string | null | undefined): { secure: boolean } {
  const first = (protocol ?? "").split(",")[0]!.trim().toLowerCase().replace(/:$/, "");
  return { secure: first === "https" };
}
