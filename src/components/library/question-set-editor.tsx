"use client";

import { Loader2, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { ActionButton } from "@/components/ui/action-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/form";
import { saveProbeSet, setProbeSetArchived } from "@/lib/actions/library";
import { VARIABLE_LABELS, allowedVariables, templateProblem } from "@shared/core/templates.ts";

interface Question {
  body: string;
  is_held_out: boolean;
}

export interface QuestionSetValue {
  id: string;
  name: string;
  description: string;
  questions: Question[];
}

export function QuestionSetButton({
  workspaceId,
  set,
  trigger,
}: {
  workspaceId: string;
  set?: QuestionSetValue;
  trigger: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(set?.name ?? "");
  const [description, setDescription] = useState(set?.description ?? "");
  const [questions, setQuestions] = useState<Question[]>(
    set?.questions.length ? set.questions : [{ body: "", is_held_out: false }],
  );
  const [bulk, setBulk] = useState("");
  const [pending, startTransition] = useTransition();

  const filled = questions.filter((question) => question.body.trim());
  const problems = questions.map((question) =>
    question.body.trim() ? templateProblem(question.body, "fresh_check") : null,
  );
  const regular = filled.filter((question) => !question.is_held_out).length;
  const canSave =
    name.trim().length > 0 &&
    filled.length > 0 &&
    regular > 0 &&
    problems.every((problem) => !problem);

  const update = (index: number, patch: Partial<Question>) =>
    setQuestions((current) =>
      current.map((question, i) => (i === index ? { ...question, ...patch } : question)),
    );

  const save = () =>
    startTransition(async () => {
      const result = await saveProbeSet({
        workspaceId,
        probeSetId: set?.id ?? null,
        name,
        description,
        questions: filled,
      });
      if (result.ok) {
        if (result.message) toast.success(result.message);
        setOpen(false);
        if (!set) {
          setName("");
          setDescription("");
          setQuestions([{ body: "", is_held_out: false }]);
        }
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        size="xl"
        title={set ? "Edit question set" : "New fresh-check question set"}
        description="Each question is sent on its own, with no conversation history, no instructions and no mention of the business. The answers show whether the business appears unprompted."
        footer={
          <>
            <p className="text-ink-muted mr-auto text-xs">
              {filled.length} question{filled.length === 1 ? "" : "s"} · {filled.length - regular}{" "}
              held out
            </p>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={save} disabled={pending || !canSave} aria-busy={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              Save question set
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="set-name">
              <Input
                id="set-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
              />
            </Field>
            <Field label="Description" htmlFor="set-description" optional>
              <Input
                id="set-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={500}
              />
            </Field>
          </div>

          <div>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-ink text-[13px] font-semibold">Questions</h3>
              <p className="text-ink-muted text-xs">
                Available variables:{" "}
                {allowedVariables("fresh_check").map((variable) => (
                  <span
                    key={variable}
                    className="bg-surface-sunken mr-1 rounded px-1 font-mono"
                    title={VARIABLE_LABELS[variable]}
                  >{`{{${variable}}}`}</span>
                ))}
              </p>
            </div>
            <ul className="flex flex-col gap-3">
              {questions.map((question, index) => (
                <li key={index} className="border-line rounded-xl border p-3">
                  <div className="flex items-start gap-3">
                    <span className="tabular text-ink-muted mt-2 w-5 shrink-0 text-right text-xs">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <Textarea
                        rows={2}
                        value={question.body}
                        aria-label={`Question ${index + 1}`}
                        aria-invalid={Boolean(problems[index])}
                        onChange={(event) => update(index, { body: event.target.value })}
                        maxLength={4000}
                      />
                      {problems[index] ? (
                        <p className="text-bad mt-1 text-xs font-medium" role="alert">
                          {problems[index]}
                        </p>
                      ) : null}
                      <label className="text-ink mt-2 flex items-center gap-2 text-xs">
                        <Checkbox
                          checked={question.is_held_out}
                          onChange={(event) => update(index, { is_held_out: event.target.checked })}
                        />
                        Held-out question
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setQuestions((current) =>
                          current.length === 1
                            ? [{ body: "", is_held_out: false }]
                            : current.filter((_, i) => i !== index),
                        )
                      }
                      className="text-ink-muted hover:bg-bad-soft hover:text-bad rounded-full p-2"
                      aria-label={`Remove question ${index + 1}`}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setQuestions((current) => [...current, { body: "", is_held_out: false }])
                }
                disabled={questions.length >= 200}
              >
                <Plus className="size-3.5" aria-hidden="true" />
                Add question
              </Button>
            </div>
            <p className="text-ink-muted mt-3 text-xs">
              Held-out questions are reported separately and must not match any wording a campaign
              uses as its initial question, so they measure questions the campaign never asked. At
              least one question must be a regular question.
            </p>
          </div>

          <details className="border-line rounded-xl border px-4 py-3">
            <summary className="text-ink cursor-pointer text-[13px] font-medium">
              Paste several questions at once
            </summary>
            <div className="mt-3 flex flex-col gap-2">
              <Textarea
                rows={5}
                value={bulk}
                onChange={(event) => setBulk(event.target.value)}
                aria-label="Questions, one per line"
                placeholder="One question per line"
              />
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!bulk.trim()}
                  onClick={() => {
                    const added = bulk
                      .split(/\r?\n/)
                      .map((line) => line.trim())
                      .filter(Boolean)
                      .map((body) => ({ body, is_held_out: false }));
                    setQuestions((current) =>
                      [...current.filter((question) => question.body.trim()), ...added].slice(
                        0,
                        200,
                      ),
                    );
                    setBulk("");
                  }}
                >
                  Add these questions
                </Button>
              </div>
            </div>
          </details>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ArchiveQuestionSetButton({ id, archived }: { id: string; archived: boolean }) {
  return (
    <ActionButton
      action={() => setProbeSetArchived(id, !archived)}
      size="sm"
      variant={archived ? "secondary" : "ghost"}
    >
      {archived ? "Restore" : "Archive"}
    </ActionButton>
  );
}
