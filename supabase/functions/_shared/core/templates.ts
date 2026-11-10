// Template variables, validation and rendering.
//
// The database has a twin of this logic (app_private.template_problem / render_template) that is
// authoritative at launch time; tests/unit/parity checks keep the two in agreement.

export const TEMPLATE_KINDS = [
  "initial_question",
  "inclusion_request",
  "revision_request",
  "extra_step",
  "fresh_check",
] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const TEMPLATE_VARIABLES = [
  "business_name",
  "website_url",
  "category",
  "location",
  "language",
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

/** Variables that identify the target business. Never allowed in fresh-check questions. */
export const TARGET_VARIABLES: readonly TemplateVariable[] = ["business_name", "website_url"];

export type TemplateValues = Partial<Record<TemplateVariable, string | null | undefined>>;

export const VARIABLE_LABELS: Record<TemplateVariable, string> = {
  business_name: "Business name",
  website_url: "Website URL",
  category: "Category or topic",
  location: "Market or location",
  language: "Language",
};

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const VALID_NAME = /^[a-z_][a-z0-9_]*$/;

export function allowedVariables(kind: TemplateKind): readonly TemplateVariable[] {
  return kind === "fresh_check"
    ? TEMPLATE_VARIABLES.filter((v) => !TARGET_VARIABLES.includes(v))
    : TEMPLATE_VARIABLES;
}

/** Placeholder names used in a template body: trimmed, unique, sorted. */
export function extractVariables(body: string): string[] {
  const found = new Set<string>();
  for (const match of (body ?? "").matchAll(PLACEHOLDER)) {
    found.add((match[1] ?? "").trim());
  }
  return [...found].sort();
}

/** Returns a human-readable problem, or null when the body is a valid template for the kind. */
export function templateProblem(body: string, kind: TemplateKind): string | null {
  const text = body ?? "";
  if (text.trim().length === 0) return "The prompt text is empty.";
  if (text.length > 4000) return "The prompt text is longer than 4000 characters.";
  const allowed = allowedVariables(kind) as readonly string[];
  for (const name of extractVariables(text)) {
    if (!VALID_NAME.test(name)) return `"{{${name}}}" is not a valid variable.`;
    if (!allowed.includes(name)) {
      if (kind === "fresh_check" && (TARGET_VARIABLES as readonly string[]).includes(name)) {
        return `Fresh-check questions cannot use {{${name}}}: they must not mention the target business.`;
      }
      return `Unknown variable {{${name}}}.`;
    }
  }
  const rest = text.replace(PLACEHOLDER, "");
  if (/\{\{|\}\}/.test(rest)) return 'The prompt has an unclosed or stray "{{" or "}}".';
  return null;
}

/** Substitutes every known placeholder. Unknown placeholders are left untouched. */
export function renderTemplate(body: string, values: TemplateValues): string {
  return (body ?? "").replace(PLACEHOLDER, (whole, rawName: string) => {
    const name = rawName.trim();
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(name)) return whole;
    return (values[name as TemplateVariable] ?? "").toString().trim();
  });
}

/** Variables the template uses for which no non-empty value is available. */
export function unresolvedVariables(body: string, values: TemplateValues): string[] {
  return extractVariables(body).filter((name) => {
    const value = values[name as TemplateVariable];
    return value == null || value.toString().trim() === "";
  });
}

/** True when a rendered prompt is empty or still carries a placeholder. */
export function hasRenderingProblem(rendered: string): boolean {
  return rendered.trim().length === 0 || /\{\{[^{}]*\}\}/.test(rendered);
}

/** Normalized form used to compare two prompts for equality (case and whitespace insensitive). */
export function normalizePromptForComparison(text: string): string {
  return (text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
