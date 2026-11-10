"use client";

import { useRef, type ReactNode } from "react";
import { Label, Textarea } from "@/components/ui/form";
import { cn } from "@/lib/cn";
import {
  VARIABLE_LABELS,
  allowedVariables,
  extractVariables,
  templateProblem,
  type TemplateKind,
  type TemplateVariable,
} from "@shared/core/templates.ts";

/** Renders a prompt with its {{variables}} highlighted. */
export function PromptText({ body, className }: { body: string; className?: string }) {
  const parts = body.split(/(\{\{[^{}]*\}\})/g);
  return (
    <span className={cn("break-words whitespace-pre-wrap", className)}>
      {parts.map((part, index) =>
        /^\{\{[^{}]*\}\}$/.test(part) ? (
          <span
            key={index}
            className="bg-brand-faint text-brand-strong rounded px-1 font-mono text-[0.92em]"
          >
            {part}
          </span>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </span>
  );
}

/**
 * Prompt text area with buttons that insert the variables allowed for this kind of prompt, and
 * live validation using the same rules the database applies.
 */
export function PromptEditor({
  id,
  kind,
  value,
  onChange,
  label = "Prompt text",
  rows = 4,
  hint,
  autoFocus,
}: {
  id: string;
  kind: TemplateKind;
  value: string;
  onChange: (value: string) => void;
  label?: ReactNode;
  rows?: number;
  hint?: ReactNode;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const problem = value.trim() ? templateProblem(value, kind) : null;
  const used = extractVariables(value);

  const insert = (variable: TemplateVariable) => {
    const element = ref.current;
    const token = `{{${variable}}}`;
    if (!element) {
      onChange(value + token);
      return;
    }
    const start = element.selectionStart ?? value.length;
    const end = element.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        ref={ref}
        id={id}
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(problem)}
        aria-describedby={`${id}-help`}
        maxLength={4000}
        autoFocus={autoFocus}
      />
      <div className="flex flex-wrap items-center gap-1.5" aria-label="Insert a variable">
        <span className="text-ink-muted text-xs">Insert:</span>
        {allowedVariables(kind).map((variable) => (
          <button
            key={variable}
            type="button"
            onClick={() => insert(variable)}
            title={VARIABLE_LABELS[variable]}
            className={cn(
              "rounded-md border px-1.5 py-0.5 font-mono text-[11px] transition-colors",
              used.includes(variable)
                ? "border-brand-soft bg-brand-faint text-brand-strong"
                : "border-line-strong text-ink-muted hover:border-brand hover:text-brand-strong",
            )}
          >
            {`{{${variable}}}`}
          </button>
        ))}
      </div>
      <p
        id={`${id}-help`}
        className={cn("text-xs", problem ? "text-bad font-medium" : "text-ink-muted")}
        role={problem ? "alert" : undefined}
      >
        {problem ??
          hint ??
          (kind === "fresh_check"
            ? "Fresh-check questions cannot name the business: no business name or website variable is available here."
            : "Variables are replaced with the campaign's values when a conversation runs.")}
      </p>
    </div>
  );
}
