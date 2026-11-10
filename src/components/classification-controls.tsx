"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ActionButton } from "@/components/ui/action-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { correctClassification, runModelClassification } from "@/lib/actions/operations";

type Subject = "run_turn" | "fresh_check" | "manual_check";

/** Manual correction of a classification. The earlier classification stays in the history. */
export function CorrectClassificationButton({
  subjectType,
  subjectId,
  current,
}: {
  subjectType: Subject;
  subjectId: string;
  current: { inclusion: string | null; rank: number | null; listPosition: number | null };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [inclusion, setInclusion] = useState(
    current.inclusion && current.inclusion !== "ambiguous" ? current.inclusion : "",
  );
  const [position, setPosition] = useState<"none" | "rank" | "list">(
    current.rank ? "rank" : current.listPosition ? "list" : "none",
  );
  const [number, setNumber] = useState(String(current.rank ?? current.listPosition ?? ""));
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const value = Number(number);
  const numberOk =
    position === "none" || inclusion !== "included" || (Number.isInteger(value) && value >= 1);

  const save = () =>
    startTransition(async () => {
      const result = await correctClassification({
        subjectType,
        subjectId,
        inclusion,
        rank: inclusion === "included" && position === "rank" ? value : null,
        listPosition: inclusion === "included" && position === "list" ? value : null,
        note,
      });
      if (result.ok) {
        toast.success(result.message ?? "Classification corrected.");
        setOpen(false);
        setNote("");
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          Correct
        </Button>
      </DialogTrigger>
      <DialogContent
        size="sm"
        title="Correct this classification"
        description="Your correction replaces the current classification in every report. The earlier one, and who changed it, stay in the history."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={pending || !inclusion || !numberOk}
              aria-busy={pending}
            >
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              Save correction
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="The business is…" htmlFor={`cls-inclusion-${subjectId}`}>
            <Select
              id={`cls-inclusion-${subjectId}`}
              value={inclusion}
              onChange={(event) => setInclusion(event.target.value)}
            >
              <option value="" disabled>
                Choose…
              </option>
              <option value="included">Included as an item in the recommendation list</option>
              <option value="mentioned_only">Mentioned, but not as an item in the list</option>
              <option value="not_mentioned">Not mentioned</option>
            </Select>
          </Field>
          {inclusion === "included" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                label="Position in the list"
                htmlFor={`cls-position-${subjectId}`}
                hint="A rank is recorded only when the list itself is numbered."
              >
                <Select
                  id={`cls-position-${subjectId}`}
                  value={position}
                  onChange={(event) => setPosition(event.target.value as "none" | "rank" | "list")}
                >
                  <option value="none">Not recorded</option>
                  <option value="rank">Rank in a numbered list</option>
                  <option value="list">Position in an unranked list</option>
                </Select>
              </Field>
              {position !== "none" ? (
                <Field
                  label={position === "rank" ? "Rank" : "List position"}
                  htmlFor={`cls-number-${subjectId}`}
                  error={numberOk ? null : "Enter a whole number starting at 1."}
                >
                  <Input
                    id={`cls-number-${subjectId}`}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={number}
                    onChange={(event) => setNumber(event.target.value)}
                  />
                </Field>
              ) : null}
            </div>
          ) : null}
          <Field label="Note" htmlFor={`cls-note-${subjectId}`} optional hint="Why you changed it.">
            <Textarea
              id={`cls-note-${subjectId}`}
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={1000}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ModelClassificationButton({
  subjectType,
  subjectId,
}: {
  subjectType: Subject;
  subjectId: string;
}) {
  return (
    <ActionButton
      action={() => runModelClassification(subjectType, subjectId)}
      size="sm"
      variant="ghost"
      confirm={{
        title: "Classify this response with the model?",
        description:
          "One extra request is sent to the provider with this stored response and the business details, and its cost is recorded under Usage as model classification. It runs after the response was generated and is never part of a conversation or a fresh check.",
        confirmLabel: "Classify with model",
      }}
    >
      Classify with model
    </ActionButton>
  );
}
