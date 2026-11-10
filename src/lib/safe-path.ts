const PLACEHOLDER_ORIGIN = "http://app.invalid";

/**
 * A same-site path to send someone to after signing in or opening an email link. Anything that
 * could leave the site falls back.
 *
 * The value is parsed rather than pattern-matched: browsers drop tabs and newlines inside URLs
 * and treat a backslash like a slash, so "/\t/evil.example" and "/\evil.example" both mean
 * "//evil.example", another site. Only printable ASCII is accepted, and the result must still
 * resolve to this origin.
 */
export function safeNextPath(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  if (!/^\/(?!\/)[\x21-\x7e]*$/.test(value) || value.includes("\\")) return fallback;
  try {
    const url = new URL(value, PLACEHOLDER_ORIGIN);
    if (url.origin !== PLACEHOLDER_ORIGIN) return fallback;
    // Dot segments are resolved by the parser ("/.//evil.example" becomes "//evil.example"),
    // so the normalised path is checked again: it must still lead to this origin.
    const path = `${url.pathname}${url.search}${url.hash}`;
    if (path.startsWith("//")) return fallback;
    return new URL(path, PLACEHOLDER_ORIGIN).origin === PLACEHOLDER_ORIGIN ? path : fallback;
  } catch {
    return fallback;
  }
}
