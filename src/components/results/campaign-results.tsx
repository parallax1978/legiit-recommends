import { RateLineChart, TimeBarChart, type ChartRow } from "@/components/charts/charts";
import { ChartFrame } from "@/components/charts/chart-frame";
import { InclusionBar, InclusionLegend, RateRow } from "@/components/charts/figures";
import { CATEGORICAL } from "@/components/charts/theme";
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState } from "@/components/ui/card";
import {
  formatDate,
  formatNumber,
  formatPercent,
  formatPointChange,
  formatUsd,
  rate,
} from "@/lib/format";
import type { CheckMetrics, ConversationMetrics, DailyActivityRow, Row } from "@/lib/queries/types";
import type { ServerClient } from "@/lib/supabase/server";

function paramsText(params: unknown): string {
  const entries = Object.entries((params ?? {}) as Record<string, unknown>).filter(
    ([, value]) => value !== null && value !== undefined && value !== "",
  );
  return entries.length === 0
    ? "model defaults"
    : entries.map(([key, value]) => `${key.replace(/_/g, " ")} ${String(value)}`).join(", ");
}

const shortDay = (day: string) => formatDate(day).replace(/, \d{4}$/, "");

export function ApiResultsNote() {
  return (
    <p className="text-ink-muted flex flex-wrap items-center gap-2 text-xs">
      <Badge tone="brand">OpenAI API results</Badge>
      Measured through the OpenAI API with the models and settings shown. They are not results from
      the ChatGPT apps, which can answer differently.
    </p>
  );
}

function Count({
  label,
  one,
  value,
  tone,
}: {
  label: string;
  one?: string;
  value: number;
  tone?: "warn" | "bad";
}) {
  if (!value) return null;
  return (
    <li className="flex items-baseline gap-1.5">
      <span
        className={
          tone === "bad"
            ? "tabular text-bad font-semibold"
            : tone === "warn"
              ? "tabular text-warn font-semibold"
              : "tabular text-ink font-semibold"
        }
      >
        {formatNumber(value)}
      </span>
      <span className="text-ink-muted">{value === 1 && one ? one : label}</span>
    </li>
  );
}

function CohortCard({
  cohort,
  index,
  total,
}: {
  cohort: ConversationMetrics;
  index: number;
  total: number;
}) {
  const first = rate(cohort.first_included, cohort.first_valid);
  const final = rate(cohort.final_included, cohort.final_valid);
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {total > 1 ? `Cohort ${index + 1}: ` : ""}
            <span className="font-mono text-[13px]">{cohort.model}</span>
          </span>
        }
        description={`${paramsText(cohort.model_params)} · output cap ${formatNumber(cohort.max_output_tokens)} tokens · revision${cohort.revision_numbers.length === 1 ? "" : "s"} ${cohort.revision_numbers.join(", ")}`}
      />
      <CardBody>
        <div className="divide-line divide-y">
          <RateRow
            label="First response inclusion"
            hint="Answers to the initial question, before the business was requested."
            included={cohort.first_included}
            valid={cohort.first_valid}
            extra={
              cohort.first_needs_review > 0
                ? `${formatNumber(cohort.first_needs_review)} need review and are not counted`
                : undefined
            }
          />
          <RateRow
            label="Final response inclusion"
            hint="Last answers of conversations that completed every turn."
            included={cohort.final_included}
            valid={cohort.final_valid}
            extra={
              <>
                {first !== null && final !== null
                  ? `${formatPointChange(final, first)} vs first response`
                  : null}
                {cohort.final_needs_review > 0
                  ? ` · ${formatNumber(cohort.final_needs_review)} need review`
                  : ""}
              </>
            }
          />
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <p className="text-ink-muted mb-1.5 text-xs font-medium">First responses</p>
            <InclusionBar
              counts={{
                included: cohort.first_included,
                mentioned_only: cohort.first_mentioned_only,
                not_mentioned: cohort.first_not_mentioned,
                needs_review: cohort.first_needs_review,
              }}
            />
            <p className="tabular text-ink-muted mt-1.5 text-xs">
              {formatNumber(cohort.first_included)} included ·{" "}
              {formatNumber(cohort.first_mentioned_only)} mentioned only ·{" "}
              {formatNumber(cohort.first_not_mentioned)} not mentioned
            </p>
          </div>
          <div>
            <p className="text-ink-muted mb-1.5 text-xs font-medium">Final responses</p>
            <InclusionBar
              counts={{
                included: cohort.final_included,
                mentioned_only: cohort.final_mentioned_only,
                not_mentioned: cohort.final_not_mentioned,
                needs_review: cohort.final_needs_review,
              }}
            />
            <p className="tabular text-ink-muted mt-1.5 text-xs">
              {formatNumber(cohort.final_included)} included ·{" "}
              {formatNumber(cohort.final_mentioned_only)} mentioned only ·{" "}
              {formatNumber(cohort.final_not_mentioned)} not mentioned
            </p>
          </div>
        </div>
        <InclusionLegend className="mt-3" />
        <ul className="border-line mt-4 flex flex-wrap gap-x-5 gap-y-1 border-t pt-4 text-xs">
          <Count label="conversations" one="conversation" value={cohort.runs_total} />
          <Count label="completed" value={cohort.runs_completed} />
          <Count label="finished early" value={cohort.runs_completed_early} />
          <Count label="in progress" value={cohort.runs_in_progress} />
          <Count label="incomplete" value={cohort.runs_incomplete} tone="warn" />
          <Count label="failed" value={cohort.runs_failed} tone="bad" />
          <Count label="expired" value={cohort.runs_expired} tone="warn" />
          <Count label="unresolved" value={cohort.runs_unresolved} tone="warn" />
          <Count label="canceled" value={cohort.runs_canceled} />
          <Count
            label="named the business in the initial question"
            value={cohort.target_in_initial_prompt}
            tone="warn"
          />
        </ul>
      </CardBody>
    </Card>
  );
}

interface Totals {
  total: number;
  valid: number;
  included: number;
  mentioned_only: number;
  not_mentioned: number;
  needs_review: number;
  incomplete: number;
  failed: number;
  excluded: number;
  canceled: number;
  pending: number;
}

const ZERO: Totals = {
  total: 0,
  valid: 0,
  included: 0,
  mentioned_only: 0,
  not_mentioned: 0,
  needs_review: 0,
  incomplete: 0,
  failed: 0,
  excluded: 0,
  canceled: 0,
  pending: 0,
};

function sum(rows: CheckMetrics[]): Totals {
  const out = { ...ZERO };
  for (const row of rows)
    for (const key of Object.keys(ZERO) as (keyof Totals)[]) out[key] += Number(row[key]);
  return out;
}

function PhaseRows({ title, hint, rows }: { title: string; hint: string; rows: CheckMetrics[] }) {
  const baseline = sum(rows.filter((row) => row.phase === "baseline"));
  const daily = sum(rows.filter((row) => row.phase === "daily"));
  const final = sum(rows.filter((row) => row.phase === "final"));
  const baseRate = rate(baseline.included, baseline.valid);
  const change = (totals: Totals) => {
    const current = rate(totals.included, totals.valid);
    return baseRate !== null && current !== null
      ? `${formatPointChange(current, baseRate)} vs baseline`
      : undefined;
  };
  const all = sum(rows);
  if (all.total === 0) return null;
  return (
    <div>
      <h3 className="text-ink text-[13px] font-semibold">{title}</h3>
      <p className="text-ink-muted text-xs">{hint}</p>
      <div className="divide-line mt-1 divide-y">
        <RateRow
          label="Baseline"
          hint="Before the first conversation."
          included={baseline.included}
          valid={baseline.valid}
        />
        <RateRow
          label="Scheduled"
          hint="While conversations ran, all days."
          included={daily.included}
          valid={daily.valid}
          extra={change(daily)}
        />
        <RateRow
          label="Final"
          hint="After conversations ended."
          included={final.included}
          valid={final.valid}
          extra={change(final)}
        />
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
        <Count label="checks" one="check" value={all.total} />
        <Count label="valid" value={all.valid} />
        <Count label="mentioned only" value={all.mentioned_only} />
        <Count
          label="need review (not counted)"
          one="needs review (not counted)"
          value={all.needs_review}
          tone="warn"
        />
        <Count label="incomplete" value={all.incomplete} tone="warn" />
        <Count label="failed or unresolved" value={all.failed} tone="bad" />
        <Count label="excluded" value={all.excluded} tone="warn" />
        <Count label="canceled" value={all.canceled} />
        <Count label="pending" value={all.pending} />
      </ul>
    </div>
  );
}

function GroupCard({
  group,
  rows,
  total,
}: {
  group: Row<"comparison_groups">;
  rows: CheckMetrics[];
  total: number;
}) {
  const regular = rows.filter((row) => !row.is_held_out);
  const heldOut = rows.filter((row) => row.is_held_out);
  const days = [
    ...new Set(
      rows
        .filter((row) => row.phase === "daily" && row.local_day)
        .map((row) => row.local_day as string),
    ),
  ].sort();
  const hasHeldOut = heldOut.length > 0;
  const chartRows: ChartRow[] = days.map((day) => {
    const row: ChartRow = { label: shortDay(day) };
    for (const [key, source] of [
      ["regular", regular],
      ["held_out", heldOut],
    ] as const) {
      const totals = sum(source.filter((item) => item.phase === "daily" && item.local_day === day));
      row[key] = totals.valid > 0 ? Math.round((totals.included / totals.valid) * 1000) / 10 : null;
      row[`${key}_detail`] = totals.valid > 0 ? `${totals.included} of ${totals.valid} valid` : "";
    }
    return row;
  });
  const baseline = sum(regular.filter((row) => row.phase === "baseline"));
  const baselineRate = rate(baseline.included, baseline.valid);
  const series = [
    { key: "regular", label: "Regular questions", color: CATEGORICAL[0] },
    ...(hasHeldOut
      ? [{ key: "held_out", label: "Held-out questions", color: CATEGORICAL[1] }]
      : []),
  ];

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {total > 1 ? `Comparison group ${group.sequence}` : "Fresh-check comparison"}
            {group.started_mid_campaign ? <Badge tone="warn">Started mid-campaign</Badge> : null}
          </span>
        }
        description={
          <>
            <span className="font-mono text-xs">{group.model}</span> · {paramsText(group.params)} ·
            output cap {formatNumber(group.max_output_tokens)} · allocation {group.baseline_samples}{" "}
            baseline, {group.daily_checks} per active day, {group.final_samples} final
          </>
        }
      />
      <CardBody className="flex flex-col gap-6">
        <PhaseRows
          title="Regular questions"
          hint="Fresh-check inclusion: share of valid answers that list the business."
          rows={regular}
        />
        <PhaseRows
          title="Held-out questions"
          hint="Questions the campaign never uses as an initial question, reported on their own."
          rows={heldOut}
        />
        {rows.length === 0 ? (
          <p className="text-ink-muted text-[13px]">
            No fresh checks have been recorded for this group yet.
          </p>
        ) : null}
        {days.length > 0 ? (
          <ChartFrame
            className="border-0 p-0 shadow-none sm:p-0"
            title="Scheduled fresh-check inclusion per day"
            description="Share of valid checks that list the business, by campaign day. Days with few checks move a lot; the tooltip and table show the counts."
            legend={series.map((item) => ({
              label: item.label,
              color: item.color,
              shape: "line" as const,
            }))}
            table={{
              columns: [
                { key: "label", label: "Day" },
                { key: "regular_text", label: "Regular questions", numeric: true },
                ...(hasHeldOut
                  ? [{ key: "held_out_text", label: "Held-out questions", numeric: true }]
                  : []),
              ],
              rows: chartRows.map((row) => ({
                label: row.label,
                regular_text:
                  row.regular === null
                    ? "No valid checks"
                    : `${row.regular}% (${row.regular_detail})`,
                held_out_text:
                  row.held_out === null || row.held_out === undefined
                    ? "No valid checks"
                    : `${row.held_out}% (${row.held_out_detail})`,
              })),
            }}
          >
            <RateLineChart
              data={chartRows}
              series={series}
              reference={
                baselineRate === null
                  ? null
                  : {
                      value: Math.round(baselineRate * 1000) / 10,
                      label: `Baseline ${formatPercent(baselineRate, 1)} (${baseline.included} of ${baseline.valid})`,
                    }
              }
              ariaLabel="Scheduled fresh-check inclusion rate per day"
            />
          </ChartFrame>
        ) : null}
      </CardBody>
    </Card>
  );
}

export function ActivityChart({ rows }: { rows: DailyActivityRow[] }) {
  const data = rows.map((row) => ({
    label: shortDay(row.local_day),
    completed: Number(row.conversations_completed),
    other: Number(row.conversations_other),
    skipped: Number(row.slots_skipped),
    cost: Number(row.cost_usd),
    day: row.local_day,
    final: Number(row.final_valid) > 0 ? `${row.final_included} of ${row.final_valid}` : "—",
  }));
  return (
    <ChartFrame
      title="Conversations completed per day"
      description="By campaign day. Skipped slots and conversations with problems are in the table."
      table={{
        columns: [
          { key: "day", label: "Day" },
          { key: "completed", label: "Completed", numeric: true },
          { key: "other", label: "Other outcomes", numeric: true },
          { key: "skipped", label: "Slots skipped", numeric: true },
          { key: "final", label: "Final response included", numeric: true },
          { key: "cost", label: "Estimated cost", numeric: true },
        ],
        rows: data.map((row) => ({
          day: formatDate(row.day),
          completed: formatNumber(row.completed),
          other: formatNumber(row.other),
          skipped: formatNumber(row.skipped),
          final: row.final,
          cost: formatUsd(row.cost),
        })),
      }}
      empty={data.length === 0 ? "No conversations have been dispatched yet." : undefined}
    >
      <TimeBarChart
        data={data}
        series={[{ key: "completed", label: "Completed conversations", color: CATEGORICAL[0] }]}
        ariaLabel="Conversations completed per campaign day"
      />
    </ChartFrame>
  );
}

export function FreshCheckComparisons({
  groups,
  rows,
  heading = true,
}: {
  groups: Row<"comparison_groups">[];
  rows: CheckMetrics[];
  heading?: boolean;
}) {
  return (
    <section aria-labelledby="results-checks" className="flex flex-col gap-4">
      <div>
        {heading ? (
          <h2 id="results-checks" className="text-ink text-[15px] font-semibold">
            Fresh checks
          </h2>
        ) : (
          <h2 id="results-checks" className="sr-only">
            Fresh-check comparisons
          </h2>
        )}
        <p className="text-ink-muted text-[13px]">
          Independent single questions with no conversation history and no mention of the business,
          sampled before, during and after the conversations. A change here is an observation, not
          proof of cause: answers also vary from request to request.
        </p>
      </div>
      {groups.length > 1 ? (
        <Callout tone="info" title="Fresh-check settings changed during this campaign">
          Each comparison group has its own question-set version, allocation and model settings, and
          its own baseline. Groups are never blended.
        </Callout>
      ) : null}
      {groups.length === 0 ? (
        <p className="border-line-strong bg-surface text-ink-muted rounded-2xl border border-dashed px-4 py-8 text-center text-[13px]">
          This campaign has no fresh checks configured.
        </p>
      ) : (
        groups.map((group) => (
          <GroupCard
            key={group.id}
            group={group}
            rows={rows.filter((row) => row.comparison_group_id === group.id)}
            total={groups.length}
          />
        ))
      )}
    </section>
  );
}

/** Conversation and fresh-check results of one campaign, each metric with its own denominator. */
export async function CampaignResults({
  supabase,
  campaignId,
  launched,
}: {
  supabase: ServerClient;
  campaignId: string;
  launched: boolean;
}) {
  const [conversations, checks, groups, activity] = await Promise.all([
    supabase.rpc("campaign_conversation_metrics", { p_campaign_id: campaignId }),
    supabase.rpc("campaign_check_metrics", { p_campaign_id: campaignId }),
    supabase.from("comparison_groups").select("*").eq("campaign_id", campaignId).order("sequence"),
    supabase.rpc("campaign_daily_activity", { p_campaign_id: campaignId }),
  ]);
  if (conversations.error || checks.error || activity.error)
    throw new Error("Results could not be loaded.");
  const cohorts = conversations.data ?? [];
  const checkRows = checks.data ?? [];
  const groupRows = groups.data ?? [];

  if (!launched) {
    return (
      <EmptyState
        title="No results yet"
        description="Results appear here after the campaign is launched and its first fresh checks and conversations complete."
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <ApiResultsNote />

      <section aria-labelledby="results-conversations" className="flex flex-col gap-4">
        <div>
          <h2 id="results-conversations" className="text-ink text-[15px] font-semibold">
            Conversations
          </h2>
          <p className="text-ink-muted text-[13px]">
            What the model answered inside the campaign&apos;s own conversations. Test conversations
            are left out. Each model-and-settings combination is reported on its own.
          </p>
        </div>
        {cohorts.length > 1 ? (
          <Callout tone="info" title="More than one model or settings combination was used">
            Results are shown per combination and are not averaged together.
          </Callout>
        ) : null}
        {cohorts.length === 0 ? (
          <p className="border-line-strong bg-surface text-ink-muted rounded-2xl border border-dashed px-4 py-8 text-center text-[13px]">
            No conversations have run yet.
          </p>
        ) : (
          cohorts.map((cohort, index) => (
            <CohortCard
              key={cohort.cohort_key ?? index}
              cohort={cohort}
              index={index}
              total={cohorts.length}
            />
          ))
        )}
      </section>

      <FreshCheckComparisons groups={groupRows} rows={checkRows} />

      <ActivityChart rows={activity.data ?? []} />
    </div>
  );
}
