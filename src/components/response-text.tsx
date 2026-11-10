import type { MatchSpan } from "@/lib/queries/types";

/** A response with the matched mentions of the business highlighted. The text itself is untouched. */
export function ResponseText({
  text,
  spans,
}: {
  text: string;
  spans: MatchSpan[] | null | undefined;
}) {
  const ordered = [...(spans ?? [])]
    .filter(
      (span) =>
        Number.isInteger(span.start) &&
        Number.isInteger(span.end) &&
        span.start >= 0 &&
        span.end > span.start &&
        span.end <= text.length,
    )
    .sort((a, b) => a.start - b.start);
  const parts: { text: string; span?: MatchSpan }[] = [];
  let cursor = 0;
  for (const span of ordered) {
    if (span.start < cursor) continue;
    if (span.start > cursor) parts.push({ text: text.slice(cursor, span.start) });
    parts.push({ text: text.slice(span.start, span.end), span });
    cursor = span.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });

  return (
    <div className="text-ink text-[13px] leading-relaxed break-words whitespace-pre-wrap">
      {parts.map((part, index) =>
        part.span ? (
          <mark
            key={index}
            className="bg-brand-soft text-ink rounded px-0.5 font-medium"
            title={`Matched ${part.span.kind.replace("_", " ")}: ${part.span.term}`}
          >
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </div>
  );
}
