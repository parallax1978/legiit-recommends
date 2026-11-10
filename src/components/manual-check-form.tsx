"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { ActionButton } from "@/components/ui/action-button";
import {
  ActionForm,
  FormError,
  FormSubmit,
  TextField,
  TextareaField,
} from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { deleteManualCheck, recordManualCheck } from "@/lib/actions/operations";

export function ManualCheckButton({ campaignId }: { campaignId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <Plus className="size-4" aria-hidden="true" />
          Record an observation
        </Button>
      </DialogTrigger>
      <DialogContent
        size="lg"
        title="Record a manual observation"
        description="For a response you saw yourself outside the API, for example in a ChatGPT app. It is kept as a separate, labelled dataset and never mixed into the API results."
      >
        <ActionForm
          action={recordManualCheck}
          onSuccess={() => setOpen(false)}
          className="flex flex-col gap-4"
        >
          <input type="hidden" name="campaign_id" value={campaignId} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <TextField name="observed_on" label="Date observed" type="date" required />
            <TextField
              name="source_label"
              label="Source"
              required
              maxLength={120}
              hint="Where you saw it: the app, plan and model shown."
            />
          </div>
          <TextareaField
            name="question"
            label="Question asked"
            optional
            rows={2}
            maxLength={4000}
          />
          <TextareaField
            name="response_text"
            label="Response"
            required
            rows={8}
            hint="Paste the full answer. It is classified with the same rules as API responses, and you can correct that afterwards."
          />
          <FormError />
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <FormSubmit>Record observation</FormSubmit>
          </div>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteManualCheckButton({ id }: { id: string }) {
  return (
    <ActionButton
      action={() => deleteManualCheck(id)}
      size="sm"
      variant="ghost"
      confirm={{
        title: "Delete this observation?",
        description: "The recorded response and its classification are deleted permanently.",
        confirmLabel: "Delete observation",
        destructive: true,
      }}
    >
      Delete
    </ActionButton>
  );
}
