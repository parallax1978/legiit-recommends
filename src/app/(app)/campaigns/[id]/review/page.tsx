import { CircleCheck, CircleX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  DiscardChangesButton,
  TestConversationButton,
} from "@/components/campaigns/campaign-actions";
import { EstimatePanel } from "@/components/campaigns/campaign-editor";
import { ConfigSummary } from "@/components/campaigns/config-summary";
import { ApplyChangesButton, LaunchButton } from "@/components/campaigns/launch-buttons";
import { CampaignStatusBadge } from "@/components/status";
import { ButtonLink } from "@/components/ui/button";
import { Callout, Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { PermissionNote, Screen } from "@/components/ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate, formatDateTime, formatNumber, formatUsd } from "@/lib/format";
import {
  loadCampaign,
  loadProbeSetSummary,
  loadRevision,
  loadRevisionSteps,
  type Revision,
} from "@/lib/queries/campaign";
import type { LaunchCheck, PlanPreview } from "@/lib/queries/types";
import { hasRole, requireSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Review campaign" };

export default function ReviewCampaignPage(props: PageProps<"/campaigns/[id]/review">) {
  return (
    <Screen>
      <Review params={props.params} />
    </Screen>
  );
}

const CHANGE_LABELS: [keyof Revision, string][] = [
  ["business_name", "Business name"],
  ["website_url", "Website"],
  ["business_aliases", "Other accepted names"],
  ["domain_aliases", "Other accepted domains"],
  ["category", "Category or topic"],
  ["location", "Market or location"],
  ["language", "Language"],
  ["connection_id", "Connection"],
  ["model", "Model"],
  ["model_params", "Model settings"],
  ["max_output_tokens", "Output cap"],
  ["execution_mode", "Execution"],
  ["end_at", "End"],
  ["timezone", "Timezone"],
  ["active_weekdays", "Active days"],
  ["active_start_minute", "Active hours start"],
  ["active_end_minute", "Active hours end"],
  ["conversations_per_day", "Conversations per day"],
  ["total_conversation_limit", "Total conversation limit"],
  ["max_concurrency", "Conversations at once"],
  ["requests_per_minute", "Requests per minute"],
  ["tokens_per_minute", "Tokens per minute"],
  ["jitter_seconds", "Random offset"],
  ["missed_slot_behavior", "Missed slots"],
  ["catch_up_max_delay_minutes", "Catch-up window"],
  ["catch_up_max_per_day", "Catch-up per day"],
  ["daily_budget_usd", "Daily budget"],
  ["total_budget_usd", "Total budget"],
  ["on_existing_inclusion", "If already in the first answer"],
  ["selection_mode", "Wording selection"],
  ["selection_seed", "Selection seed"],
  ["probe_set_id", "Question set"],
  ["baseline_samples", "Baseline checks"],
  ["daily_checks", "Checks per active day"],
  ["final_samples", "Final checks"],
  ["check_model", "Fresh-check model"],
  ["check_params", "Fresh-check settings"],
  ["check_max_output_tokens", "Fresh-check output cap"],
];
const GROUP_FIELDS: (keyof Revision)[] = [
  "probe_set_id",
  "baseline_samples",
  "daily_checks",
  "final_samples",
  "check_model",
  "check_params",
  "check_max_output_tokens",
  "selection_seed",
];

async function Review({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSession();
  const supabase = await createClient();
  const campaign = await loadCampaign(supabase, session, id);
  const isAdmin = hasRole(session.role, "admin");
  const isDraft = campaign.status === "draft";
  if (!campaign.draft_revision_id) {
    if (isDraft) notFound();
    return (
      <>
        <PageHeader
          title="Nothing to review"
          description="This campaign has no pending changes."
          actions={
            <ButtonLink href={`/campaigns/${campaign.id}`} variant="secondary">
              Back to campaign
            </ButtonLink>
          }
        />
      </>
    );
  }

  const [revision, steps, checkResult, previewResult] = await Promise.all([
    loadRevision(supabase, campaign.draft_revision_id),
    loadRevisionSteps(supabase, campaign.draft_revision_id),
    supabase.rpc("campaign_launch_check", { p_campaign_id: campaign.id }),
    supabase.rpc("campaign_plan_preview", { p_campaign_id: campaign.id }),
  ]);
  if (checkResult.error || previewResult.error) throw new Error("The review could not be loaded.");
  const check = checkResult.data as unknown as LaunchCheck;
  const preview = previewResult.data as unknown as PlanPreview;
  const [connection, probeSet, active, activeSteps] = await Promise.all([
    revision.connection_id
      ? supabase
          .from("provider_connections")
          .select("name")
          .eq("id", revision.connection_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    loadProbeSetSummary(supabase, revision),
    !isDraft && campaign.active_revision_id
      ? loadRevision(supabase, campaign.active_revision_id)
      : Promise.resolve(null),
    !isDraft && campaign.active_revision_id
      ? loadRevisionSteps(supabase, campaign.active_revision_id)
      : Promise.resolve(null),
  ]);

  const ready = check.problems.length === 0;
  const changes = active
    ? CHANGE_LABELS.filter(
        ([key]) => JSON.stringify(revision[key] ?? null) !== JSON.stringify(active[key] ?? null),
      ).map(([, label]) => label)
    : [];
  const stepsChanged =
    active && activeSteps
      ? JSON.stringify(steps.map((step) => step.wordings.map((wording) => wording.versionId))) !==
        JSON.stringify(activeSteps.map((step) => step.wordings.map((wording) => wording.versionId)))
      : false;
  const questionSetVersionChanged = Boolean(
    active &&
    probeSet &&
    active.probe_set_version_id &&
    probeSet.versionId !== active.probe_set_version_id,
  );
  const newGroup =
    Boolean(active) &&
    (questionSetVersionChanged ||
      GROUP_FIELDS.some(
        (key) => JSON.stringify(revision[key] ?? null) !== JSON.stringify(active![key] ?? null),
      ));
  const cohortChanged =
    Boolean(active) &&
    (["model", "model_params", "max_output_tokens"] as (keyof Revision)[]).some(
      (key) => JSON.stringify(revision[key] ?? null) !== JSON.stringify(active![key] ?? null),
    );

  return (
    <>
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-1.5">
            <Link href="/campaigns" className="hover:text-brand-strong">
              Campaigns
            </Link>
            <span aria-hidden="true">/</span>
            <Link href={`/campaigns/${campaign.id}`} className="hover:text-brand-strong">
              {campaign.name}
            </Link>
          </span>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {isDraft ? "Review before launch" : "Review pending changes"}
            <CampaignStatusBadge status={campaign.status} />
          </span>
        }
        description={
          isDraft
            ? "Check exactly what will be sent, when, and what it can cost. Nothing has been sent yet; the campaign starts only when you choose Launch."
            : "These edits are not in effect. Applying them creates a new revision for future work only."
        }
        actions={
          <ButtonLink
            href={`/campaigns/${campaign.id}/edit${ready ? "" : "?check=1"}`}
            variant="secondary"
          >
            Back to editing
          </ButtonLink>
        }
      />

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-6">
          {ready ? (
            <Callout tone="good" title="The configuration is complete">
              <span className="flex items-center gap-1.5">
                <CircleCheck className="text-good size-4" aria-hidden="true" />
                Every setting needed to {isDraft ? "launch" : "apply"} is in place.
              </span>
            </Callout>
          ) : (
            <Callout
              tone="bad"
              role="alert"
              title={`${check.problems.length} thing${check.problems.length === 1 ? "" : "s"} to fix before this can ${isDraft ? "launch" : "be applied"}`}
            >
              <ul className="mt-1 flex flex-col gap-1">
                {check.problems.map((problem, index) => (
                  <li
                    key={`${problem.code}-${index}`}
                    className="text-ink flex items-start gap-1.5"
                  >
                    <CircleX className="text-bad mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    {problem.message}
                  </li>
                ))}
              </ul>
            </Callout>
          )}

          {active ? (
            <Card>
              <CardHeader
                title="What changes"
                description={`Compared with revision ${active.revision_number}, which is in effect now.`}
              />
              <CardBody className="flex flex-col gap-3">
                {changes.length === 0 && !stepsChanged && !questionSetVersionChanged ? (
                  <p className="text-ink-muted text-[13px]">
                    No settings differ from the revision in effect.
                  </p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {stepsChanged ? (
                      <li className="bg-brand-faint text-brand-strong rounded-full px-2.5 py-1 text-xs font-medium">
                        Conversation prompts
                      </li>
                    ) : null}
                    {questionSetVersionChanged ? (
                      <li className="bg-brand-faint text-brand-strong rounded-full px-2.5 py-1 text-xs font-medium">
                        Question set version
                      </li>
                    ) : null}
                    {changes.map((label) => (
                      <li
                        key={label}
                        className="bg-brand-faint text-brand-strong rounded-full px-2.5 py-1 text-xs font-medium"
                      >
                        {label}
                      </li>
                    ))}
                  </ul>
                )}
                {newGroup ? (
                  <Callout tone="warn" title="A new fresh-check comparison group will start">
                    The question set, allocation or fresh-check model settings differ, so checks
                    from now on form a separate group with its own baseline. Earlier checks stay in
                    their own group and are never blended with the new ones.
                  </Callout>
                ) : null}
                {cohortChanged ? (
                  <Callout
                    tone="warn"
                    title="Conversation results will be reported as a separate cohort"
                  >
                    The conversation model or its settings differ. Results are shown per model and
                    settings and are not averaged across them.
                  </Callout>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title="Planned schedule"
              description={
                preview.timezone
                  ? `Days in ${preview.timezone}. Conversations are spread across each day's active hours.`
                  : undefined
              }
            />
            <CardBody>
              {preview.days.length === 0 ? (
                <p className="text-ink-muted text-[13px]">
                  No days are planned yet. Complete the schedule in the editor.
                </p>
              ) : (
                <>
                  <p className="text-ink mb-3 text-[13px]">
                    {formatDateTime(preview.start_at, preview.timezone)} to{" "}
                    {formatDateTime(preview.end_at, preview.timezone)} ·{" "}
                    {formatNumber(preview.planned_conversations)} conversations over{" "}
                    {formatNumber(preview.active_days)} active day
                    {preview.active_days === 1 ? "" : "s"}
                  </p>
                  <TableWrap
                    label="Planned work per day"
                    className="max-h-72 overflow-y-auto shadow-none"
                  >
                    <Table>
                      <thead>
                        <tr>
                          <Th>Day</Th>
                          <Th className="text-right">Conversations</Th>
                          <Th className="text-right">Scheduled fresh checks</Th>
                          <Th className="text-right">Worst-case cost</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.days.map((day) => (
                          <Tr key={day.date}>
                            <Td>{formatDate(day.date)}</Td>
                            <Td className="tabular text-right">
                              {formatNumber(day.conversations)}
                            </Td>
                            <Td className="tabular text-right">{formatNumber(day.checks)}</Td>
                            <Td className="tabular text-right">
                              {preview.est_run_max_cost_usd === null
                                ? "—"
                                : formatUsd(
                                    day.conversations * Number(preview.est_run_max_cost_usd) +
                                      day.checks * Number(preview.est_check_max_cost_usd ?? 0),
                                  )}
                            </Td>
                          </Tr>
                        ))}
                      </tbody>
                    </Table>
                  </TableWrap>
                  {preview.active_days > preview.days_listed ? (
                    <p className="text-ink-muted mt-2 text-xs">
                      Showing the first {preview.days_listed} of {preview.active_days} active days.
                    </p>
                  ) : null}
                  <p className="text-ink-muted mt-3 text-xs">
                    {formatNumber(preview.baseline_checks)} baseline fresh checks run at the start,
                    before any conversation. {formatNumber(preview.final_checks)} final fresh checks
                    run after the last conversation has resolved; anything still unresolved then is
                    recorded as such and excluded.
                  </p>
                </>
              )}
            </CardBody>
          </Card>

          <ConfigSummary
            revision={revision}
            steps={steps}
            connectionName={connection.data?.name ?? null}
            probeSet={probeSet}
          />
        </div>

        <aside className="flex flex-col gap-4 xl:sticky xl:top-20" aria-label="Launch">
          <div className="border-line bg-surface shadow-card rounded-2xl border p-5">
            {isAdmin ? (
              <div className="flex flex-col gap-2">
                {isDraft ? (
                  <LaunchButton
                    campaignId={campaign.id}
                    revisionId={revision.id}
                    disabled={!ready}
                    summary={`${formatNumber(preview.planned_conversations)} conversations and ${formatNumber(preview.baseline_checks + preview.scheduled_checks + preview.final_checks)} fresh checks are planned, about ${formatNumber(preview.provider_requests)} provider requests, with a worst-case cost of ${formatUsd(preview.max_cost_usd)} against a total budget of ${formatUsd(preview.total_budget_usd)}.`}
                  />
                ) : (
                  <ApplyChangesButton
                    campaignId={campaign.id}
                    revisionId={revision.id}
                    disabled={!ready}
                    newGroup={newGroup}
                  />
                )}
                <TestConversationButton
                  campaignId={campaign.id}
                  disabled={check.test_problems.length > 0}
                />
                {!isDraft ? <DiscardChangesButton campaignId={campaign.id} /> : null}
                <p className="text-ink-muted mt-1 text-xs">
                  {isDraft
                    ? "Launch is the only step that starts paid campaign work."
                    : "Applying affects only work dispatched from now on."}{" "}
                  A test conversation runs one full sequence now with its own budget check and is
                  kept out of the results.
                </p>
                {check.test_problems.length > 0 ? (
                  <p className="text-warn text-xs">
                    A test conversation needs the business, prompts, connection, model and output
                    cap to be set.
                  </p>
                ) : null}
              </div>
            ) : (
              <PermissionNote>
                Only admins and owners can launch or change campaigns.
              </PermissionNote>
            )}
          </div>
          <EstimatePanel preview={preview} />
        </aside>
      </div>
    </>
  );
}
