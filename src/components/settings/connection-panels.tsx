"use client";

import { ExternalLink, KeyRound, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ActionButton } from "@/components/ui/action-button";
import {
  ActionForm,
  FormError,
  FormSubmit,
  SelectField,
  TextField,
  TextareaField,
} from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/form";
import {
  addModelPrice,
  archiveConnection,
  createConnection,
  declareDataSharing,
  setConnectionCredential,
  testConnection,
  updateConnection,
  verifyModel,
} from "@/lib/actions/settings";

export const DATA_CONTROLS_URL = "https://developers.openai.com/api/docs/guides/your-data";

function ModalForm({
  trigger,
  title,
  description,
  size = "md",
  children,
}: {
  trigger: ReactNode;
  title: string;
  description?: ReactNode;
  size?: "sm" | "md" | "lg";
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent title={title} description={description} size={size}>
        {children(() => setOpen(false))}
      </DialogContent>
    </Dialog>
  );
}

function FormFooter({ submit, variant }: { submit: string; variant?: "primary" | "danger" }) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <DialogClose asChild>
        <Button variant="secondary">Cancel</Button>
      </DialogClose>
      <FormSubmit variant={variant}>{submit}</FormSubmit>
    </div>
  );
}

interface Limits {
  name: string;
  dailyBudget: number | null;
  totalBudget: number | null;
  maxConcurrent: number;
  rpm: number | null;
  tpm: number | null;
  storeFreshChecks: boolean;
}

function LimitFields({ limits }: { limits?: Limits }) {
  return (
    <>
      <TextField
        name="name"
        label="Connection name"
        defaultValue={limits?.name ?? ""}
        required
        maxLength={80}
        hint="A label for your team, for example the OpenAI project it belongs to."
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          name="daily_budget_usd"
          label="Daily spending limit (USD)"
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          required
          defaultValue={limits?.dailyBudget ?? ""}
          hint="Per UTC day, across every campaign and tool using this connection."
        />
        <TextField
          name="total_budget_usd"
          label="Total spending limit (USD)"
          optional
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          defaultValue={limits?.totalBudget ?? ""}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <TextField
          name="max_concurrent_requests"
          label="Concurrent requests"
          type="number"
          inputMode="numeric"
          min={1}
          max={64}
          required
          defaultValue={limits?.maxConcurrent ?? ""}
        />
        <TextField
          name="requests_per_minute"
          label="Requests per minute"
          optional
          type="number"
          inputMode="numeric"
          min={1}
          defaultValue={limits?.rpm ?? ""}
        />
        <TextField
          name="tokens_per_minute"
          label="Tokens per minute"
          optional
          type="number"
          inputMode="numeric"
          min={1000}
          defaultValue={limits?.tpm ?? ""}
        />
      </div>
    </>
  );
}

export function NewConnectionButton({
  workspaceId,
  primary,
}: {
  workspaceId: string;
  primary?: boolean;
}) {
  return (
    <ModalForm
      trigger={
        <Button variant={primary ? "primary" : "secondary"}>
          <Plus className="size-4" aria-hidden="true" />
          Add connection
        </Button>
      }
      title="Add an OpenAI connection"
      description="Set the limits first. You add the API key in the next step."
    >
      {(close) => (
        <ActionForm action={createConnection} onSuccess={close} className="flex flex-col gap-4">
          <input type="hidden" name="workspace_id" value={workspaceId} />
          <LimitFields />
          <FormError />
          <FormFooter submit="Create connection" />
        </ActionForm>
      )}
    </ModalForm>
  );
}

export function EditConnectionButton({
  connectionId,
  limits,
}: {
  connectionId: string;
  limits: Limits;
}) {
  return (
    <ModalForm
      trigger={
        <Button variant="secondary" size="sm">
          Edit limits
        </Button>
      }
      title="Connection limits"
      description="Changes apply to requests reserved from now on."
    >
      {(close) => (
        <ActionForm action={updateConnection} onSuccess={close} className="flex flex-col gap-4">
          <input type="hidden" name="connection_id" value={connectionId} />
          <LimitFields limits={limits} />
          <label className="text-ink flex items-start gap-2.5 text-[13px]">
            <Checkbox
              name="store_fresh_check_responses"
              defaultChecked={limits.storeFreshChecks}
              className="mt-0.5"
            />
            <span>
              Store fresh-check responses at OpenAI
              <span className="text-ink-muted block text-xs">
                Conversations always store responses, because each turn continues from the previous
                response ID. Fresh checks are single requests, so storing them is optional; it only
                allows looking a response up by ID later.
              </span>
            </span>
          </label>
          <FormError />
          <FormFooter submit="Save limits" />
        </ActionForm>
      )}
    </ModalForm>
  );
}

export function CredentialButton({
  connectionId,
  hasKey,
}: {
  connectionId: string;
  hasKey: boolean;
}) {
  return (
    <ModalForm
      trigger={
        <Button variant={hasKey ? "secondary" : "primary"} size="sm">
          <KeyRound className="size-3.5" aria-hidden="true" />
          {hasKey ? "Replace API key" : "Add API key"}
        </Button>
      }
      title={hasKey ? "Replace the API key" : "Add the API key"}
      description="The key is checked against OpenAI, then stored encrypted in Supabase Vault. It is never shown again and never sent to a browser."
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={setConnectionCredential}
          onSuccess={close}
          className="flex flex-col gap-4"
        >
          <input type="hidden" name="connection_id" value={connectionId} />
          <TextField
            name="api_key"
            label="OpenAI API key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            hint="Use a project key limited to the models you plan to run."
          />
          {hasKey ? (
            <Callout tone="warn">
              The current key is replaced immediately. Work in progress continues with the new key.
            </Callout>
          ) : null}
          <FormError />
          <FormFooter submit="Verify and store" />
        </ActionForm>
      )}
    </ModalForm>
  );
}

export function TestConnectionButton({ connectionId }: { connectionId: string }) {
  return (
    <ActionButton action={() => testConnection(connectionId)} size="sm">
      Test connection
    </ActionButton>
  );
}

export function ArchiveConnectionButton({
  connectionId,
  name,
}: {
  connectionId: string;
  name: string;
}) {
  return (
    <ActionButton
      action={() => archiveConnection(connectionId)}
      size="sm"
      variant="outline-danger"
      confirm={{
        title: `Archive "${name}"?`,
        description:
          "Its stored API key is deleted. Campaigns that use it must be paused, finished or moved to another connection first.",
        confirmLabel: "Archive connection",
        destructive: true,
      }}
    >
      Archive
    </ActionButton>
  );
}

export function VerifyModelForm({
  connectionId,
  models,
}: {
  connectionId: string;
  models: { id: string; verified: boolean; shutdown: string | null; priced: boolean }[];
}) {
  return (
    <ActionForm
      action={verifyModel}
      className="grid grid-cols-1 items-start gap-3 sm:grid-cols-[minmax(0,1fr)_13rem_auto]"
    >
      <input type="hidden" name="connection_id" value={connectionId} />
      <SelectField
        name="model_id"
        label="Model"
        defaultValue=""
        hint="Only models this key can see are listed."
      >
        <option value="" disabled>
          Choose a model…
        </option>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.id}
            {model.verified ? " (verified)" : ""}
            {model.priced ? "" : " — no price recorded"}
            {model.shutdown ? ` — retires ${model.shutdown}` : ""}
          </option>
        ))}
      </SelectField>
      <TextField
        name="max_output_tokens"
        label="Largest output cap to verify"
        type="number"
        inputMode="numeric"
        min={16}
        required
        hint="Tokens per response."
      />
      <div className="sm:pt-[26px]">
        <FormSubmit>Verify model</FormSubmit>
      </div>
      {models.some((model) => !model.priced) ? (
        <p className="text-ink-muted text-xs sm:col-span-3">
          A model needs a price before it can be verified, because the cost of verification is
          reserved against the spending limit first. Add one under{" "}
          <a
            href="/settings?tab=pricing"
            className="text-brand hover:text-brand-strong font-medium"
          >
            Model pricing
          </a>
          .
        </p>
      ) : null}
      <p className="text-ink-muted text-xs sm:col-span-3">
        Verification sends a handful of very small real requests to learn which settings this model
        accepts (multi-turn chaining, reasoning effort, sampling, verbosity, output cap, background
        mode). Their cost is reserved against the daily limit first and listed under Usage.
      </p>
      <div className="sm:col-span-3">
        <FormError />
      </div>
    </ActionForm>
  );
}

export function DataSharingButton({
  connectionId,
  setting,
  verifiedOn,
  note,
}: {
  connectionId: string;
  setting: string;
  verifiedOn: string | null;
  note: string | null;
}) {
  return (
    <ModalForm
      trigger={
        <Button variant="secondary" size="sm">
          Update record
        </Button>
      }
      title="Record your OpenAI data-sharing setting"
      description={
        <>
          This is a record of what you saw in your OpenAI organization settings. It does not change
          anything at OpenAI.{" "}
          <a
            href={DATA_CONTROLS_URL}
            target="_blank"
            rel="noreferrer"
            className="text-brand hover:text-brand-strong inline-flex items-center gap-1 font-medium"
          >
            OpenAI data controls <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        </>
      }
    >
      {(close) => (
        <ActionForm action={declareDataSharing} onSuccess={close} className="flex flex-col gap-4">
          <input type="hidden" name="connection_id" value={connectionId} />
          <SelectField
            name="setting"
            label="Sharing inputs and outputs with OpenAI"
            defaultValue={setting}
          >
            <option value="unknown">Unknown — not checked</option>
            <option value="disabled">Disabled</option>
            <option value="enabled">Enabled</option>
          </SelectField>
          <TextField
            name="verified_on"
            label="Date you checked it"
            type="date"
            defaultValue={verifiedOn ?? ""}
          />
          <TextareaField
            name="note"
            label="Note"
            optional
            defaultValue={note ?? ""}
            maxLength={500}
            rows={2}
          />
          <FormError />
          <FormFooter submit="Save record" />
        </ActionForm>
      )}
    </ModalForm>
  );
}

export function AddPriceButton({
  workspaceId,
  modelIds,
}: {
  workspaceId: string;
  modelIds: string[];
}) {
  return (
    <ModalForm
      trigger={
        <Button variant="secondary">
          <Plus className="size-4" aria-hidden="true" />
          Add price version
        </Button>
      }
      title="Add a price version"
      description="Prices are per one million tokens, in US dollars, copied from the provider's price list. A new version applies to requests reserved from now on; earlier usage keeps the version it was recorded with."
      size="lg"
    >
      {(close) => (
        <ActionForm action={addModelPrice} onSuccess={close} className="flex flex-col gap-4">
          <input type="hidden" name="workspace_id" value={workspaceId} />
          <TextField
            name="model_id"
            label="Model ID"
            required
            list="known-model-ids"
            autoComplete="off"
            hint="Exactly as the provider returns it."
          />
          <datalist id="known-model-ids">
            {modelIds.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <TextField
              name="input_usd_per_mtok"
              label="Input"
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              required
            />
            <TextField
              name="cached_input_usd_per_mtok"
              label="Cached input"
              optional
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
            />
            <TextField
              name="output_usd_per_mtok"
              label="Output"
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              required
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField
              name="cache_write_30m_usd_per_mtok"
              label="Cache write, 30 minutes"
              optional
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
            />
            <TextField
              name="cache_write_12h_usd_per_mtok"
              label="Cache write, 12 hours"
              optional
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <TextField
              name="long_context_threshold_tokens"
              label="Long-context threshold (tokens)"
              optional
              type="number"
              inputMode="numeric"
              min={1}
            />
            <TextField
              name="long_context_input_multiplier"
              label="Long-context input ×"
              optional
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
            />
            <TextField
              name="long_context_output_multiplier"
              label="Long-context output ×"
              optional
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
            <TextField
              name="source_url"
              label="Source URL"
              type="url"
              required
              hint="The price list you copied these from."
            />
            <TextField name="verified_on" label="Checked on" type="date" required />
          </div>
          <TextareaField name="notes" label="Notes" optional rows={2} maxLength={500} />
          <FormError />
          <FormFooter submit="Save price version" />
        </ActionForm>
      )}
    </ModalForm>
  );
}
