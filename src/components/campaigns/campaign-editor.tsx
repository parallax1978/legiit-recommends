"use client";

import { ChevronLeft, ChevronRight, Loader2, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  useTransition,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/card";
import {
  Checkbox,
  Disclosure,
  Field,
  FormSection,
  Input,
  Select,
  Textarea,
} from "@/components/ui/form";
import { actionFailure, toastFailure } from "@/lib/action-failure";
import {
  saveCampaignDraft,
  type CampaignDraftInput,
  type DraftSaved,
} from "@/lib/actions/campaigns";
import { cn } from "@/lib/cn";
import { WEEKDAYS, formatNumber, formatUsd } from "@/lib/format";
import { templateKind } from "@/lib/labels";
import type { LaunchCheck, PlanPreview, Problem } from "@/lib/queries/types";
import { listTimeZones } from "@/lib/timezone";
import type { CapabilityProfile } from "@shared/core/capabilities.ts";
import { selectCombination, totalCombinations } from "@shared/core/selection.ts";
import { renderTemplate, type TemplateKind, type TemplateValues } from "@shared/core/templates.ts";
import { StepPrompts, type LibraryTemplate } from "./step-prompts";

export interface EditorModel {
  connectionId: string;
  model: string;
  capabilities: CapabilityProfile;
  priced: boolean;
  listed: boolean;
}

export interface EditorData {
  workspaceId: string;
  campaign: { id: string; status: string; launched: boolean; started: boolean };
  initial: CampaignDraftInput;
  templates: LibraryTemplate[];
  connections: { id: string; name: string; status: string; maxConcurrent: number }[];
  models: EditorModel[];
  probeSets: { id: string; name: string; questions: number; heldOut: number; archived: boolean }[];
  check: LaunchCheck;
  preview: PlanPreview;
  /** Show the launch checklist's problems next to their fields straight away. */
  showProblems: boolean;
}

const SECTIONS = [
  { id: "basics", label: "Basics" },
  { id: "business", label: "Business" },
  { id: "conversation", label: "Conversation" },
  { id: "model", label: "Model" },
  { id: "schedule", label: "Schedule" },
  { id: "checks", label: "Fresh checks" },
  { id: "budgets", label: "Budgets" },
] as const;

/** Which section a problem reported by the server belongs to. */
function sectionOf(field: string | null): string {
  if (!field) return "basics";
  if (["business_name", "website_url", "category", "language", "location"].includes(field))
    return "business";
  if (field.startsWith("steps") || field === "on_existing_inclusion") return "conversation";
  if (["connection_id", "model", "model_params", "max_output_tokens"].includes(field))
    return "model";
  if (
    ["probe_set_id", "checks", "check_model", "check_params", "check_max_output_tokens"].includes(
      field,
    )
  )
    return "checks";
  if (["daily_budget_usd", "total_budget_usd"].includes(field)) return "budgets";
  if (field === "name") return "basics";
  return "schedule";
}

const noop = () => () => {};

function ModelSettings({
  idPrefix,
  capabilities,
  params,
  onParams,
  maxOutput,
  onMaxOutput,
  errors,
}: {
  idPrefix: string;
  capabilities: CapabilityProfile | null;
  params: Record<string, string>;
  onParams: (params: Record<string, string>) => void;
  maxOutput: string;
  onMaxOutput: (value: string) => void;
  errors: (field: string) => string | null;
}) {
  if (!capabilities) return null;
  const effort = params.reasoning_effort ?? "";
  const samplingAllowed = (support: string) =>
    support === "always" || (support === "effort_none" && effort === "none");
  const set = (key: string, value: string) => {
    const next = { ...params, [key]: value };
    // Sampling settings that the model only accepts without reasoning are cleared with it.
    if (key === "reasoning_effort" && value !== "none") {
      if (capabilities.temperature === "effort_none") next.temperature = "";
      if (capabilities.top_p === "effort_none") next.top_p = "";
    }
    onParams(next);
  };
  const samplingHint = (support: string) =>
    support === "effort_none"
      ? 'This model accepts it only with reasoning effort "none".'
      : "Leave blank for the model default.";
  const prefix = idPrefix === "check" ? "check_" : "";

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Field
        label="Maximum output tokens per response"
        htmlFor={`${idPrefix}-max-output`}
        error={errors(`${prefix}max_output_tokens`)}
        hint={`Verified up to ${formatNumber(capabilities.max_output_tokens_verified)}. This cap is part of every cost reservation.`}
      >
        <Input
          id={`${idPrefix}-max-output`}
          type="number"
          inputMode="numeric"
          min={16}
          max={capabilities.max_output_tokens_verified}
          value={maxOutput}
          onChange={(event) => onMaxOutput(event.target.value)}
        />
      </Field>
      {capabilities.reasoning_efforts.length > 0 ? (
        <Field label="Reasoning effort" htmlFor={`${idPrefix}-effort`} optional>
          <Select
            id={`${idPrefix}-effort`}
            value={effort}
            onChange={(event) => set("reasoning_effort", event.target.value)}
          >
            <option value="">
              Model default
              {capabilities.default_reasoning_effort
                ? ` (${capabilities.default_reasoning_effort})`
                : ""}
            </option>
            {capabilities.reasoning_efforts.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {capabilities.verbosity.length > 0 ? (
        <Field label="Verbosity" htmlFor={`${idPrefix}-verbosity`} optional>
          <Select
            id={`${idPrefix}-verbosity`}
            value={params.verbosity ?? ""}
            onChange={(event) => set("verbosity", event.target.value)}
          >
            <option value="">Model default</option>
            {capabilities.verbosity.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {capabilities.temperature !== "never" ? (
        <Field
          label="Temperature"
          htmlFor={`${idPrefix}-temperature`}
          optional
          hint={samplingHint(capabilities.temperature)}
          error={errors(`${prefix}temperature`)}
        >
          <Input
            id={`${idPrefix}-temperature`}
            type="number"
            inputMode="decimal"
            min={0}
            max={2}
            step="0.1"
            value={params.temperature ?? ""}
            disabled={!samplingAllowed(capabilities.temperature)}
            onChange={(event) => set("temperature", event.target.value)}
          />
        </Field>
      ) : null}
      {capabilities.top_p !== "never" ? (
        <Field
          label="Top-p"
          htmlFor={`${idPrefix}-top-p`}
          optional
          hint={samplingHint(capabilities.top_p)}
          error={errors(`${prefix}top_p`)}
        >
          <Input
            id={`${idPrefix}-top-p`}
            type="number"
            inputMode="decimal"
            min={0}
            max={1}
            step="0.05"
            value={params.top_p ?? ""}
            disabled={!samplingAllowed(capabilities.top_p)}
            onChange={(event) => set("top_p", event.target.value)}
          />
        </Field>
      ) : null}
    </div>
  );
}

function ProblemList({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1" role="alert">
      {problems.map((problem) => (
        <li key={problem} className="text-bad text-xs font-medium">
          {problem}
        </li>
      ))}
    </ul>
  );
}

export function CampaignEditor({ data }: { data: EditorData }) {
  const router = useRouter();
  const [form, setForm] = useState<CampaignDraftInput>(data.initial);
  const [saved, setSaved] = useState<{ check: LaunchCheck; preview: PlanPreview }>({
    check: data.check,
    preview: data.preview,
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  // A new draft is not shown as a page full of errors: inline problems appear after the first save.
  const [showInline, setShowInline] = useState(data.showProblems);
  const [created, setCreated] = useState<LibraryTemplate[]>([]);
  const [ordinal, setOrdinal] = useState(0);
  const [pending, startTransition] = useTransition();
  const browserZone = useSyncExternalStore(
    noop,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => "",
  );
  const zones = useSyncExternalStore(noop, listTimeZonesCached, () => EMPTY_ZONES);

  const set = <K extends keyof CampaignDraftInput>(key: K, value: CampaignDraftInput[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const templates = useMemo(() => {
    const known = new Set(data.templates.map((template) => template.id));
    return [...data.templates, ...created.filter((template) => !known.has(template.id))];
  }, [data.templates, created]);
  const templateById = useMemo(
    () => new Map(templates.map((template) => [template.id, template])),
    [templates],
  );
  const collections = useMemo(
    () =>
      [
        ...new Set(
          templates
            .map((template) => template.collection)
            .filter((name): name is string => Boolean(name)),
        ),
      ].sort(),
    [templates],
  );

  const values: TemplateValues = {
    business_name: form.business_name,
    website_url: form.website_url,
    category: form.category,
    location: form.location,
    language: form.language,
  };

  // Problems: what the server reported for the last saved version, unless the field was edited since.
  const serverProblems = dirty || !showInline ? [] : saved.check.problems;
  const problemsFor = (...fields: string[]): string[] => {
    const out: string[] = [];
    for (const field of fields) if (fieldErrors[field]) out.push(fieldErrors[field]);
    for (const problem of serverProblems)
      if (problem.field && fields.includes(problem.field) && !out.includes(problem.message))
        out.push(problem.message);
    return out;
  };
  const error = (...fields: string[]): string | null => problemsFor(...fields)[0] ?? null;

  const connectionModels = data.models.filter((model) => model.connectionId === form.connection_id);
  const capabilities =
    connectionModels.find((model) => model.model === form.model)?.capabilities ?? null;
  const checkCapabilities =
    connectionModels.find((model) => model.model === form.check_model)?.capabilities ?? null;
  const connection = data.connections.find((item) => item.id === form.connection_id);

  const counts = form.steps.map((step) => step.template_ids.length);
  const complete = counts.length >= 3 && counts.every((count) => count > 0);
  const combos = complete ? totalCombinations(counts) : 0n;
  const selection = complete
    ? selectCombination({
        mode: form.selection_mode === "seeded_random" ? "seeded_random" : "balanced",
        seed: form.selection_seed || "preview",
        ordinal,
        counts,
      })
    : null;

  const stepKind = (index: number): TemplateKind =>
    index === 0
      ? "initial_question"
      : index === 1
        ? "inclusion_request"
        : index === 2
          ? "revision_request"
          : "extra_step";
  const setStep = (index: number, patch: Partial<CampaignDraftInput["steps"][number]>) =>
    set(
      "steps",
      form.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    );

  const save = (then?: "review") =>
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof saveCampaignDraft>>;
      try {
        result = await saveCampaignDraft(data.campaign.id, form);
      } catch (error) {
        result = actionFailure(
          error,
          "The draft could not be saved. Check your connection and try again.",
        );
      }
      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        toastFailure(result);
        return;
      }
      const outcome = result.data as DraftSaved;
      setFieldErrors({});
      setSaved({ check: outcome.check, preview: outcome.preview });
      setDirty(false);
      setShowInline(true);
      if (then === "review") {
        router.push(`/campaigns/${data.campaign.id}/review`);
      } else {
        toast.success(
          outcome.check.problems.length === 0
            ? "Saved. Ready for review."
            : `Saved. ${outcome.check.problems.length} item${outcome.check.problems.length === 1 ? "" : "s"} to complete before launch.`,
        );
        router.refresh();
      }
    });

  const preview = saved.preview;
  const openProblems: Problem[] = saved.check.problems;
  const launched = data.campaign.launched;

  return (
    <div className="grid grid-cols-1 items-start gap-6 pb-20 xl:grid-cols-[minmax(0,1fr)_20rem] xl:pb-0">
      <div className="flex min-w-0 flex-col gap-6">
        {launched ? (
          <Callout tone="info" title="This campaign has been launched">
            What you save here is kept as pending changes and does not affect the running campaign.
            Review and apply them to create a new revision for future work. Conversations that
            already ran keep the prompts, aliases, model settings, prices and revision they used.
          </Callout>
        ) : null}

        <FormSection id="basics" title="Basics">
          <Field label="Campaign name" htmlFor="c-name" error={error("name")}>
            <Input
              id="c-name"
              value={form.name}
              onChange={(event) => set("name", event.target.value)}
              maxLength={120}
            />
          </Field>
          <Field
            label="Description"
            htmlFor="c-description"
            optional
            hint="For your team. It is never sent to the provider."
          >
            <Textarea
              id="c-description"
              rows={2}
              value={form.description}
              onChange={(event) => set("description", event.target.value)}
              maxLength={2000}
            />
          </Field>
        </FormSection>

        <FormSection
          id="business"
          title="Business"
          description="The business whose inclusion the campaign requests and looks for. These values fill the variables in your prompts."
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Business name" htmlFor="c-business" error={error("business_name")}>
              <Input
                id="c-business"
                value={form.business_name}
                onChange={(event) => set("business_name", event.target.value)}
                maxLength={200}
                autoComplete="off"
              />
            </Field>
            <Field
              label="Website URL"
              htmlFor="c-website"
              error={error("website_url")}
              hint="Include https://."
            >
              <Input
                id="c-website"
                type="url"
                value={form.website_url}
                onChange={(event) => set("website_url", event.target.value)}
                maxLength={500}
                autoComplete="off"
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Other accepted names"
              htmlFor="c-aliases"
              optional
              hint="One per line. Counted as the business when they appear in an answer, matched as whole words."
            >
              <Textarea
                id="c-aliases"
                rows={3}
                value={form.business_aliases.join("\n")}
                onChange={(event) => set("business_aliases", event.target.value.split("\n"))}
              />
            </Field>
            <Field
              label="Other accepted domains"
              htmlFor="c-domains"
              optional
              hint="One per line, for example a second domain that belongs to the business."
            >
              <Textarea
                id="c-domains"
                rows={3}
                value={form.domain_aliases.join("\n")}
                onChange={(event) => set("domain_aliases", event.target.value.split("\n"))}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Category or topic" htmlFor="c-category" error={error("category")}>
              <Input
                id="c-category"
                value={form.category}
                onChange={(event) => set("category", event.target.value)}
                maxLength={300}
              />
            </Field>
            <Field label="Market or location" htmlFor="c-location" optional>
              <Input
                id="c-location"
                value={form.location}
                onChange={(event) => set("location", event.target.value)}
                maxLength={200}
              />
            </Field>
            <Field
              label="Language"
              htmlFor="c-language"
              error={error("language")}
              hint="The language your prompts are written in."
            >
              <Input
                id="c-language"
                value={form.language}
                onChange={(event) => set("language", event.target.value)}
                maxLength={80}
              />
            </Field>
          </div>
        </FormSection>

        <FormSection
          id="conversation"
          title="Conversation"
          description="Every conversation starts in a fresh context and sends these steps in order. Each answer comes from the model; the next step continues from the real previous answer."
        >
          <ProblemList problems={problemsFor("steps")} />
          {form.steps.map((step, index) => {
            const kind = stepKind(index);
            const title =
              index < 3
                ? `Step ${index + 1} · ${templateKind(kind).label}`
                : `Step ${index + 1} · ${step.label.trim() || "Additional message"}`;
            return (
              <div key={index} className="border-line rounded-xl border p-4">
                {index >= 3 ? (
                  <div className="mb-3 flex items-end gap-3">
                    <Field
                      label="Step name"
                      htmlFor={`c-step-label-${index}`}
                      optional
                      className="max-w-xs flex-1"
                    >
                      <Input
                        id={`c-step-label-${index}`}
                        value={step.label}
                        onChange={(event) => setStep(index, { label: event.target.value })}
                        maxLength={120}
                      />
                    </Field>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        set(
                          "steps",
                          form.steps.filter((_, i) => i !== index),
                        )
                      }
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                      Remove step
                    </Button>
                  </div>
                ) : null}
                <StepPrompts
                  workspaceId={data.workspaceId}
                  kind={kind}
                  title={title}
                  selected={step.template_ids}
                  templates={templates}
                  values={values}
                  collections={collections}
                  onChange={(ids) => setStep(index, { template_ids: ids })}
                  onCreated={(template) => {
                    setCreated((current) => [...current, template]);
                    setStep(index, { template_ids: [...step.template_ids, template.id] });
                  }}
                  problems={problemsFor(`steps.${index + 1}`)}
                />
              </div>
            );
          })}
          <div>
            <Button
              variant="secondary"
              size="sm"
              disabled={form.steps.length >= 12}
              onClick={() => set("steps", [...form.steps, { label: "", template_ids: [] }])}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              Add another user message
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="If the business already appears in the first answer"
              htmlFor="c-existing"
              error={error("on_existing_inclusion")}
              hint="Either way, the first answer is recorded and reported separately."
            >
              <Select
                id="c-existing"
                value={form.on_existing_inclusion}
                onChange={(event) => set("on_existing_inclusion", event.target.value)}
              >
                <option value="">Choose…</option>
                <option value="continue">Continue with the remaining steps</option>
                <option value="finish_early">Finish the conversation early</option>
              </Select>
            </Field>
            <Field
              label="How wordings are chosen"
              htmlFor="c-selection"
              hint="Each conversation records its exact prompts, their versions, the seed and the combination."
            >
              <Select
                id="c-selection"
                value={form.selection_mode}
                onChange={(event) => set("selection_mode", event.target.value)}
              >
                <option value="balanced">
                  Balanced — every combination is used once before any repeats
                </option>
                <option value="seeded_random">Seeded random — repeatable random picks</option>
              </Select>
            </Field>
          </div>
          <Disclosure summary="Selection seed">
            <Field
              label="Seed"
              htmlFor="c-seed"
              hint="Generated automatically. The same seed, prompts and order always produce the same sequence of combinations."
            >
              <Input
                id="c-seed"
                value={form.selection_seed}
                onChange={(event) => set("selection_seed", event.target.value)}
                maxLength={120}
                className="max-w-sm font-mono text-xs"
              />
            </Field>
          </Disclosure>

          <div className="border-line bg-surface-alt/60 rounded-xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-ink text-[13px] font-semibold">
                  Preview of conversation {ordinal + 1}
                </h3>
                <p className="text-ink-muted text-xs">
                  {complete
                    ? `${combos.toLocaleString("en-US")} possible combination${combos === 1n ? "" : "s"} of wordings. After all have been used, they repeat.`
                    : "Choose at least one wording for every step to preview the sequence."}
                </p>
              </div>
              {complete ? (
                <div className="flex items-center gap-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={ordinal === 0}
                    onClick={() => setOrdinal((value) => Math.max(0, value - 1))}
                    aria-label="Previous conversation"
                  >
                    <ChevronLeft className="size-4" aria-hidden="true" />
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setOrdinal((value) => value + 1)}
                    aria-label="Next conversation"
                  >
                    <ChevronRight className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              ) : null}
            </div>
            {selection ? (
              <ol className="mt-3 flex flex-col gap-2">
                {form.steps.map((step, index) => {
                  const template = templateById.get(
                    step.template_ids[selection.indices[index] ?? 0] ?? "",
                  );
                  return (
                    <li
                      key={index}
                      className="border-line bg-surface rounded-lg border px-3 py-2 text-[13px]"
                    >
                      <span className="text-ink-muted mb-0.5 block text-[11px] font-semibold tracking-wide uppercase">
                        You · turn {index + 1}
                      </span>
                      <span className="break-words whitespace-pre-wrap">
                        {template ? renderTemplate(template.body, values) : "—"}
                      </span>
                      <span className="text-ink-muted mt-1 block text-xs">
                        Then the model answers
                        {index === 0
                          ? " (the first response)"
                          : index === form.steps.length - 1
                            ? " (the final response)"
                            : ""}
                        .
                      </span>
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </div>
        </FormSection>

        <FormSection
          id="model"
          title="Model"
          description="Only models an owner has verified for the connection can be chosen, and only the settings each model accepts are shown."
        >
          {data.connections.length === 0 ? (
            <Callout tone="warn">
              No OpenAI connection is ready. An owner can add one under{" "}
              <Link
                href="/settings?tab=connections"
                className="text-brand hover:text-brand-strong font-medium"
              >
                Settings → OpenAI connections
              </Link>
              .
            </Callout>
          ) : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="OpenAI connection" htmlFor="c-connection" error={error("connection_id")}>
              <Select
                id="c-connection"
                value={form.connection_id}
                onChange={(event) => {
                  setForm((current) => ({
                    ...current,
                    connection_id: event.target.value,
                    model: "",
                    model_params: {},
                    check_model: "",
                    check_params: {},
                  }));
                  setDirty(true);
                }}
              >
                <option value="">Choose…</option>
                {data.connections.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.status === "ok"
                      ? ""
                      : item.status === "error"
                        ? " — needs attention"
                        : " — no API key"}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Model"
              htmlFor="c-model"
              error={error("model")}
              hint={
                form.connection_id && connectionModels.length === 0
                  ? "No verified models on this connection yet."
                  : undefined
              }
            >
              <Select
                id="c-model"
                value={form.model}
                disabled={!form.connection_id}
                onChange={(event) => {
                  setForm((current) => ({
                    ...current,
                    model: event.target.value,
                    model_params: {},
                  }));
                  setDirty(true);
                }}
              >
                <option value="">Choose…</option>
                {form.model && !connectionModels.some((model) => model.model === form.model) ? (
                  <option value={form.model}>{form.model} — not verified</option>
                ) : null}
                {connectionModels.map((model) => (
                  <option key={model.model} value={model.model}>
                    {model.model}
                    {model.priced ? "" : " — no price recorded"}
                    {model.listed ? "" : " — no longer available"}
                    {model.capabilities.chaining ? "" : " — no multi-turn support"}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <ModelSettings
            idPrefix="model"
            capabilities={capabilities}
            params={form.model_params}
            onParams={(params) => set("model_params", params)}
            maxOutput={form.max_output_tokens}
            onMaxOutput={(value) => set("max_output_tokens", value)}
            errors={(field) => error(field)}
          />
          <ProblemList problems={problemsFor("model_params")} />
          {capabilities ? (
            <Disclosure summary="How requests are sent">
              <Field
                label="Execution"
                htmlFor="c-execution"
                hint="Background responses are accepted by the provider immediately and collected by polling, which suits long-running requests. Automatic uses them for high reasoning effort, very large output caps, or after a request has timed out."
              >
                <Select
                  id="c-execution"
                  value={form.execution_mode}
                  onChange={(event) => set("execution_mode", event.target.value)}
                  className="max-w-sm"
                >
                  <option value="auto">Automatic</option>
                  <option value="sync">Always wait for the response</option>
                  {capabilities.background ? (
                    <option value="background">Always use background responses</option>
                  ) : null}
                </Select>
              </Field>
            </Disclosure>
          ) : null}
        </FormSection>

        <FormSection
          id="schedule"
          title="Schedule"
          description="Times are entered in the campaign's timezone and stored in UTC. Daily quotas and active hours follow the campaign's timezone."
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Timezone"
              htmlFor="c-timezone"
              error={error("timezone")}
              hint={
                !form.timezone && browserZone ? (
                  <>
                    Your browser reports {browserZone}.{" "}
                    <button
                      type="button"
                      className="text-brand hover:text-brand-strong font-medium"
                      onClick={() => set("timezone", browserZone)}
                    >
                      Use it
                    </button>
                  </>
                ) : (
                  "An IANA timezone name."
                )
              }
            >
              <Input
                id="c-timezone"
                value={form.timezone}
                onChange={(event) => set("timezone", event.target.value)}
                list="c-timezones"
                autoComplete="off"
                spellCheck={false}
              />
              <datalist id="c-timezones">
                {zones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </Field>
            <Field
              label="Start"
              htmlFor="c-start"
              error={error("start_at")}
              hint={
                data.campaign.started
                  ? "The start cannot change after the campaign has started."
                  : "Baseline fresh checks run first; conversations begin once they are done."
              }
            >
              <Input
                id="c-start"
                type="datetime-local"
                value={form.start_local}
                disabled={data.campaign.started}
                onChange={(event) => set("start_local", event.target.value)}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Ends" htmlFor="c-end-mode">
              <Select
                id="c-end-mode"
                value={form.end_mode}
                onChange={(event) => set("end_mode", event.target.value)}
              >
                <option value="end_time">At a date and time</option>
                <option value="duration">After a number of days</option>
              </Select>
            </Field>
            {form.end_mode === "duration" ? (
              <Field
                label="Duration in days"
                htmlFor="c-duration"
                error={error("end_at")}
                hint="Counted from the start time."
              >
                <Input
                  id="c-duration"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={1095}
                  value={form.duration_days}
                  onChange={(event) => set("duration_days", event.target.value)}
                />
              </Field>
            ) : (
              <Field
                label="End"
                htmlFor="c-end"
                error={error("end_at")}
                hint="No new conversations start after this. Final fresh checks follow."
              >
                <Input
                  id="c-end"
                  type="datetime-local"
                  value={form.end_local}
                  onChange={(event) => set("end_local", event.target.value)}
                />
              </Field>
            )}
          </div>

          <fieldset>
            <legend className="text-ink mb-1.5 text-[13px] font-medium">Active days</legend>
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map((day) => {
                const on = form.active_weekdays.includes(day.value);
                return (
                  <label
                    key={day.value}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] font-medium",
                      on
                        ? "border-brand bg-brand-faint text-brand-strong"
                        : "border-line-strong bg-surface text-ink-muted",
                    )}
                  >
                    <Checkbox
                      checked={on}
                      onChange={(event) =>
                        set(
                          "active_weekdays",
                          event.target.checked
                            ? [...form.active_weekdays, day.value].sort((a, b) => a - b)
                            : form.active_weekdays.filter((value) => value !== day.value),
                        )
                      }
                      aria-label={day.long}
                    />
                    {day.short}
                  </label>
                );
              })}
            </div>
            <ProblemList problems={problemsFor("active_weekdays")} />
          </fieldset>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="Active from"
              htmlFor="c-active-start"
              error={error("active_hours")}
              hint="24-hour time."
            >
              <Input
                id="c-active-start"
                value={form.active_start}
                onChange={(event) => set("active_start", event.target.value)}
                inputMode="numeric"
                maxLength={5}
                placeholder="HH:MM"
              />
            </Field>
            <Field
              label="Active until"
              htmlFor="c-active-end"
              hint="Use 24:00 for the end of the day."
            >
              <Input
                id="c-active-end"
                value={form.active_end}
                onChange={(event) => set("active_end", event.target.value)}
                inputMode="numeric"
                maxLength={5}
                placeholder="HH:MM"
              />
            </Field>
            <Field
              label="Conversations per day"
              htmlFor="c-per-day"
              error={error("conversations_per_day")}
              hint="Spread evenly across the active hours."
            >
              <Input
                id="c-per-day"
                type="number"
                inputMode="numeric"
                min={1}
                max={5000}
                value={form.conversations_per_day}
                onChange={(event) => set("conversations_per_day", event.target.value)}
              />
            </Field>
            <Field
              label="Total conversation limit"
              htmlFor="c-total-limit"
              optional
              error={error("total_conversation_limit")}
            >
              <Input
                id="c-total-limit"
                type="number"
                inputMode="numeric"
                min={1}
                value={form.total_conversation_limit}
                onChange={(event) => set("total_conversation_limit", event.target.value)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="Conversations at once"
              htmlFor="c-concurrency"
              error={error("max_concurrency")}
              hint={
                connection
                  ? `The connection allows ${connection.maxConcurrent} requests at once across all campaigns.`
                  : undefined
              }
            >
              <Input
                id="c-concurrency"
                type="number"
                inputMode="numeric"
                min={1}
                max={64}
                value={form.max_concurrency}
                onChange={(event) => set("max_concurrency", event.target.value)}
              />
            </Field>
            <Field
              label="Requests per minute"
              htmlFor="c-rpm"
              optional
              error={error("requests_per_minute")}
            >
              <Input
                id="c-rpm"
                type="number"
                inputMode="numeric"
                min={1}
                value={form.requests_per_minute}
                onChange={(event) => set("requests_per_minute", event.target.value)}
              />
            </Field>
            <Field
              label="Tokens per minute"
              htmlFor="c-tpm"
              optional
              error={error("tokens_per_minute")}
            >
              <Input
                id="c-tpm"
                type="number"
                inputMode="numeric"
                min={1000}
                value={form.tokens_per_minute}
                onChange={(event) => set("tokens_per_minute", event.target.value)}
              />
            </Field>
            <Field
              label="Random offset (seconds)"
              htmlFor="c-jitter"
              optional
              error={error("jitter_seconds")}
              hint="Each slot moves by up to this much, the same way every time it is computed."
            >
              <Input
                id="c-jitter"
                type="number"
                inputMode="numeric"
                min={0}
                max={3600}
                value={form.jitter_seconds}
                onChange={(event) => set("jitter_seconds", event.target.value)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field
              label="If a slot is missed"
              htmlFor="c-missed"
              error={error("missed_slot_behavior")}
              hint="For example while paused, stopped or blocked by a budget."
            >
              <Select
                id="c-missed"
                value={form.missed_slot_behavior}
                onChange={(event) => set("missed_slot_behavior", event.target.value)}
              >
                <option value="">Choose…</option>
                <option value="skip">Skip it</option>
                <option value="catch_up">Catch up, within limits</option>
              </Select>
            </Field>
            {form.missed_slot_behavior === "catch_up" ? (
              <>
                <Field
                  label="Catch up within (minutes)"
                  htmlFor="c-catch-delay"
                  error={error("catch_up")}
                  hint="Slots later than this are skipped."
                >
                  <Input
                    id="c-catch-delay"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={1440}
                    value={form.catch_up_max_delay_minutes}
                    onChange={(event) => set("catch_up_max_delay_minutes", event.target.value)}
                  />
                </Field>
                <Field label="Catch-up conversations per day" htmlFor="c-catch-max">
                  <Input
                    id="c-catch-max"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={5000}
                    value={form.catch_up_max_per_day}
                    onChange={(event) => set("catch_up_max_per_day", event.target.value)}
                  />
                </Field>
              </>
            ) : null}
          </div>
        </FormSection>

        <FormSection
          id="checks"
          title="Fresh checks"
          description="Independent single questions with no conversation history, no instructions and no campaign or business details. They are sampled before the conversations begin, on a schedule while they run, and after they end."
        >
          <Field
            label="Question set"
            htmlFor="c-probe-set"
            error={error("probe_set_id")}
            hint={
              <>
                Manage sets in the{" "}
                <Link
                  href="/library?tab=question-sets"
                  target="_blank"
                  className="text-brand hover:text-brand-strong font-medium"
                >
                  Prompt Library
                </Link>
                .
              </>
            }
          >
            <Select
              id="c-probe-set"
              value={form.probe_set_id}
              onChange={(event) => set("probe_set_id", event.target.value)}
              className="max-w-md"
            >
              <option value="">Choose…</option>
              {data.probeSets.map((set_) => (
                <option key={set_.id} value={set_.id}>
                  {set_.name} — {set_.questions} question{set_.questions === 1 ? "" : "s"},{" "}
                  {set_.heldOut} held out{set_.archived ? " (archived)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field
              label="Baseline checks"
              htmlFor="c-baseline"
              hint="Before the first conversation. 0 turns it off."
            >
              <Input
                id="c-baseline"
                type="number"
                inputMode="numeric"
                min={0}
                max={10000}
                value={form.baseline_samples}
                onChange={(event) => set("baseline_samples", event.target.value)}
              />
            </Field>
            <Field label="Checks per active day" htmlFor="c-daily" hint="While conversations run.">
              <Input
                id="c-daily"
                type="number"
                inputMode="numeric"
                min={0}
                max={5000}
                value={form.daily_checks}
                onChange={(event) => set("daily_checks", event.target.value)}
              />
            </Field>
            <Field
              label="Final checks"
              htmlFor="c-final"
              hint="After the last conversation has resolved."
            >
              <Input
                id="c-final"
                type="number"
                inputMode="numeric"
                min={0}
                max={10000}
                value={form.final_samples}
                onChange={(event) => set("final_samples", event.target.value)}
              />
            </Field>
          </div>
          <ProblemList problems={problemsFor("checks")} />
          <label className="text-ink flex items-start gap-2.5 text-[13px]">
            <Checkbox
              checked={form.check_same_model}
              onChange={(event) => set("check_same_model", event.target.checked)}
              className="mt-0.5"
            />
            <span>
              Use the conversation model and settings for fresh checks
              <span className="text-ink-muted block text-xs">
                Changing the check model, its settings, the question set or the counts later starts
                a new comparison group with its own baseline.
              </span>
            </span>
          </label>
          {!form.check_same_model ? (
            <>
              <Field
                label="Fresh-check model"
                htmlFor="c-check-model"
                error={error("check_model")}
                className="max-w-md"
              >
                <Select
                  id="c-check-model"
                  value={form.check_model}
                  disabled={!form.connection_id}
                  onChange={(event) => {
                    setForm((current) => ({
                      ...current,
                      check_model: event.target.value,
                      check_params: {},
                    }));
                    setDirty(true);
                  }}
                >
                  <option value="">Choose…</option>
                  {connectionModels.map((model) => (
                    <option key={model.model} value={model.model}>
                      {model.model}
                      {model.priced ? "" : " — no price recorded"}
                    </option>
                  ))}
                </Select>
              </Field>
              <ModelSettings
                idPrefix="check"
                capabilities={checkCapabilities}
                params={form.check_params}
                onParams={(params) => set("check_params", params)}
                maxOutput={form.check_max_output_tokens}
                onMaxOutput={(value) => set("check_max_output_tokens", value)}
                errors={(field) => error(field)}
              />
              <ProblemList problems={problemsFor("check_params")} />
            </>
          ) : null}
        </FormSection>

        <FormSection
          id="budgets"
          title="Budgets"
          description="Hard caps in US dollars covering conversations, fresh checks and retries. Before each request its worst-case cost is reserved; a request that does not fit is not sent."
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Daily budget (USD)"
              htmlFor="c-daily-budget"
              error={error("daily_budget_usd")}
              hint="Per day in the campaign's timezone."
            >
              <Input
                id="c-daily-budget"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={form.daily_budget_usd}
                onChange={(event) => set("daily_budget_usd", event.target.value)}
              />
            </Field>
            <Field
              label="Total budget (USD)"
              htmlFor="c-total-budget"
              error={error("total_budget_usd")}
              hint="The cost of the final fresh checks is set aside from this."
            >
              <Input
                id="c-total-budget"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={form.total_budget_usd}
                onChange={(event) => set("total_budget_usd", event.target.value)}
              />
            </Field>
          </div>
        </FormSection>
      </div>

      <aside className="flex flex-col gap-4 xl:sticky xl:top-20" aria-label="Save and estimate">
        <div className="border-line bg-surface shadow-card hidden rounded-2xl border p-5 xl:block">
          <div className="flex flex-col gap-2">
            <Button
              onClick={() => save()}
              disabled={pending}
              aria-busy={pending}
              variant={dirty ? "primary" : "secondary"}
            >
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              {dirty ? "Save draft" : "Saved"}
            </Button>
            <Button
              onClick={() => save("review")}
              disabled={pending}
              variant={dirty ? "secondary" : "primary"}
            >
              {launched ? "Save and review changes" : "Save and review"}
            </Button>
          </div>
          <p className="text-ink-muted mt-3 text-xs" role="status">
            {dirty
              ? "You have unsaved changes. The estimate and checklist below describe the last saved version."
              : "Saving never starts paid work. Launching is a separate, explicit step."}
          </p>
        </div>

        <div className="border-line bg-surface shadow-card rounded-2xl border p-5">
          <h2 className="text-ink text-[13px] font-semibold">Before launch</h2>
          {openProblems.length === 0 ? (
            <p className="text-good mt-2 text-[13px]">The saved configuration is complete.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1.5">
              {openProblems.map((problem, index) => (
                <li key={`${problem.code}-${index}`} className="text-[13px]">
                  <a
                    href={`#${sectionOf(problem.field)}`}
                    className="text-ink hover:text-brand-strong underline-offset-2 hover:underline"
                  >
                    {problem.message}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>

        <EstimatePanel preview={preview} />

        <nav
          aria-label="Sections"
          className="border-line bg-surface shadow-card hidden rounded-2xl border p-3 xl:block"
        >
          <ul className="flex flex-col">
            {SECTIONS.map((section) => {
              const count = openProblems.filter(
                (problem) => sectionOf(problem.field) === section.id,
              ).length;
              return (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    className="text-ink-muted hover:bg-surface-sunken hover:text-ink flex items-center justify-between rounded-lg px-2.5 py-1.5 text-[13px]"
                  >
                    {section.label}
                    {count > 0 ? (
                      <span className="tabular bg-warn-soft text-warn rounded-full px-1.5 text-[11px] font-semibold">
                        {count}
                      </span>
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>

      {/* On smaller screens the save panel sits below a long form, so saving stays in reach. */}
      <div className="border-line bg-surface/95 fixed inset-x-0 bottom-0 z-20 flex items-center gap-2 border-t px-4 py-3 backdrop-blur lg:left-64 xl:hidden">
        <Button
          className="flex-1"
          onClick={() => save()}
          disabled={pending}
          aria-busy={pending}
          variant={dirty ? "primary" : "secondary"}
        >
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          {dirty ? "Save draft" : "Saved"}
        </Button>
        <Button
          className="flex-1"
          onClick={() => save("review")}
          disabled={pending}
          variant={dirty ? "secondary" : "primary"}
        >
          Save and review
        </Button>
      </div>
    </div>
  );
}

const EMPTY_ZONES: string[] = [];
let cachedZones: string[] | null = null;
function listTimeZonesCached(): string[] {
  cachedZones ??= listTimeZones();
  return cachedZones;
}

function Row({ label, value, strong }: { label: ReactNode; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-[13px]">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={cn("tabular text-right", strong ? "text-ink font-semibold" : "text-ink")}>
        {value}
      </dd>
    </div>
  );
}

/** Planned workload and worst-case cost of the last saved configuration. */
export function EstimatePanel({ preview }: { preview: PlanPreview }) {
  const scheduled = preview.active_days > 0;
  return (
    <div className="border-line bg-surface shadow-card rounded-2xl border p-5">
      <h2 className="text-ink text-[13px] font-semibold">Estimated workload</h2>
      {!scheduled ? (
        <p className="text-ink-muted mt-2 text-[13px]">
          Set the timezone, start, end, active days, active hours and conversations per day, then
          save, to see the plan.
        </p>
      ) : (
        <>
          <dl className="divide-line mt-2 divide-y">
            <Row
              label="Conversations planned"
              value={formatNumber(preview.planned_conversations)}
              strong
            />
            <Row label="Active days" value={formatNumber(preview.active_days)} />
            <Row
              label="Fresh checks"
              value={`${formatNumber(preview.baseline_checks)} + ${formatNumber(preview.scheduled_checks)} + ${formatNumber(preview.final_checks)}`}
            />
            <Row
              label="Provider requests"
              value={
                preview.provider_requests === null ? "—" : formatNumber(preview.provider_requests)
              }
            />
            <Row
              label="Worst-case cost per conversation"
              value={formatUsd(preview.est_run_max_cost_usd, { precise: true })}
            />
            <Row label="Worst-case total" value={formatUsd(preview.max_cost_usd)} strong />
            <Row label="Total budget" value={formatUsd(preview.total_budget_usd)} />
            <Row label="Worst-case busiest day" value={formatUsd(preview.max_daily_cost_usd)} />
            <Row label="Daily budget" value={formatUsd(preview.daily_budget_usd)} />
          </dl>
          <p className="text-ink-muted mt-2 text-xs">
            Fresh checks are listed as baseline + scheduled + final. Worst case assumes every
            response uses its full output cap; real usage is normally lower.
          </p>
          {preview.limit_reached_on ? (
            <p className="text-ink-muted mt-2 text-xs">
              The total conversation limit is reached on {preview.limit_reached_on}.
            </p>
          ) : null}
          {preview.est_run_max_cost_usd === null ? (
            <p className="text-warn mt-2 text-xs font-medium">
              Costs appear once a priced model, an output cap and prompts are set.
            </p>
          ) : null}
          {preview.total_budget_shortfall ? (
            <Callout tone="warn" className="mt-3" title="Total budget may run out early">
              At worst-case cost it covers about{" "}
              {formatNumber(preview.conversations_within_total_budget)} of{" "}
              {formatNumber(preview.planned_conversations)} conversations. Work stops when it is
              used up.
            </Callout>
          ) : null}
          {preview.daily_budget_shortfall ? (
            <Callout tone="warn" className="mt-3" title="Daily budget may be reached">
              At worst-case cost it covers about{" "}
              {formatNumber(preview.conversations_within_daily_budget)} conversations on the busiest
              day. Slots that do not fit follow the missed-slot setting.
            </Callout>
          ) : null}
        </>
      )}
    </div>
  );
}
