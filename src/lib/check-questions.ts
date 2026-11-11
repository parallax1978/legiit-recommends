// Which of a campaign's own questions can be asked as fresh checks. Pure, so the cases are
// tested. A fresh check is a question asked cold, in a new chat that says nothing about the
// business, so a wording that names the business cannot be one. The launch check judges the
// same thing properly (whole words, aliases, extra domains); this is the cheap first cut that
// keeps an obviously unusable question out of a new set.

export interface CampaignTarget {
  business_name: string;
  website_url: string;
}

const TARGET_PLACEHOLDER = /\{\{\s*(business_name|website_url)\s*\}\}/;

function host(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#:].*$/, "");
}

/** True when a question wording names the business, by placeholder or in so many words. */
export function namesTheBusiness(body: string, target: CampaignTarget): boolean {
  if (TARGET_PLACEHOLDER.test(body)) return true;
  const text = body.toLowerCase();
  const name = target.business_name.trim().toLowerCase();
  const domain = host(target.website_url);
  return (name !== "" && text.includes(name)) || (domain !== "" && text.includes(domain));
}

/**
 * The wordings of a campaign's first step that can be used as fresh-check questions: each one
 * once, in order, without the ones that name the business.
 */
export function questionsForChecks(bodies: string[], target: CampaignTarget): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of bodies) {
    const body = raw.trim();
    const key = body.toLowerCase().replace(/\s+/g, " ");
    if (body === "" || seen.has(key) || namesTheBusiness(body, target)) continue;
    seen.add(key);
    out.push(body);
  }
  return out;
}
