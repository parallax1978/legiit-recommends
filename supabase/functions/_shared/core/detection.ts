// Detecting whether a business appears in an answer, and how.
//
// Two separate questions are answered:
//   1. Mention  — does the answer contain the business name, an accepted alias, or its domain?
//                 Matching is case-insensitive, accent-insensitive and bounded by word boundaries,
//                 so "Legiit" does not match "legiitimate" and "apple.com" does not match
//                 "pineapple.com". Domains are compared by host, so links, Markdown links and
//                 subdomains all count while look-alike hosts do not.
//   2. Inclusion — is the business one of the recommended items, or merely mentioned?
//                 It counts as included only when it is the subject of a list item. Anything the
//                 rules cannot decide is reported as "ambiguous" for human review; it is never
//                 promoted to "included".
//
// A rank is reported only for explicitly numbered lists. For bullets, the position in the list is
// reported separately and no rank is invented.
//
// The raw answer is never modified: every match carries character offsets into the original text.

export const DETECTOR_VERSION = "rules-1";

export interface DetectionTarget {
  business_name: string;
  website_url?: string | null;
  business_aliases?: string[] | null;
  domain_aliases?: string[] | null;
}

export type MatchKind = "name" | "alias" | "domain" | "domain_alias";

export interface MatchSpan {
  start: number;
  end: number;
  text: string;
  kind: MatchKind;
  term: string;
}

export type Inclusion = "included" | "mentioned_only" | "not_mentioned" | "ambiguous";
export type ListKind = "numbered" | "bulleted" | "none";

export interface Classification {
  detector_version: string;
  mentioned: boolean;
  inclusion: Inclusion;
  /** Explicit rank from a numbered list; null otherwise. */
  rank: number | null;
  /** One-based position within an unranked (bulleted) list; null otherwise. */
  list_position: number | null;
  list_kind: ListKind;
  list_length: number | null;
  matched_spans: MatchSpan[];
  reason: string;
}

// ---------------------------------------------------------------------------------------------
// Normalization with an index map back to the original text
// ---------------------------------------------------------------------------------------------

interface Normalized {
  text: string;
  /** map[i] = offset in the original string of the character that produced normalized char i. */
  map: number[];
}

const APOSTROPHES = /[\u2018\u2019\u201A\u201B\u2032\u02BC`\u00B4]/;
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033]/;
const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/;
const COMBINING_MARK = /\p{M}/u;
const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060\uFEFF\u00AD]/;

function normalizeWithMap(input: string, lowerCase: boolean): Normalized {
  const out: string[] = [];
  const map: number[] = [];
  let offset = 0;
  let previousWasSpace = false;
  for (const char of input) {
    const start = offset;
    offset += char.length;
    if (ZERO_WIDTH.test(char)) continue;
    let folded = char.normalize("NFKD");
    if (lowerCase) folded = folded.toLowerCase();
    for (const piece of folded) {
      if (COMBINING_MARK.test(piece)) continue;
      let c = piece;
      if (APOSTROPHES.test(c)) c = "'";
      else if (DOUBLE_QUOTES.test(c)) c = '"';
      else if (DASHES.test(c)) c = "-";
      else if (/\s/u.test(c)) c = " ";
      if (c === " ") {
        if (previousWasSpace) continue;
        previousWasSpace = true;
      } else {
        previousWasSpace = false;
      }
      for (const unit of c) {
        out.push(unit);
        map.push(start);
      }
    }
  }
  return { text: out.join(""), map };
}

function normalizeTerm(term: string, lowerCase: boolean): string {
  return normalizeWithMap(term, lowerCase).text.trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ALNUM = /[\p{L}\p{N}]/u;

/** Number of letters and digits in a term. Very short names are matched case-sensitively. */
function alnumLength(term: string): number {
  let count = 0;
  for (const char of term) if (ALNUM.test(char)) count += 1;
  return count;
}

// ---------------------------------------------------------------------------------------------
// Name and alias matching
// ---------------------------------------------------------------------------------------------

function buildNamePattern(normalizedTerm: string): RegExp | null {
  if (alnumLength(normalizedTerm) < 2) return null;
  // Words of the term may be joined by spaces, hyphens, or nothing ("Legiit Leads" ~ "LegiitLeads").
  const words = normalizedTerm.split(/[\s-]+/).filter(Boolean).map(escapeRegExp);
  if (words.length === 0) return null;
  const body = words.join("[\\s-]*");
  const first = normalizedTerm[0] ?? "";
  const last = normalizedTerm[normalizedTerm.length - 1] ?? "";
  const before = ALNUM.test(first) ? "(?<![\\p{L}\\p{N}])" : "";
  const after = ALNUM.test(last) ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${before}${body}${after}`, "gu");
}

function findNameMatches(
  text: string,
  folded: Normalized,
  cased: Normalized,
  term: string,
  kind: MatchKind,
): MatchSpan[] {
  const trimmed = (term ?? "").trim();
  if (!trimmed) return [];
  // Names of three characters or fewer ("Go", "Box") are too easily ordinary words: they must
  // appear with their exact capitalization.
  const caseSensitive = alnumLength(trimmed) <= 3;
  const source = caseSensitive ? cased : folded;
  const pattern = buildNamePattern(normalizeTerm(trimmed, !caseSensitive));
  if (!pattern) return [];

  const spans: MatchSpan[] = [];
  for (const match of source.text.matchAll(pattern)) {
    if (match.index === undefined || match[0].length === 0) continue;
    const start = source.map[match.index];
    const lastNormIndex = match.index + match[0].length - 1;
    const lastOriginal = source.map[lastNormIndex];
    if (start === undefined || lastOriginal === undefined) continue;
    // Extend to the end of the original character (surrogate pairs, combining sequences).
    let end = lastOriginal + 1;
    const next = source.map[lastNormIndex + 1];
    if (next !== undefined && next > lastOriginal) end = next;
    else if (next === undefined) end = text.length;
    // Do not swallow trailing whitespace that was collapsed during normalization.
    while (end > start && /\s/u.test(text[end - 1] ?? "")) end -= 1;
    spans.push({ start, end, text: text.slice(start, end), kind, term: trimmed });
  }
  return spans;
}

// ---------------------------------------------------------------------------------------------
// Domain matching
// ---------------------------------------------------------------------------------------------

/** Lower-cased ASCII (punycode) host without scheme, credentials, "www.", port, path or dot. */
export function normalizeHost(input: string | null | undefined): string | null {
  let value = (input ?? "").trim();
  if (!value) return null;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  value = value.split(/[/?#]/)[0] ?? "";
  value = value.replace(/^[^@]*@/, "");
  value = value.replace(/:\d+$/, "").replace(/\.+$/, "");
  if (!value || !value.includes(".") || /\s/.test(value)) return null;
  let host: string;
  try {
    host = new URL(`http://${value}`).hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/^www\./, "");
  return host && host.includes(".") ? host : null;
}

function hostMatches(host: string, target: string): boolean {
  return host === target || host.endsWith(`.${target}`);
}

// A URL or bare domain: optional scheme, dot-separated labels, a TLD of letters, optional
// port, path, query and fragment.
const URL_CANDIDATE =
  /(?<![\p{L}\p{N}_.-])(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}]{2,24}(?::\d{1,5})?(?:[/?#][^\s<>"'`)\]]*)?/giu;

interface UrlCandidate {
  start: number;
  end: number;
  text: string;
  host: string;
  /** False for accidental matches such as "beans.Northwind" (a missing space after a period). */
  urlLike: boolean;
}

function findUrlCandidates(text: string): UrlCandidate[] {
  const candidates: UrlCandidate[] = [];
  for (const match of text.matchAll(URL_CANDIDATE)) {
    if (match.index === undefined) continue;
    // Trailing sentence punctuation is not part of the address.
    const candidate = match[0].replace(/[.,;:!?*_~]+$/u, "");
    const host = normalizeHost(candidate);
    if (!host) continue;
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate);
    const rawHost = candidate.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#:]/)[0] ?? "";
    const tld = rawHost.split(".").pop() ?? "";
    const urlLike = hasScheme || tld === tld.toLowerCase() || rawHost === rawHost.toUpperCase();
    candidates.push({ start: match.index, end: match.index + candidate.length, text: candidate, host, urlLike });
  }
  return candidates;
}

function findDomainMatches(
  candidates: UrlCandidate[],
  domains: { host: string; kind: MatchKind; term: string }[],
): MatchSpan[] {
  const spans: MatchSpan[] = [];
  for (const candidate of candidates) {
    const hit = domains.find((domain) => hostMatches(candidate.host, domain.host));
    if (!hit) continue;
    spans.push({ start: candidate.start, end: candidate.end, text: candidate.text, kind: hit.kind, term: hit.term });
  }
  return spans;
}

// ---------------------------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------------------------

function uniqueNonEmpty(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** Every occurrence of the target (name, aliases, domains) in `text`, in document order. */
export function findMentions(text: string, target: DetectionTarget): MatchSpan[] {
  const raw = text ?? "";
  if (!raw.trim() || !target) return [];
  const folded = normalizeWithMap(raw, true);
  const cased = normalizeWithMap(raw, false);

  const spans: MatchSpan[] = [];
  spans.push(...findNameMatches(raw, folded, cased, target.business_name, "name"));
  for (const alias of uniqueNonEmpty(target.business_aliases ?? [])) {
    if (alias.toLowerCase() === (target.business_name ?? "").trim().toLowerCase()) continue;
    spans.push(...findNameMatches(raw, folded, cased, alias, "alias"));
  }

  const domains: { host: string; kind: MatchKind; term: string }[] = [];
  const primary = normalizeHost(target.website_url);
  if (primary) domains.push({ host: primary, kind: "domain", term: primary });
  for (const alias of uniqueNonEmpty(target.domain_aliases ?? [])) {
    const host = normalizeHost(alias);
    if (host && !domains.some((domain) => domain.host === host)) {
      domains.push({ host, kind: "domain_alias", term: host });
    }
  }
  // A name that only occurs inside someone else's address ("apple.example.evil.test",
  // "reviews.example/northwind-roasters") is not a mention of the business.
  const candidates = findUrlCandidates(raw);
  const outsideAddresses = spans.filter(
    (span) => !candidates.some((c) => c.urlLike && span.start >= c.start && span.end <= c.end),
  );
  spans.length = 0;
  spans.push(...outsideAddresses, ...findDomainMatches(candidates, domains));

  // Order by position; when two matches overlap keep the longer one.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: MatchSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) {
      if (span.end - span.start > last.end - last.start) merged[merged.length - 1] = span;
      continue;
    }
    merged.push(span);
  }
  return merged;
}

/** True when the text names the target. Used to keep fresh-check prompts free of the target. */
export function mentionsTarget(text: string, target: DetectionTarget): boolean {
  return findMentions(text, target).length > 0;
}

// ---------------------------------------------------------------------------------------------
// List structure
// ---------------------------------------------------------------------------------------------

type ItemKind = "numbered" | "bulleted" | "heading" | "table" | "bold";

interface Item {
  kind: ItemKind;
  /** Index of the item's first line. */
  line: number;
  /** Offset of the first character of the line. */
  lineStart: number;
  /** Offset where the item's own content begins (after the marker). */
  contentStart: number;
  /** End of the item's first line. */
  lineEnd: number;
  /** End of everything that belongs to the item (continuation lines, nested content). */
  bodyEnd: number;
  /** Indentation of the marker; headings use -1 so that they enclose everything below them. */
  indent: number;
  /** Heading level for headings and numbered headings, else 0. */
  level: number;
  number: number | null;
  listId: number;
  /** One-based position among the items of the same list. */
  position: number;
}

interface ParsedLine {
  start: number;
  end: number;
  text: string;
  trimmed: string;
  blank: boolean;
  indent: number;
}

interface Marker {
  kind: ItemKind;
  number: number | null;
  /** Characters of `trimmed` consumed by the marker. */
  length: number;
  /** Heading level when the marker is (or sits inside) a Markdown heading, else 0. */
  level: number;
}

// "1." "1)" "1 -" "#1:" and the same wrapped in emphasis: "**1.**" or "**1. Name**".
const NUMBERED_MARKER = /^(?:>\s*)*([*_]{1,3})?#?(\d{1,3})(?:[.)]|\s*[-\u2013\u2014:])([*_]{1,3})?\s+/u;
const BULLET_MARKER = /^(?:>\s*)*[-*+\u2022\u25E6\u25AA\u2013\u2014]\s+/u;
const HEADING_MARKER = /^(#{1,6})\s+/u;
const TABLE_ROW = /^\|(.+)\|\s*$/u;
const TABLE_SEPARATOR = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/u;
const BOLD_START = /^(\*\*|__)(?=\S)/u;

function splitLines(text: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  let start = 0;
  for (const part of text.split("\n")) {
    const raw = part.endsWith("\r") ? part.slice(0, -1) : part;
    const trimmed = raw.trimStart();
    lines.push({
      start,
      end: start + raw.length,
      text: raw,
      trimmed,
      blank: trimmed.length === 0,
      indent: raw.length - trimmed.length,
    });
    start += part.length + 1;
  }
  return lines;
}

function numberedMarker(text: string): { number: number; length: number } | null {
  const match = NUMBERED_MARKER.exec(text);
  if (!match) return null;
  // When emphasis opens before the number but does not close right after it ("**1. Name**"),
  // the emphasis belongs to the item's content.
  const openEmphasis = match[1] && !match[3] ? match[1].length : 0;
  return { number: Number(match[2]), length: match[0].length - openEmphasis };
}

function detectMarker(line: ParsedLine, inTableBody: boolean): Marker | null {
  const { trimmed } = line;
  const heading = HEADING_MARKER.exec(trimmed);
  if (heading) {
    const level = heading[1]!.length;
    const numbered = numberedMarker(trimmed.slice(heading[0].length));
    if (numbered) {
      return { kind: "numbered", number: numbered.number, length: heading[0].length + numbered.length, level };
    }
    return { kind: "heading", number: null, length: heading[0].length, level };
  }
  const numbered = numberedMarker(trimmed);
  if (numbered) return { kind: "numbered", number: numbered.number, length: numbered.length, level: 0 };
  const bullet = BULLET_MARKER.exec(trimmed);
  if (bullet) return { kind: "bulleted", number: null, length: bullet[0].length, level: 0 };
  if (inTableBody && TABLE_ROW.test(trimmed)) return { kind: "table", number: null, length: 1, level: 0 };
  return null;
}

function parseItems(text: string): Item[] {
  const lines = splitLines(text);
  const markers: (Marker | null)[] = new Array(lines.length).fill(null);
  /** Lines that end a list: text at (or left of) the margin that follows a blank line. */
  const paragraphStart: boolean[] = new Array(lines.length).fill(false);

  let insideFence = false;
  let inTableBody = false;
  let afterBlank = true;
  lines.forEach((line, index) => {
    if (/^(```|~~~)/.test(line.trimmed)) {
      insideFence = !insideFence;
      inTableBody = false;
      return;
    }
    if (insideFence) return;
    if (line.blank) {
      afterBlank = true;
      inTableBody = false;
      return;
    }
    if (TABLE_ROW.test(line.trimmed)) {
      if (TABLE_SEPARATOR.test(line.trimmed)) {
        inTableBody = true; // rows after the separator are data rows
      } else if (inTableBody) {
        markers[index] = detectMarker(line, true);
      }
      afterBlank = false;
      return;
    }
    inTableBody = false;
    const marker = detectMarker(line, false);
    markers[index] = marker;
    if (!marker && afterBlank) paragraphStart[index] = true;
    afterBlank = false;
  });

  const items: Item[] = [];
  let listCounter = 0;
  const open = new Map<string, { listId: number; lastNumber: number | null; count: number }>();
  const closeWhere = (predicate: (key: string) => boolean) => {
    for (const key of [...open.keys()]) if (predicate(key)) open.delete(key);
  };
  const indentOf = (key: string) => Number(key.split(":")[1]);

  lines.forEach((line, index) => {
    const marker = markers[index];
    if (!marker) {
      if (paragraphStart[index]) {
        // A new paragraph ends bullet lists and tables at the same or deeper indentation.
        closeWhere((key) => (key.startsWith("b:") && indentOf(key) >= line.indent) || key === "t");
      }
      return;
    }

    let key: string;
    if (marker.kind === "heading") {
      key = `h:${marker.level}`;
      // A heading starts a new section: lists inside the previous section are over.
      closeWhere((k) => !k.startsWith("h:") && !k.startsWith("nh:"));
      closeWhere((k) => (k.startsWith("h:") || k.startsWith("nh:")) && indentOf(k) > marker.level);
    } else if (marker.kind === "numbered" && marker.level > 0) {
      key = `nh:${marker.level}`;
      closeWhere((k) => !k.startsWith("h:") && !k.startsWith("nh:"));
    } else if (marker.kind === "table") {
      key = "t";
    } else {
      key = `${marker.kind === "numbered" ? "n" : "b"}:${line.indent}`;
      // Deeper lists end when a shallower item appears.
      closeWhere((k) => (k.startsWith("n:") || k.startsWith("b:")) && indentOf(k) > line.indent);
    }

    let list = open.get(key);
    if (marker.kind === "numbered") {
      // A numbered list continues only while its numbers follow on from one another.
      if (!list || marker.number !== (list.lastNumber ?? 0) + 1) {
        listCounter += 1;
        list = { listId: listCounter, lastNumber: null, count: 0 };
        open.set(key, list);
      }
      list.lastNumber = marker.number;
    } else if (!list) {
      listCounter += 1;
      list = { listId: listCounter, lastNumber: null, count: 0 };
      open.set(key, list);
    }
    list.count += 1;

    items.push({
      kind: marker.kind,
      line: index,
      lineStart: line.start,
      contentStart: line.start + line.indent + marker.length,
      lineEnd: line.end,
      bodyEnd: line.end,
      indent: marker.level > 0 ? -1 : line.indent,
      level: marker.level,
      number: marker.number,
      listId: list.listId,
      position: list.count,
    });
  });

  // Fallback: answers that put each recommendation on its own bold line without list markers.
  if (items.length === 0) {
    lines.forEach((line, index) => {
      if (!BOLD_START.test(line.trimmed)) return;
      items.push({
        kind: "bold",
        line: index,
        lineStart: line.start,
        contentStart: line.start + line.indent,
        lineEnd: line.end,
        bodyEnd: line.end,
        indent: line.indent,
        level: 0,
        number: null,
        listId: 1,
        position: items.length + 1,
      });
    });
    return items.length >= 2 ? items : [];
  }

  // What belongs to each item beyond its first line: continuation lines and nested content.
  items.forEach((item, i) => {
    if (item.kind === "heading" || item.kind === "table") return; // the line itself only
    const sibling = items.find((other, j) => j > i && other.listId === item.listId);
    // Up to the next sibling. The last item of a list instead ends at a new paragraph, at a
    // heading, or where an enclosing (shallower) list continues.
    let endLine = sibling ? sibling.line : lines.length;
    if (!sibling) {
      for (let j = item.line + 1; j < endLine; j += 1) {
        const marker = markers[j];
        const line = lines[j]!;
        const isHeading = marker !== null && marker !== undefined && marker.level > 0;
        const endsSection = isHeading && (item.level === 0 || marker!.level <= item.level);
        const shallowerItem = !!marker && marker.level === 0 && item.indent >= 0 && line.indent < item.indent;
        const newParagraph = paragraphStart[j] && line.indent <= Math.max(item.indent, 0);
        if (endsSection || shallowerItem || newParagraph) {
          endLine = j;
          break;
        }
      }
    }
    let last = endLine - 1;
    while (last > item.line && lines[last]!.blank) last -= 1;
    item.bodyEnd = lines[last]!.end;
  });

  return items;
}

// ---------------------------------------------------------------------------------------------
// Is the target the subject of a list item?
// ---------------------------------------------------------------------------------------------

// Words that may precede the name at the start of an item without changing who the item is about.
const LEAD_IN_WORDS = new Set([
  "the", "a", "an", "try", "visit", "use", "using", "check", "consider", "see", "and", "also",
  "plus", "or", "our", "your", "my", "new", "official", "added", "add", "including", "include",
]);

// A first segment like "Best overall" or "Top pick" labels the item; the name follows the colon.
const LABEL_SEGMENT =
  /\b(best|top|pick|picks|choice|option|winner|runner[- ]up|recommend(?:ed|ation)?|overall|budget|premium|bonus|honou?rable|mention|alternative|editor'?s|added|new|also|for|if)\b|^#?\d+$/iu;

const SEGMENT_SEPARATOR = /\s[-\u2013\u2014]\s|:[*_]{0,3}\s|\s\|\s|\s\(/u;

function wordsOf(text: string): string[] {
  return text
    .replace(/[*_`~\[\]()"'\u201C\u201D\u2018\u2019]+/gu, " ")
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .split(/\s+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

/** Is everything before the mention (inside its segment) only harmless lead-in words? */
function isAnchored(prefix: string): boolean {
  const words = wordsOf(prefix);
  return words.length <= 2 && words.every((word) => LEAD_IN_WORDS.has(word));
}

type HeadVerdict = "subject" | "body" | "unclear";

interface Judgement {
  verdict: HeadVerdict;
  /** True when the item's head is essentially just the name (at most one further word). */
  nameOnly: boolean;
}

function judgeItem(text: string, item: Item, span: MatchSpan): Judgement {
  if (span.start < item.contentStart || span.start >= item.lineEnd) {
    // The mention sits on a continuation line of the item, not on its first line.
    return { verdict: "body", nameOnly: false };
  }

  if (item.kind === "table") {
    // The first cell that is not just a number names the row.
    let cursor = item.lineStart;
    for (const cell of text.slice(item.lineStart, item.lineEnd).split("|")) {
      const cellStart = cursor;
      const cellEnd = cursor + cell.length;
      cursor = cellEnd + 1;
      if (cell.trim() === "" || /^[\s#\d.)]+$/.test(cell)) continue;
      if (span.start >= cellStart && span.start < cellEnd) {
        const anchored = isAnchored(text.slice(cellStart, span.start));
        const after = wordsOf(text.slice(Math.min(span.end, cellEnd), cellEnd)).length;
        return { verdict: anchored ? "subject" : "unclear", nameOnly: anchored && after <= 1 };
      }
      break;
    }
    return { verdict: "body", nameOnly: false };
  }

  const firstLine = text.slice(item.contentStart, item.lineEnd);
  const offset = span.start - item.contentStart;

  // Split the first line into segments at " - ", ": ", " | " and " (".
  const segments: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const match of firstLine.matchAll(new RegExp(SEGMENT_SEPARATOR.source, "gu"))) {
    if (match.index === undefined) continue;
    segments.push({ start: cursor, end: match.index });
    cursor = match.index + match[0].length;
  }
  segments.push({ start: cursor, end: firstLine.length });

  let index = segments.findIndex((segment) => offset >= segment.start && offset < segment.end);
  if (index < 0) index = segments.length - 1;
  const segment = segments[index]!;
  const prefix = firstLine.slice(segment.start, offset);
  const after = wordsOf(firstLine.slice(Math.min(span.end - item.contentStart, segment.end), segment.end)).length;
  const anchored = isAnchored(prefix);

  if (index === 0) {
    return { verdict: anchored ? "subject" : "unclear", nameOnly: anchored && after <= 1 };
  }
  // A later segment still names the item when it follows a label ("Best overall: Legiit").
  const firstSegment = firstLine.slice(segments[0]!.start, segments[0]!.end).replace(/[*_`#]/g, "").trim();
  if (index === 1 && anchored && LABEL_SEGMENT.test(firstSegment)) {
    return { verdict: "subject", nameOnly: after <= 1 };
  }
  return { verdict: "body", nameOnly: false };
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

function listLength(items: Item[], listId: number): number {
  return items.filter((item) => item.listId === listId).length;
}

/** The innermost item whose text contains the offset. */
function enclosingItem(items: Item[], offset: number): Item | null {
  let best: Item | null = null;
  for (const item of items) {
    if (offset >= item.lineStart && offset < Math.max(item.bodyEnd, item.lineEnd)) {
      if (!best || item.lineStart >= best.lineStart) best = item;
    }
  }
  return best;
}

export function classifyResponse(text: string, target: DetectionTarget): Classification {
  const raw = text ?? "";
  const spans = findMentions(raw, target);
  const base = {
    detector_version: DETECTOR_VERSION,
    matched_spans: spans,
    rank: null,
    list_position: null,
  };

  if (spans.length === 0) {
    return {
      ...base,
      mentioned: false,
      inclusion: "not_mentioned",
      list_kind: "none",
      list_length: null,
      reason: "No match for the business name, aliases or domains.",
    };
  }

  const items = parseItems(raw);
  // Only lists with at least two items are treated as recommendation lists.
  const listSizes = new Map<number, number>();
  for (const item of items) listSizes.set(item.listId, (listSizes.get(item.listId) ?? 0) + 1);
  const realItems = items.filter((item) => (listSizes.get(item.listId) ?? 0) >= 2);

  let included: { item: Item; span: MatchSpan } | null = null;
  let unclear = false;
  let inOtherItem = false;

  // Evaluate every mention and keep the strongest finding. A domain or alias inside an item
  // that is already about the target does not weaken it.
  const subjectLines = new Set<number>();
  for (const span of spans) {
    const item = enclosingItem(realItems, span.start);
    if (!item) continue;
    const { verdict, nameOnly } = judgeItem(raw, item, span);
    if (verdict === "subject") {
      // Inside another item (a sub-point), only a bare name counts: "- Legiit" under a category
      // heading is a recommendation, "- Legiit integration" under another product is not.
      const nested = realItems.some(
        (other) =>
          other !== item &&
          other.kind !== "heading" &&
          other.kind !== "table" &&
          other.lineStart < item.lineStart &&
          item.lineStart < other.bodyEnd,
      );
      if (nested && !nameOnly) {
        unclear = true;
        continue;
      }
      subjectLines.add(item.lineStart);
      if (!included) included = { item, span };
    } else if (verdict === "unclear") {
      unclear = true;
    } else if (!subjectLines.has(item.lineStart)) {
      inOtherItem = true;
    }
  }

  if (included) {
    const { item } = included;
    const numbered = item.kind === "numbered" && item.number !== null;
    return {
      ...base,
      mentioned: true,
      inclusion: "included",
      rank: numbered ? item.number : null,
      list_position: numbered ? null : item.position,
      list_kind: numbered ? "numbered" : "bulleted",
      list_length: listLength(realItems, item.listId),
      reason: numbered
        ? `Named as item ${item.number} of a numbered list.`
        : `Named as item ${item.position} of an unranked list.`,
    };
  }

  const hasList = realItems.length > 0;
  const primaryKind: ListKind = !hasList
    ? "none"
    : realItems.some((item) => item.kind === "numbered")
      ? "numbered"
      : "bulleted";

  if (unclear || inOtherItem) {
    return {
      ...base,
      mentioned: true,
      inclusion: "ambiguous",
      list_kind: primaryKind,
      list_length: null,
      reason: unclear
        ? "Mentioned inside a list item, but not clearly as the item being recommended."
        : "Mentioned in the description of another list item.",
    };
  }

  if (!hasList) {
    return {
      ...base,
      mentioned: true,
      inclusion: "ambiguous",
      list_kind: "none",
      list_length: null,
      reason: "Mentioned, but the answer has no list to judge inclusion against.",
    };
  }

  return {
    ...base,
    mentioned: true,
    inclusion: "mentioned_only",
    list_kind: primaryKind,
    list_length: null,
    reason: "Mentioned outside the recommendation list.",
  };
}
