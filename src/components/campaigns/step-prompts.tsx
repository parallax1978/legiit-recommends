"use client";

import { Library, X } from "lucide-react";
import { useMemo, useState } from "react";
import { AddPromptButton } from "@/components/library/prompt-dialogs";
import { PromptText } from "@/components/library/prompt-fields";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Checkbox, Input } from "@/components/ui/form";
import { templateKind } from "@/lib/labels";
import {
  renderTemplate,
  unresolvedVariables,
  type TemplateKind,
  type TemplateValues,
} from "@shared/core/templates.ts";

export interface LibraryTemplate {
  id: string;
  kind: TemplateKind;
  body: string;
  label: string | null;
  collection: string | null;
  archived: boolean;
}

function LibraryPicker({
  kind,
  templates,
  selected,
  onChange,
}: {
  kind: TemplateKind;
  templates: LibraryTemplate[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const options = templates.filter((template) => template.kind === kind && !template.archived);
  const shown = options.filter((template) => {
    const text =
      `${template.body} ${template.label ?? ""} ${template.collection ?? ""}`.toLowerCase();
    return !query.trim() || text.includes(query.trim().toLowerCase());
  });
  const toggle = (id: string, on: boolean) =>
    onChange(
      on ? [...selected.filter((item) => item !== id), id] : selected.filter((item) => item !== id),
    );
  const allShown = shown.length > 0 && shown.every((template) => selected.includes(template.id));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          <Library className="size-3.5" aria-hidden="true" />
          Choose from library
        </Button>
      </DialogTrigger>
      <DialogContent
        size="lg"
        title={`Choose ${templateKind(kind).plural.toLowerCase()}`}
        description="Each conversation uses one of the wordings you tick. Tick several to vary the wording between conversations."
        footer={<Button onClick={() => setOpen(false)}>Done</Button>}
      >
        {options.length === 0 ? (
          <p className="text-ink-muted text-[13px]">
            The library has no {templateKind(kind).plural.toLowerCase()} yet. Close this and use
            “Write new”.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search the library"
                className="max-w-xs"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const ids = shown.map((template) => template.id);
                  onChange(
                    allShown
                      ? selected.filter((id) => !ids.includes(id))
                      : [...selected.filter((id) => !ids.includes(id)), ...ids],
                  );
                }}
              >
                {allShown ? "Untick all shown" : "Tick all shown"}
              </Button>
              <span className="text-ink-muted ml-auto text-xs">
                {selected.filter((id) => options.some((template) => template.id === id)).length} of{" "}
                {options.length} ticked
              </span>
            </div>
            <ul className="divide-line border-line flex flex-col divide-y rounded-xl border">
              {shown.map((template) => (
                <li key={template.id}>
                  <label className="hover:bg-surface-alt flex cursor-pointer items-start gap-3 px-3 py-2.5">
                    <Checkbox
                      checked={selected.includes(template.id)}
                      onChange={(event) => toggle(template.id, event.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0 flex-1 text-[13px]">
                      <PromptText body={template.body} />
                      {template.label || template.collection ? (
                        <span className="text-ink-muted mt-0.5 block text-xs">
                          {[template.label, template.collection].filter(Boolean).join(" · ")}
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              ))}
              {shown.length === 0 ? (
                <li className="text-ink-muted px-3 py-6 text-center text-[13px]">
                  Nothing matches your search.
                </li>
              ) : null}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The wordings chosen for one conversation step, with rendered previews. */
export function StepPrompts({
  workspaceId,
  kind,
  title,
  selected,
  templates,
  values,
  collections,
  onChange,
  onCreated,
  problems,
}: {
  workspaceId: string;
  kind: TemplateKind;
  title: string;
  selected: string[];
  templates: LibraryTemplate[];
  values: TemplateValues;
  collections: string[];
  onChange: (ids: string[]) => void;
  onCreated: (template: LibraryTemplate) => void;
  problems: string[];
}) {
  const byId = useMemo(
    () => new Map(templates.map((template) => [template.id, template])),
    [templates],
  );
  const info = templateKind(kind);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-ink text-[13px] font-semibold">{title}</h3>
          <p className="text-ink-muted text-xs">{info.help}</p>
        </div>
        <span className="text-ink-muted text-xs">
          {selected.length} wording{selected.length === 1 ? "" : "s"}
        </span>
      </div>

      {selected.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {selected.map((id) => {
            const template = byId.get(id);
            if (!template) {
              return (
                <li
                  key={id}
                  className="bg-bad-soft flex items-center justify-between gap-3 rounded-xl border border-red-200 px-3 py-2 text-[13px]"
                >
                  <span>This prompt is no longer in the library.</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onChange(selected.filter((item) => item !== id))}
                  >
                    Remove
                  </Button>
                </li>
              );
            }
            const missing = unresolvedVariables(template.body, values);
            const rendered = renderTemplate(template.body, values);
            return (
              <li key={id} className="border-line rounded-xl border px-3 py-2.5">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1 text-[13px]">
                    <PromptText body={template.body} />
                    {template.archived ? (
                      <div className="mt-1">
                        <Badge tone="warn">Archived in the library</Badge>
                      </div>
                    ) : null}
                    {rendered !== template.body ? (
                      <p className="border-brand-soft text-ink-muted mt-1.5 border-l-2 pl-2.5 text-xs break-words whitespace-pre-wrap">
                        <span className="text-ink font-medium">Sent as: </span>
                        {rendered}
                      </p>
                    ) : null}
                    {missing.length > 0 ? (
                      <p className="text-bad mt-1.5 text-xs font-medium" role="alert">
                        Uses {missing.map((name) => `{{${name}}}`).join(", ")}, which{" "}
                        {missing.length === 1 ? "has" : "have"} no value yet.
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => onChange(selected.filter((item) => item !== id))}
                    className="text-ink-muted hover:bg-bad-soft hover:text-bad rounded-full p-1.5"
                    aria-label="Remove this wording from the step"
                  >
                    <X className="size-4" aria-hidden="true" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="border-line-strong text-ink-muted mt-3 rounded-xl border border-dashed px-3 py-4 text-center text-[13px]">
          No wording chosen for this step yet.
        </p>
      )}

      {problems.map((problem) => (
        <p key={problem} className="text-bad mt-2 text-xs font-medium" role="alert">
          {problem}
        </p>
      ))}

      <div className="mt-3 flex flex-wrap gap-2">
        <LibraryPicker kind={kind} templates={templates} selected={selected} onChange={onChange} />
        <AddPromptButton
          workspaceId={workspaceId}
          kind={kind}
          collections={collections}
          primary={false}
          label="Write new"
          onCreated={(ids, body) => {
            const id = ids[0];
            if (id) onCreated({ id, kind, body, label: null, collection: null, archived: false });
          }}
        />
      </div>
    </div>
  );
}
