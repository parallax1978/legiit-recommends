"use client";

import { Download, FileUp, Loader2, MoreHorizontal, Pencil, Plus, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Callout } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  Dialog,
  DialogContent,
  DialogTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from "@/components/ui/dialog";
import { Checkbox, Field, Input, Label, Select, Textarea } from "@/components/ui/form";
import {
  createTemplates,
  deleteTemplate,
  generateVariations,
  parsePromptImport,
  setTemplatesArchived,
  updateTemplate,
  type GenerationResult,
} from "@/lib/actions/library";
import { templateKind } from "@/lib/labels";
import type { ActionResult } from "@/lib/result";
import { templateProblem, type TemplateKind } from "@shared/core/templates.ts";
import { PromptEditor } from "./prompt-fields";

function useAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const run = <T,>(
    action: () => Promise<ActionResult<T>>,
    onOk?: (result: ActionResult<T> & { ok: true }) => void,
  ) => {
    startTransition(async () => {
      let result: ActionResult<T>;
      try {
        result = await action();
      } catch {
        result = {
          ok: false,
          message: "The request could not be completed. Check your connection and try again.",
        };
      }
      if (result.ok) {
        if (result.message) toast.success(result.message);
        onOk?.(result);
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  };
  return { pending, run };
}

const Spinner = ({ show }: { show: boolean }) =>
  show ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null;

function CollectionField({
  id,
  value,
  onChange,
  collections,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  collections: string[];
}) {
  return (
    <Field label="Collection" htmlFor={id} optional hint="A tag for grouping related wordings.">
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxLength={120}
        list={`${id}-options`}
        autoComplete="off"
      />
      <datalist id={`${id}-options`}>
        {collections.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </Field>
  );
}

export function AddPromptButton({
  workspaceId,
  kind,
  collections,
  primary = true,
  onCreated,
  label,
}: {
  workspaceId: string;
  kind: TemplateKind;
  collections: string[];
  primary?: boolean;
  onCreated?: (ids: string[], body: string) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [name, setName] = useState("");
  const [collection, setCollection] = useState("");
  const { pending, run } = useAction();
  const info = templateKind(kind);
  const invalid = !body.trim() || Boolean(templateProblem(body, kind));

  const save = (keepOpen: boolean) =>
    run(
      () => createTemplates({ workspaceId, kind, items: [{ body, label: name }], collection }),
      (result) => {
        onCreated?.(result.data ?? [], body.trim());
        setBody("");
        setName("");
        if (!keepOpen) setOpen(false);
      },
    );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={primary ? "primary" : "secondary"} size={primary ? "md" : "sm"}>
          <Plus className="size-4" aria-hidden="true" />
          {label ?? "Add prompt"}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Add ${info.label.toLowerCase()}`}
        description={info.help}
        footer={
          <>
            <Button variant="secondary" disabled={pending || invalid} onClick={() => save(true)}>
              Save and add another
            </Button>
            <Button disabled={pending || invalid} aria-busy={pending} onClick={() => save(false)}>
              <Spinner show={pending} />
              Save prompt
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <PromptEditor
            id="new-prompt-body"
            kind={kind}
            value={body}
            onChange={setBody}
            autoFocus
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Label"
              htmlFor="new-prompt-label"
              optional
              hint="A short name for your own reference."
            >
              <Input
                id="new-prompt-label"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
              />
            </Field>
            <CollectionField
              id="new-prompt-collection"
              value={collection}
              onChange={setCollection}
              collections={collections}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface PromptRow {
  id: string;
  kind: TemplateKind;
  body: string;
  label: string | null;
  collection: string | null;
  archived: boolean;
  inUse: boolean;
}

export function PromptRowActions({
  prompt,
  collections,
}: {
  prompt: PromptRow;
  collections: string[];
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [body, setBody] = useState(prompt.body);
  const [name, setName] = useState(prompt.label ?? "");
  const [collection, setCollection] = useState(prompt.collection ?? "");
  const { pending, run } = useAction();
  const invalid = !body.trim() || Boolean(templateProblem(body, prompt.kind));

  return (
    <>
      <Menu>
        <MenuTrigger
          className="text-ink-muted hover:bg-surface-sunken hover:text-ink rounded-full p-1.5"
          aria-label="Prompt actions"
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </MenuTrigger>
        <MenuContent>
          <MenuItem
            onSelect={() => {
              setBody(prompt.body);
              setName(prompt.label ?? "");
              setCollection(prompt.collection ?? "");
              setEditing(true);
            }}
          >
            <Pencil className="text-ink-muted size-4" aria-hidden="true" />
            Edit
          </MenuItem>
          <MenuItem onSelect={() => run(() => setTemplatesArchived([prompt.id], !prompt.archived))}>
            {prompt.archived ? "Restore" : "Archive"}
          </MenuItem>
          <MenuItem destructive disabled={prompt.inUse} onSelect={() => setDeleting(true)}>
            Delete{prompt.inUse ? " (in use)" : ""}
          </MenuItem>
        </MenuContent>
      </Menu>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent
          title={`Edit ${templateKind(prompt.kind).label.toLowerCase()}`}
          description="Saving changed text creates a new version. Campaigns that already launched keep the version they started with; apply changes to a campaign to move it to the new one."
          footer={
            <>
              <Button variant="secondary" onClick={() => setEditing(false)} disabled={pending}>
                Cancel
              </Button>
              <Button
                disabled={pending || invalid}
                aria-busy={pending}
                onClick={() =>
                  run(
                    () =>
                      updateTemplate({
                        templateId: prompt.id,
                        kind: prompt.kind,
                        body,
                        label: name,
                        collection,
                      }),
                    () => setEditing(false),
                  )
                }
              >
                <Spinner show={pending} />
                Save
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <PromptEditor
              id={`edit-${prompt.id}`}
              kind={prompt.kind}
              value={body}
              onChange={setBody}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Label" htmlFor={`edit-label-${prompt.id}`} optional>
                <Input
                  id={`edit-label-${prompt.id}`}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={120}
                />
              </Field>
              <CollectionField
                id={`edit-collection-${prompt.id}`}
                value={collection}
                onChange={setCollection}
                collections={collections}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent
          title="Delete this prompt?"
          description="It is removed from the library permanently. Prompts that a campaign has used cannot be deleted, only archived."
          footer={
            <>
              <AlertDialogCancel asChild>
                <Button variant="secondary" disabled={pending}>
                  Cancel
                </Button>
              </AlertDialogCancel>
              <Button
                variant="danger"
                disabled={pending}
                onClick={() =>
                  run(
                    () => deleteTemplate(prompt.id),
                    () => setDeleting(false),
                  )
                }
              >
                <Spinner show={pending} />
                Delete prompt
              </Button>
            </>
          }
        />
      </AlertDialog>
    </>
  );
}

interface ImportRow {
  body: string;
  label: string | null;
  problem: string | null;
}

export function ImportCsvButton({
  workspaceId,
  kind,
  collections,
}: {
  workspaceId: string;
  kind: TemplateKind;
  collections: string[];
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [collection, setCollection] = useState("");
  const { pending, run } = useAction();
  const valid = (rows ?? []).filter((row) => !row.problem);

  const reset = () => {
    setText("");
    setRows(null);
    setCollection("");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary">
          <FileUp className="size-4" aria-hidden="true" />
          Import CSV
        </Button>
      </DialogTrigger>
      <DialogContent
        size="lg"
        title={`Import ${templateKind(kind).plural.toLowerCase()} from CSV`}
        description='One prompt per row. With a header row, the "body" column is the prompt and an optional "label" column names it; without a header, the first column is used.'
        footer={
          rows ? (
            <>
              <Button variant="secondary" onClick={() => setRows(null)} disabled={pending}>
                Back
              </Button>
              <Button
                disabled={pending || valid.length === 0}
                aria-busy={pending}
                onClick={() =>
                  run(
                    () =>
                      createTemplates({
                        workspaceId,
                        kind,
                        items: valid.map((row) => ({ body: row.body, label: row.label })),
                        collection,
                        source: "csv_import",
                        skipDuplicates: true,
                      }),
                    () => {
                      setOpen(false);
                      reset();
                    },
                  )
                }
              >
                <Spinner show={pending} />
                Import {valid.length} prompt{valid.length === 1 ? "" : "s"}
              </Button>
            </>
          ) : (
            <Button
              disabled={pending || !text.trim()}
              aria-busy={pending}
              onClick={() =>
                run(
                  () => parsePromptImport(kind, text),
                  (result) => setRows(result.data ?? []),
                )
              }
            >
              <Spinner show={pending} />
              Review rows
            </Button>
          )
        }
      >
        {rows ? (
          <div className="flex flex-col gap-4">
            <p className="text-ink-muted text-[13px]">
              {valid.length} of {rows.length} rows can be imported. Rows with a problem are skipped,
              and so are prompts that are already in the library.
            </p>
            <div className="border-line max-h-80 overflow-auto rounded-xl border">
              <table className="w-full border-collapse text-left text-[13px]">
                <thead>
                  <tr>
                    <th
                      scope="col"
                      className="border-line bg-surface-alt text-ink-muted sticky top-0 w-10 border-b px-3 py-2 text-xs font-semibold"
                    >
                      #
                    </th>
                    <th
                      scope="col"
                      className="border-line bg-surface-alt text-ink-muted sticky top-0 border-b px-3 py-2 text-xs font-semibold"
                    >
                      Prompt
                    </th>
                    <th
                      scope="col"
                      className="border-line bg-surface-alt text-ink-muted sticky top-0 w-48 border-b px-3 py-2 text-xs font-semibold"
                    >
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={index} className="border-line border-b align-top last:border-b-0">
                      <td className="tabular text-ink-muted px-3 py-2">{index + 1}</td>
                      <td className="px-3 py-2 break-words whitespace-pre-wrap">
                        {row.body}
                        {row.label ? (
                          <span className="text-ink-muted block text-xs">Label: {row.label}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        {row.problem ? (
                          <span className="text-bad text-xs font-medium">{row.problem}</span>
                        ) : (
                          <Badge tone="good">Ready</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <CollectionField
              id="import-collection"
              value={collection}
              onChange={setCollection}
              collections={collections}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="import-file">CSV file</Label>
              <input
                id="import-file"
                type="file"
                accept=".csv,text/csv,text/plain"
                className="text-ink-muted file:border-line-strong file:bg-surface file:text-ink hover:file:bg-surface-alt block w-full text-[13px] file:mr-3 file:rounded-full file:border file:px-3 file:py-1.5 file:text-xs file:font-semibold"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (file.size > 2_000_000) {
                    toast.error("The file is larger than 2 MB.");
                    return;
                  }
                  void file.text().then(setText);
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="import-text">Or paste CSV text</Label>
              <Textarea
                id="import-text"
                rows={7}
                value={text}
                onChange={(event) => setText(event.target.value)}
                className="font-mono text-xs"
                spellCheck={false}
              />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export interface GeneratorModel {
  connectionId: string;
  connectionName: string;
  model: string;
}

export function GenerateButton({
  workspaceId,
  kind,
  models,
  examples,
  collections,
}: {
  workspaceId: string;
  kind: TemplateKind;
  models: GeneratorModel[];
  examples: string[];
  collections: string[];
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState("");
  const [count, setCount] = useState("");
  const [guidance, setGuidance] = useState("");
  const [category, setCategory] = useState("");
  const [location, setLocation] = useState("");
  const [language, setLanguage] = useState("");
  const [useExamples, setUseExamples] = useState(false);
  const [collection, setCollection] = useState("");
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [candidates, setCandidates] = useState<{ text: string; keep: boolean }[]>([]);
  const { pending, run } = useAction();
  const info = templateKind(kind);
  const selected = models.find((model) => `${model.connectionId}|${model.model}` === choice);
  const countNumber = Number(count);
  const canGenerate =
    Boolean(selected) && Number.isInteger(countNumber) && countNumber >= 1 && countNumber <= 50;
  const keep = candidates.filter(
    (candidate) =>
      candidate.keep && candidate.text.trim() && !templateProblem(candidate.text, kind),
  );

  const reset = () => {
    setResult(null);
    setCandidates([]);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary">
          <Sparkles className="size-4" aria-hidden="true" />
          Generate variations
        </Button>
      </DialogTrigger>
      <DialogContent
        size="lg"
        title={`Generate ${info.plural.toLowerCase()}`}
        description="Optional. One request is sent to the provider when you choose Generate; its usage and cost are recorded under Usage. Nothing is added to the library until you review and save."
        footer={
          result ? (
            <>
              <Button variant="secondary" onClick={reset} disabled={pending}>
                Start over
              </Button>
              <Button
                disabled={pending || keep.length === 0}
                aria-busy={pending}
                onClick={() =>
                  run(
                    () =>
                      createTemplates({
                        workspaceId,
                        kind,
                        items: keep.map((candidate) => ({ body: candidate.text })),
                        collection,
                        source: "ai_generated",
                        generationId: result.generation_id,
                        skipDuplicates: true,
                      }),
                    () => {
                      setOpen(false);
                      reset();
                    },
                  )
                }
              >
                <Spinner show={pending} />
                Save {keep.length} to library
              </Button>
            </>
          ) : (
            <Button
              disabled={pending || !canGenerate}
              aria-busy={pending}
              onClick={() =>
                run(
                  () =>
                    generateVariations({
                      workspaceId,
                      connectionId: selected!.connectionId,
                      model: selected!.model,
                      kind,
                      count: countNumber,
                      guidance,
                      examples: useExamples ? examples.slice(0, 20) : [],
                      values: { category, location, language },
                    }),
                  (outcome) => {
                    if (!outcome.data) return;
                    setResult(outcome.data);
                    setCandidates(outcome.data.candidates.map((text) => ({ text, keep: true })));
                  },
                )
              }
            >
              <Spinner show={pending} />
              Generate
            </Button>
          )
        }
      >
        {result ? (
          <div className="flex flex-col gap-4">
            {result.truncated ? (
              <Callout tone="warn">
                The model reached its output limit, so fewer variations than requested came back.
              </Callout>
            ) : null}
            <p className="text-ink-muted text-[13px]">
              Edit any wording and untick the ones you do not want. Only ticked, valid prompts are
              saved.
            </p>
            <ul className="flex flex-col gap-3">
              {candidates.map((candidate, index) => {
                const problem = candidate.text.trim()
                  ? templateProblem(candidate.text, kind)
                  : "The prompt text is empty.";
                return (
                  <li key={index} className="flex items-start gap-3">
                    <Checkbox
                      checked={candidate.keep}
                      onChange={(event) =>
                        setCandidates((current) =>
                          current.map((item, i) =>
                            i === index ? { ...item, keep: event.target.checked } : item,
                          ),
                        )
                      }
                      aria-label={`Keep variation ${index + 1}`}
                      className="mt-2.5"
                    />
                    <div className="min-w-0 flex-1">
                      <Textarea
                        rows={2}
                        value={candidate.text}
                        aria-label={`Variation ${index + 1}`}
                        aria-invalid={Boolean(problem)}
                        onChange={(event) =>
                          setCandidates((current) =>
                            current.map((item, i) =>
                              i === index ? { ...item, text: event.target.value } : item,
                            ),
                          )
                        }
                      />
                      {problem ? (
                        <p className="text-bad mt-1 text-xs font-medium">{problem}</p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
            {result.rejected.length > 0 ? (
              <details className="border-line rounded-xl border px-4 py-3 text-[13px]">
                <summary className="text-ink cursor-pointer font-medium">
                  {result.rejected.length} suggestion
                  {result.rejected.length === 1 ? " was" : "s were"} discarded automatically
                </summary>
                <ul className="text-ink-muted mt-2 flex flex-col gap-2">
                  {result.rejected.map((item, index) => (
                    <li key={index}>
                      <span className="break-words">{item.text}</span>{" "}
                      <span className="text-bad text-xs">— {item.reason}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <CollectionField
              id="generate-collection"
              value={collection}
              onChange={setCollection}
              collections={collections}
            />
          </div>
        ) : models.length === 0 ? (
          <Callout tone="warn">
            Generation needs a connected OpenAI key and a verified model. An owner can set these up
            under Settings → OpenAI connections.
          </Callout>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <Field label="Connection and model" htmlFor="generate-model">
                <Select
                  id="generate-model"
                  value={choice}
                  onChange={(event) => setChoice(event.target.value)}
                >
                  <option value="" disabled>
                    Choose a verified model…
                  </option>
                  {models.map((model) => (
                    <option
                      key={`${model.connectionId}|${model.model}`}
                      value={`${model.connectionId}|${model.model}`}
                    >
                      {model.model} — {model.connectionName}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="How many" htmlFor="generate-count" hint="1 to 50.">
                <Input
                  id="generate-count"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={50}
                  value={count}
                  onChange={(event) => setCount(event.target.value)}
                />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Category or topic" htmlFor="generate-category" optional>
                <Input
                  id="generate-category"
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  maxLength={300}
                />
              </Field>
              <Field label="Market or location" htmlFor="generate-location" optional>
                <Input
                  id="generate-location"
                  value={location}
                  onChange={(event) => setLocation(event.target.value)}
                  maxLength={200}
                />
              </Field>
              <Field label="Language" htmlFor="generate-language" optional>
                <Input
                  id="generate-language"
                  value={language}
                  onChange={(event) => setLanguage(event.target.value)}
                  maxLength={80}
                />
              </Field>
            </div>
            <p className="text-ink-muted -mt-2 text-xs">
              These describe the context to the model. Generated wordings keep the variables (such
              as {"{{category}}"}), so they work for any campaign. The business name and website are
              never sent.
            </p>
            <Field
              label="Guidance"
              htmlFor="generate-guidance"
              optional
              hint="Tone, length or style you want."
            >
              <Textarea
                id="generate-guidance"
                rows={2}
                value={guidance}
                onChange={(event) => setGuidance(event.target.value)}
                maxLength={500}
              />
            </Field>
            {examples.length > 0 ? (
              <label className="text-ink flex items-start gap-2.5 text-[13px]">
                <Checkbox
                  checked={useExamples}
                  onChange={(event) => setUseExamples(event.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Show the model my existing {info.plural.toLowerCase()} as style examples
                  <span className="text-ink-muted block text-xs">
                    Up to 20 of the {examples.length} in the library are sent with the request.
                  </span>
                </span>
              </label>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ExportPromptsLink({ kind }: { kind: TemplateKind }) {
  return (
    <a
      href={`/exports/library?kind=${kind}`}
      className="border-line-strong bg-surface text-ink hover:bg-surface-alt inline-flex h-9 items-center gap-2 rounded-full border px-4 text-sm font-semibold"
      download
    >
      <Download className="size-4" aria-hidden="true" />
      Export CSV
    </a>
  );
}
