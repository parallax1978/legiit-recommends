import { PromptText } from "@/components/library/prompt-fields";
import { Badge, Callout, Card, CardBody, CardHeader } from "@/components/ui/card";
import { DefinitionList } from "@/components/ui/misc";
import {
  describeWeekdays,
  formatDateTime,
  formatNumber,
  formatUsd,
  minutesToTime,
} from "@/lib/format";
import { templateKind } from "@/lib/labels";
import type { Revision, RevisionStep } from "@/lib/queries/campaign";
import { renderTemplate, type TemplateValues } from "@shared/core/templates.ts";

const UNSET = <span className="text-ink-muted">Not set</span>;

function paramsText(params: unknown): string {
  const entries = Object.entries((params ?? {}) as Record<string, unknown>).filter(
    ([, value]) => value !== null && value !== undefined && value !== "",
  );
  if (entries.length === 0) return "Model defaults";
  return entries.map(([key, value]) => `${key.replace(/_/g, " ")} ${String(value)}`).join(" · ");
}

export function valuesOf(revision: Revision): TemplateValues {
  return {
    business_name: revision.business_name,
    website_url: revision.website_url,
    category: revision.category,
    location: revision.location,
    language: revision.language,
  };
}

/** Every step with every wording, as written and as it will be sent. */
export function SequenceSummary({
  steps,
  values,
}: {
  steps: RevisionStep[];
  values: TemplateValues;
}) {
  return (
    <ol className="flex flex-col gap-4">
      {steps.map((step) => (
        <li key={step.index} className="border-line rounded-xl border p-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-ink text-[13px] font-semibold">
              Turn {step.index} ·{" "}
              {step.index > 3 && step.label ? step.label : templateKind(step.kind).label}
            </h3>
            <span className="text-ink-muted text-xs">
              {step.wordings.length} wording{step.wordings.length === 1 ? "" : "s"} — one is used
              per conversation
            </span>
          </div>
          {step.wordings.length === 0 ? (
            <p className="text-bad text-[13px]">No wording chosen.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {step.wordings.map((wording) => {
                const rendered = renderTemplate(wording.body, values);
                return (
                  <li
                    key={wording.templateId}
                    className="bg-surface-alt rounded-lg px-3 py-2 text-[13px]"
                  >
                    <p className="text-ink break-words whitespace-pre-wrap">{rendered}</p>
                    {rendered !== wording.body ? (
                      <p className="text-ink-muted mt-1 text-xs">
                        Template{wording.version ? ` v${wording.version}` : ""}:{" "}
                        <PromptText body={wording.body} />
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-ink-muted mt-2 text-xs">
            The model&apos;s own answer follows
            {step.index === 1
              ? " and is recorded as the first response"
              : step.index === steps.length
                ? " and is recorded as the final response"
                : ""}
            .
          </p>
        </li>
      ))}
    </ol>
  );
}

export function ConfigSummary({
  revision,
  steps,
  connectionName,
  probeSet,
  showSequence = true,
}: {
  revision: Revision;
  steps: RevisionStep[];
  connectionName: string | null;
  probeSet: { name: string; version: number | null; questions: number; heldOut: number } | null;
  showSequence?: boolean;
}) {
  const zone = revision.timezone;
  const checksOn =
    (revision.baseline_samples ?? 0) +
      (revision.daily_checks ?? 0) +
      (revision.final_samples ?? 0) >
    0;
  const questionCount = probeSet?.questions ?? 0;
  const partialCoverage =
    questionCount > 0 &&
    [revision.baseline_samples, revision.final_samples].some(
      (count) => (count ?? 0) > 0 && (count ?? 0) < questionCount,
    );
  const combos = steps.reduce(
    (product, step) => product * BigInt(Math.max(step.wordings.length, 1)),
    1n,
  );

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title="Business" />
        <CardBody>
          <DefinitionList
            items={[
              { term: "Business name", value: revision.business_name ?? UNSET },
              { term: "Website", value: revision.website_url ?? UNSET },
              {
                term: "Other accepted names",
                value: revision.business_aliases.length
                  ? revision.business_aliases.join(", ")
                  : "None",
              },
              {
                term: "Other accepted domains",
                value: revision.domain_aliases.length ? revision.domain_aliases.join(", ") : "None",
              },
              { term: "Category or topic", value: revision.category ?? UNSET },
              { term: "Market or location", value: revision.location ?? "None" },
              { term: "Language", value: revision.language ?? UNSET },
            ]}
          />
        </CardBody>
      </Card>

      {showSequence ? (
        <Card>
          <CardHeader
            title="Conversation sequence"
            description={`${steps.length} turns per conversation · ${combos.toLocaleString("en-US")} combination${combos === 1n ? "" : "s"} of wordings · ${revision.selection_mode === "seeded_random" ? "seeded random" : "balanced"} selection`}
          />
          <CardBody className="flex flex-col gap-4">
            <SequenceSummary steps={steps} values={valuesOf(revision)} />
            <DefinitionList
              items={[
                {
                  term: "If already in the first answer",
                  value:
                    revision.on_existing_inclusion === "finish_early"
                      ? "Finish the conversation early"
                      : revision.on_existing_inclusion === "continue"
                        ? "Continue with the remaining turns"
                        : UNSET,
                },
                {
                  term: "Selection seed",
                  value: (
                    <span className="font-mono text-xs">{revision.selection_seed ?? "—"}</span>
                  ),
                },
              ]}
            />
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Model" />
        <CardBody>
          <DefinitionList
            items={[
              { term: "Connection", value: connectionName ?? UNSET },
              {
                term: "Model requested",
                value: revision.model ? (
                  <span className="font-mono text-xs">{revision.model}</span>
                ) : (
                  UNSET
                ),
              },
              { term: "Settings", value: paramsText(revision.model_params) },
              {
                term: "Output cap per response",
                value: revision.max_output_tokens
                  ? `${formatNumber(revision.max_output_tokens)} tokens`
                  : UNSET,
              },
              {
                term: "Execution",
                value:
                  revision.execution_mode === "sync"
                    ? "Always wait for the response"
                    : revision.execution_mode === "background"
                      ? "Always background responses"
                      : "Automatic",
              },
            ]}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Schedule" />
        <CardBody>
          <DefinitionList
            items={[
              { term: "Timezone", value: zone ?? UNSET },
              {
                term: "Start",
                value: revision.start_at ? formatDateTime(revision.start_at, zone) : UNSET,
              },
              {
                term: "End",
                value: revision.end_at ? formatDateTime(revision.end_at, zone) : UNSET,
              },
              { term: "Active days", value: describeWeekdays(revision.active_weekdays) },
              {
                term: "Active hours",
                value:
                  revision.active_start_minute !== null && revision.active_end_minute !== null
                    ? `${minutesToTime(revision.active_start_minute)} to ${minutesToTime(revision.active_end_minute)}`
                    : UNSET,
              },
              {
                term: "Conversations per day",
                value: revision.conversations_per_day
                  ? formatNumber(revision.conversations_per_day)
                  : UNSET,
              },
              {
                term: "Total conversation limit",
                value: revision.total_conversation_limit
                  ? formatNumber(revision.total_conversation_limit)
                  : "None",
              },
              {
                term: "Conversations at once",
                value: revision.max_concurrency ? formatNumber(revision.max_concurrency) : UNSET,
              },
              {
                term: "Rate caps",
                value: `${revision.requests_per_minute ? `${formatNumber(revision.requests_per_minute)} requests` : "no request cap"} · ${revision.tokens_per_minute ? `${formatNumber(revision.tokens_per_minute)} tokens` : "no token cap"} per minute`,
              },
              {
                term: "Random offset",
                value: revision.jitter_seconds
                  ? `Up to ${formatNumber(revision.jitter_seconds)} seconds per slot`
                  : "None",
              },
              {
                term: "Missed slots",
                value:
                  revision.missed_slot_behavior === "catch_up"
                    ? `Catch up within ${revision.catch_up_max_delay_minutes ?? "—"} minutes, at most ${revision.catch_up_max_per_day ?? "—"} per day`
                    : revision.missed_slot_behavior === "skip"
                      ? "Skipped"
                      : UNSET,
              },
            ]}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Fresh checks"
          description="Single questions with no history, instructions or business details."
        />
        <CardBody>
          {checksOn || probeSet ? (
            <DefinitionList
              items={[
                {
                  term: "Question set",
                  value: probeSet ? (
                    <span className="flex flex-wrap items-center gap-2">
                      {probeSet.name}
                      <span className="text-ink-muted">
                        {probeSet.version ? `version ${probeSet.version} · ` : ""}
                        {probeSet.questions} question{probeSet.questions === 1 ? "" : "s"},{" "}
                        {probeSet.heldOut} held out
                      </span>
                    </span>
                  ) : (
                    UNSET
                  ),
                },
                { term: "Baseline checks", value: formatNumber(revision.baseline_samples) },
                { term: "Checks per active day", value: formatNumber(revision.daily_checks) },
                { term: "Final checks", value: formatNumber(revision.final_samples) },
                {
                  term: "Model",
                  value: revision.check_model ? (
                    <span>
                      <span className="font-mono text-xs">{revision.check_model}</span> ·{" "}
                      {paramsText(revision.check_params)} · cap{" "}
                      {formatNumber(revision.check_max_output_tokens)} tokens
                    </span>
                  ) : (
                    "Same model and settings as conversations"
                  ),
                },
              ]}
            />
          ) : null}
          {partialCoverage ? (
            <Callout
              tone="info"
              className="mt-4"
              title="Not every question is asked in every phase"
            >
              The set has {probeSet?.questions} questions and they are used in rotation, so a phase
              with fewer checks than that covers only some of them — a question, including a
              held-out one, can end up without a baseline to compare against. Use at least{" "}
              {probeSet?.questions} checks in the baseline and final phases to cover every question.
            </Callout>
          ) : null}
          {checksOn || probeSet ? null : (
            <p className="text-ink-muted text-[13px]">
              <Badge tone="warn">Off</Badge> No fresh checks are configured, so this campaign would
              have no independent measurement.
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Budgets"
          description="Hard caps. Each request reserves its worst-case cost first."
        />
        <CardBody>
          <DefinitionList
            items={[
              {
                term: "Daily budget",
                value: revision.daily_budget_usd
                  ? `${formatUsd(revision.daily_budget_usd)} per day in ${zone ?? "the campaign timezone"}`
                  : UNSET,
              },
              {
                term: "Total budget",
                value: revision.total_budget_usd ? formatUsd(revision.total_budget_usd) : UNSET,
              },
              ...(revision.state === "frozen"
                ? [
                    {
                      term: "Set aside for final checks",
                      value: formatUsd(revision.final_check_set_aside_usd),
                    },
                    {
                      term: "Worst-case cost per conversation",
                      value: formatUsd(revision.est_run_max_cost_usd, { precise: true }),
                    },
                    {
                      term: "Worst-case cost per fresh check",
                      value: formatUsd(revision.est_check_max_cost_usd, { precise: true }),
                    },
                  ]
                : []),
            ]}
          />
        </CardBody>
      </Card>
    </div>
  );
}
