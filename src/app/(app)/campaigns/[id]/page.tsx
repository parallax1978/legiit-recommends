import { Download } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { CampaignControls, TestConversationButton } from "@/components/campaigns/campaign-actions";
import { ConfigSummary } from "@/components/campaigns/config-summary";
import { WordingCoverage } from "@/components/campaigns/wording-coverage";
import { Meter } from "@/components/charts/figures";
import { RetryJobButton } from "@/components/operations-buttons";
import { CampaignResults } from "@/components/results/campaign-results";
import { RunsTable } from "@/components/runs-table";
import { CampaignStatusBadge, JobStatusBadge } from "@/components/status";
import { ButtonLink } from "@/components/ui/button";
import {
  Badge,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
  Stat,
} from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { DefinitionList, Screen, Tabs } from "@/components/ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import {
  formatClock,
  formatDate,
  formatDateTime,
  formatNumber,
  formatShare,
  formatUsd,
} from "@/lib/format";
import { errorClass, humanize, jobKind, pauseReason, reasonText } from "@/lib/labels";
import { first, type SearchParams } from "@/lib/params";
import {
  loadCampaign,
  loadProbeSetSummary,
  loadRevision,
  loadRevisionSteps,
  type Campaign,
  type Revision,
} from "@/lib/queries/campaign";
import { listRuns } from "@/lib/queries/runs";
import type { BudgetStatus, PlanPreview } from "@/lib/queries/types";
import { hasRole, requireSession, type Session } from "@/lib/session";
import { createClient, type ServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Campaign" };

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "results", label: "Results" },
  { id: "conversations", label: "Conversations" },
  { id: "activity", label: "Activity" },
  { id: "configuration", label: "Configuration" },
];

export default function CampaignPage(props: PageProps<"/campaigns/[id]">) {
  return (
    <Screen>
      <CampaignDetail params={props.params} searchParams={props.searchParams} />
    </Screen>
  );
}

function ExportLinks({ campaignId, launched }: { campaignId: string; launched: boolean }) {
  const link =
    "inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-surface-alt";
  const base = `/exports/campaigns/${campaignId}`;
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Exports">
      <span className="text-ink-muted flex items-center gap-1 text-xs font-medium">
        <Download className="size-3.5" aria-hidden="true" />
        Export
      </span>
      {launched ? (
        <>
          <a className={link} href={`${base}/conversations.csv`} download>
            Conversation results (CSV)
          </a>
          <a className={link} href={`${base}/fresh-checks.csv`} download>
            Fresh checks (CSV)
          </a>
          <a className={link} href={`${base}/usage.csv`} download>
            Usage (CSV)
          </a>
          <a className={link} href={`${base}/transcripts.json`} download>
            Transcripts (JSON)
          </a>
        </>
      ) : null}
      <a className={link} href={`${base}/config.json`} download>
        Configuration (JSON)
      </a>
    </div>
  );
}

async function CampaignDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const session = await requireSession();
  const supabase = await createClient();
  const campaign = await loadCampaign(supabase, session, id);
  const requested = first(query.tab);
  const tab = TABS.some((item) => item.id === requested) ? requested : "overview";
  const isAdmin = hasRole(session.role, "admin");
  const revisionId = campaign.active_revision_id ?? campaign.draft_revision_id;
  if (!revisionId) throw new Error("This campaign has no configuration.");
  const revision = await loadRevision(supabase, revisionId);
  const launched = campaign.status !== "draft";
  const hasPendingChanges = launched && Boolean(campaign.draft_revision_id);
  const target = {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    archived: Boolean(campaign.archived_at),
    everLaunched: Boolean(campaign.launched_at),
  };

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/campaigns" className="hover:text-brand-strong">
            Campaigns
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {campaign.name}
            <CampaignStatusBadge
              status={campaign.status}
              archived={Boolean(campaign.archived_at)}
            />
          </span>
        }
        description={
          <>
            {revision.business_name ?? "No business set"}
            {revision.category ? ` · ${revision.category}` : ""}
            {revision.location ? ` · ${revision.location}` : ""}
            {campaign.description ? (
              <span className="mt-1 block">{campaign.description}</span>
            ) : null}
          </>
        }
        actions={
          <>
            {isAdmin &&
            !campaign.archived_at &&
            !["completed", "canceled"].includes(campaign.status) ? (
              <TestConversationButton campaignId={campaign.id} />
            ) : null}
            <CampaignControls
              campaign={target}
              isAdmin={isAdmin}
              hasPendingChanges={hasPendingChanges}
            />
          </>
        }
      />

      {campaign.status === "paused" ? (
        <Callout tone="warn" className="mb-4" title={pauseReason(campaign.pause_reason)}>
          {campaign.pause_detail ? `${campaign.pause_detail} ` : ""}
          Nothing new is dispatched while paused. Requests that were already sent are shown until
          they resolve. Slots that pass while paused follow the missed-slot setting.
        </Callout>
      ) : null}
      {hasPendingChanges ? (
        <Callout
          tone="info"
          className="mb-4"
          title="There are unapplied changes"
          action={
            isAdmin ? (
              <ButtonLink href={`/campaigns/${campaign.id}/review`} variant="secondary" size="sm">
                Review changes
              </ButtonLink>
            ) : null
          }
        >
          The campaign keeps running with revision {revision.revision_number} until they are
          applied.
        </Callout>
      ) : null}
      {campaign.status === "draft" && !campaign.archived_at ? (
        <Callout tone="neutral" className="mb-4" title="This campaign is a draft">
          Nothing has been sent to the provider. Finish the setup, then review and launch it.
        </Callout>
      ) : null}

      <Tabs
        label="Campaign sections"
        active={tab}
        tabs={TABS.map((item) => ({
          ...item,
          href:
            item.id === "overview"
              ? `/campaigns/${campaign.id}`
              : `/campaigns/${campaign.id}?tab=${item.id}`,
        }))}
      />

      {tab === "overview" ? (
        <OverviewTab
          supabase={supabase}
          session={session}
          campaign={campaign}
          revision={revision}
        />
      ) : null}
      {tab === "results" ? (
        <div className="flex flex-col gap-6">
          <CampaignResults supabase={supabase} campaignId={campaign.id} launched={launched} />
          <ExportLinks campaignId={campaign.id} launched={launched} />
        </div>
      ) : null}
      {tab === "conversations" ? (
        <ConversationsTab supabase={supabase} session={session} campaign={campaign} />
      ) : null}
      {tab === "activity" ? (
        <ActivityTab
          supabase={supabase}
          session={session}
          campaign={campaign}
          revision={revision}
        />
      ) : null}
      {tab === "configuration" ? (
        <ConfigurationTab
          supabase={supabase}
          campaign={campaign}
          revision={revision}
          launched={launched}
        />
      ) : null}
    </>
  );
}

function Phase({
  label,
  at,
  zone,
  state,
}: {
  label: string;
  at: string | null;
  zone: string | null;
  state: "done" | "current" | "todo";
}) {
  return (
    <li className="flex min-w-0 flex-1 items-start gap-2.5">
      <span
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold",
          state === "done"
            ? "border-brand bg-brand text-white"
            : state === "current"
              ? "border-brand bg-brand-faint text-brand-strong"
              : "border-line-strong bg-surface text-ink-soft",
        )}
        aria-hidden="true"
      >
        {state === "done" ? "✓" : ""}
      </span>
      <span className="min-w-0">
        <span
          className={cn(
            "block text-[13px] font-medium",
            state === "todo" ? "text-ink-muted" : "text-ink",
          )}
        >
          {label}
          {state === "current" ? <span className="sr-only"> (current)</span> : null}
        </span>
        <span className="text-ink-muted block text-xs">
          {at ? formatDateTime(at, zone) : state === "current" ? "In progress" : "—"}
        </span>
      </span>
    </li>
  );
}

async function OverviewTab({
  supabase,
  session,
  campaign,
  revision,
}: {
  supabase: ServerClient;
  session: Session;
  campaign: Campaign;
  revision: Revision;
}) {
  const zone = revision.timezone;
  const [summaries, budgets, preview, attention, recent] = await Promise.all([
    supabase.rpc("campaign_summaries", { p_workspace_id: session.workspace.id }),
    supabase.rpc("budget_status", { p_workspace_id: session.workspace.id }),
    supabase.rpc("campaign_plan_preview", { p_campaign_id: campaign.id }),
    supabase
      .from("jobs")
      .select("id, kind, status, status_reason, last_error_class, last_error_message, run_id")
      .eq("campaign_id", campaign.id)
      .in("status", ["dead", "blocked"])
      .order("updated_at", { ascending: false })
      .limit(5),
    listRuns(supabase, { workspaceId: session.workspace.id, campaignId: campaign.id }, 1, 5),
  ]);
  const summary = (summaries.data ?? []).find((item) => item.id === campaign.id);
  const budget = ((budgets.data as unknown as BudgetStatus | null)?.campaigns ?? []).find(
    (item) => item.campaign_id === campaign.id,
  );
  const plan = preview.data as unknown as PlanPreview | null;
  const isAdmin = hasRole(session.role, "admin");
  const order = ["scheduled", "baseline", "running", "finalizing", "completed"];
  const effective =
    campaign.status === "paused" ? (campaign.paused_from ?? "running") : campaign.status;
  const position = order.indexOf(effective);
  const state = (index: number): "done" | "current" | "todo" =>
    campaign.status === "completed" || index < position
      ? "done"
      : index === position
        ? "current"
        : "todo";

  if (campaign.status === "draft") {
    return (
      <EmptyState
        title="Not launched yet"
        description="Progress, spend and results appear here once the campaign is launched."
        action={
          isAdmin ? (
            <>
              <ButtonLink href={`/campaigns/${campaign.id}/edit`} variant="secondary">
                Continue setup
              </ButtonLink>
              <ButtonLink href={`/campaigns/${campaign.id}/review`}>Review and launch</ButtonLink>
            </>
          ) : null
        }
      />
    );
  }

  const nextSlot =
    summary?.next_slot_at &&
    ["scheduled", "baseline", "running", "finalizing"].includes(campaign.status)
      ? summary.next_slot_at
      : null;
  const spentTotal = Number(budget?.spent_total_usd ?? summary?.spend_total_usd ?? 0);
  const openTotal = Number(budget?.open_total_usd ?? 0);
  const spentToday = Number(budget?.spent_today_usd ?? 0) + Number(budget?.reserved_today_usd ?? 0);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardBody>
          <ol className="flex flex-col gap-4 sm:flex-row sm:gap-3">
            <Phase label="Launched" at={campaign.launched_at} zone={zone} state="done" />
            {/* A campaign without fresh checks passes straight through these two phases. */}
            {(revision.baseline_samples ?? 0) > 0 ? (
              <Phase
                label="Baseline checks"
                at={campaign.baseline_completed_at ?? (position >= 1 ? campaign.started_at : null)}
                zone={zone}
                state={campaign.baseline_completed_at ? "done" : state(1)}
              />
            ) : null}
            <Phase
              label="Conversations"
              at={campaign.conversations_ended_at}
              zone={zone}
              state={campaign.conversations_ended_at ? "done" : state(2)}
            />
            {(revision.final_samples ?? 0) > 0 ? (
              <Phase
                label="Final checks"
                at={campaign.completed_at ?? campaign.final_checks_started_at}
                zone={zone}
                state={state(3)}
              />
            ) : null}
            <Phase
              label={campaign.status === "canceled" ? "Canceled" : "Completed"}
              at={campaign.completed_at ?? campaign.canceled_at}
              zone={zone}
              state={
                campaign.status === "completed" || campaign.status === "canceled" ? "done" : "todo"
              }
            />
          </ol>
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Conversations completed"
          value={formatNumber(summary?.runs_completed ?? 0)}
          detail={`of ${formatNumber(plan?.planned_conversations ?? null)} planned · ${formatNumber(summary?.runs_in_progress ?? 0)} in progress · ${formatNumber(summary?.runs_problem ?? 0)} with problems`}
        />
        <Stat
          label="Final-response inclusion"
          value={
            summary && summary.final_valid > 0
              ? `${Math.round((summary.final_included / summary.final_valid) * 100)}%`
              : "—"
          }
          detail={
            summary && summary.final_valid > 0
              ? `${formatShare(summary.final_included, summary.final_valid)} valid final responses`
              : "No valid final responses yet"
          }
        />
        <Stat
          label="Fresh checks completed"
          value={formatNumber(summary?.checks_completed ?? 0)}
          detail={
            plan
              ? `of ${formatNumber(plan.baseline_checks + plan.scheduled_checks + plan.final_checks)} planned (baseline, scheduled, final)`
              : undefined
          }
        />
        <Stat
          label="Next scheduled slot"
          value={nextSlot ? formatClock(nextSlot, zone) : "—"}
          detail={
            nextSlot
              ? `${formatDate(nextSlot, zone)}${zone ? ` · ${zone}` : ""}`
              : zone
                ? `Campaign timezone: ${zone}`
                : undefined
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Budget"
            description="Estimated from recorded usage, plus amounts reserved for requests in flight or unresolved."
          />
          <CardBody className="flex flex-col gap-5">
            <div>
              <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[13px]">
                <span className="text-ink font-medium">Total</span>
                <span className="tabular text-ink-muted">
                  <span className="text-ink font-semibold">
                    {formatUsd(spentTotal + openTotal)}
                  </span>{" "}
                  of {formatUsd(revision.total_budget_usd)}
                </span>
              </div>
              <Meter
                value={spentTotal + openTotal}
                max={revision.total_budget_usd === null ? null : Number(revision.total_budget_usd)}
                label="Total budget used"
              />
              <p className="text-ink-muted mt-1.5 text-xs">
                {formatUsd(spentTotal)} recorded · {formatUsd(openTotal)} reserved or unresolved ·{" "}
                {formatUsd(revision.final_check_set_aside_usd)} set aside for final checks
              </p>
            </div>
            <div>
              <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[13px]">
                <span className="text-ink font-medium">Today{zone ? ` (${zone})` : ""}</span>
                <span className="tabular text-ink-muted">
                  <span className="text-ink font-semibold">{formatUsd(spentToday)}</span>{" "}
                  {revision.daily_budget_usd === null
                    ? "· no daily limit"
                    : `of ${formatUsd(revision.daily_budget_usd)}`}
                </span>
              </div>
              <Meter
                value={spentToday}
                max={revision.daily_budget_usd === null ? null : Number(revision.daily_budget_usd)}
                label="Daily budget used"
              />
            </div>
            {budget && (budget.budget_skips > 0 || budget.budget_blocked > 0) ? (
              <Callout tone="warn" title="A budget has been reached">
                {formatNumber(budget.budget_skips)} slot
                {budget.budget_skips === 1 ? " was" : "s were"} skipped and{" "}
                {formatNumber(budget.budget_blocked)} job
                {budget.budget_blocked === 1 ? " is" : "s are"} waiting because a request did not
                fit a budget.
              </Callout>
            ) : null}
            {plan && plan.observed_estimate_usd !== null && plan.observed_runs > 0 ? (
              <p className="text-ink-muted text-xs">
                Completed conversations have averaged{" "}
                {formatUsd(plan.observed_avg_run_cost_usd, { precise: true })} each. At that rate
                all {formatNumber(plan.planned_conversations)} planned conversations would cost
                about {formatUsd(plan.observed_estimate_usd)}
                {revision.total_budget_usd !== null &&
                Number(plan.observed_estimate_usd) > Number(revision.total_budget_usd)
                  ? " — more than the total budget, so the campaign would stop early."
                  : "."}
              </p>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Needs attention" />
          <CardBody>
            {(attention.data ?? []).length === 0 && !(summary && summary.needs_review > 0) ? (
              <p className="text-ink-muted text-[13px]">Nothing needs attention.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {summary && summary.needs_review > 0 ? (
                  <li>
                    <Link
                      href={`/conversations?campaign=${campaign.id}&inclusion=ambiguous`}
                      className="border-line hover:bg-surface-alt block rounded-xl border px-3 py-2 text-[13px]"
                    >
                      <span className="font-semibold">{formatNumber(summary.needs_review)}</span>{" "}
                      response{summary.needs_review === 1 ? "" : "s"} could not be classified by the
                      rules and {summary.needs_review === 1 ? "is" : "are"} not counted until
                      reviewed.
                    </Link>
                  </li>
                ) : null}
                {(attention.data ?? []).map((job) => (
                  <li
                    key={job.id}
                    className="border-line flex items-start justify-between gap-3 rounded-xl border px-3 py-2 text-[13px]"
                  >
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2 font-medium">
                        {job.run_id ? (
                          <Link
                            href={`/conversations/${job.run_id}`}
                            className="hover:text-brand-strong"
                          >
                            {jobKind(job.kind)}
                          </Link>
                        ) : (
                          jobKind(job.kind)
                        )}
                        <JobStatusBadge status={job.status} />
                      </span>
                      <span className="text-ink-muted block text-xs break-words">
                        {reasonText(job.status_reason) ??
                          errorClass(job.last_error_class) ??
                          job.last_error_message}
                      </span>
                    </span>
                    {isAdmin ? <RetryJobButton jobId={job.id} /> : null}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-ink text-[15px] font-semibold">Latest conversations</h2>
          <Link
            href={`/campaigns/${campaign.id}?tab=conversations`}
            className="text-brand hover:text-brand-strong text-[13px] font-medium"
          >
            View all
          </Link>
        </div>
        {recent.rows.length === 0 ? (
          <p className="border-line-strong bg-surface text-ink-muted rounded-2xl border border-dashed px-4 py-8 text-center text-[13px]">
            No conversations yet.{" "}
            {campaign.status === "scheduled" || campaign.status === "baseline"
              ? (revision.baseline_samples ?? 0) > 0
                ? "They begin after the baseline fresh checks."
                : "They begin at the start time."
              : ""}
          </p>
        ) : (
          <RunsTable rows={recent.rows} showCampaign={false} />
        )}
      </div>
    </div>
  );
}

async function ConversationsTab({
  supabase,
  session,
  campaign,
}: {
  supabase: ServerClient;
  session: Session;
  campaign: Campaign;
}) {
  const { rows, total } = await listRuns(
    supabase,
    { workspaceId: session.workspace.id, campaignId: campaign.id },
    1,
    20,
  );
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No conversations yet"
        description="Each conversation run by this campaign, including test conversations, is listed here with its full transcript."
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="mb-3">
        <WordingCoverage supabase={supabase} campaignId={campaign.id} />
      </div>
      <RunsTable rows={rows} showCampaign={false} />
      <p className="text-ink-muted text-xs">
        Showing the latest {formatNumber(rows.length)} of {formatNumber(total)}.{" "}
        <Link
          href={`/conversations?campaign=${campaign.id}`}
          className="text-brand hover:text-brand-strong font-medium"
        >
          Open in the conversation explorer
        </Link>{" "}
        to filter and page through all of them.
      </p>
    </div>
  );
}

async function ActivityTab({
  supabase,
  session,
  campaign,
  revision,
}: {
  supabase: ServerClient;
  session: Session;
  campaign: Campaign;
  revision: Revision;
}) {
  const isAdmin = hasRole(session.role, "admin");
  const zone = revision.timezone;
  const [upcoming, recent, audit] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, kind, status, scheduled_for, is_catch_up")
      .eq("campaign_id", campaign.id)
      .eq("status", "pending")
      .order("scheduled_for")
      .limit(12),
    supabase
      .from("jobs")
      .select(
        "id, kind, status, status_reason, scheduled_for, finished_at, attempts, max_attempts, is_catch_up, last_error_class, run_id, fresh_check_id",
      )
      .eq("campaign_id", campaign.id)
      .neq("status", "pending")
      .order("scheduled_for", { ascending: false })
      .limit(40),
    isAdmin
      ? supabase
          .from("audit_events")
          .select("id, action, actor_kind, created_at, details")
          .eq("workspace_id", session.workspace.id)
          .eq("entity_id", campaign.id)
          .order("created_at", { ascending: false })
          .limit(30)
      : Promise.resolve({ data: null }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Coming up"
            description={`Planned up to ${campaign.planned_through ? formatDateTime(campaign.planned_through, zone) : "—"}. Further slots are added as time passes.`}
          />
          <CardBody>
            {(upcoming.data ?? []).length === 0 ? (
              <p className="text-ink-muted text-[13px]">Nothing is scheduled.</p>
            ) : (
              <ul className="divide-line divide-y">
                {(upcoming.data ?? []).map((job) => (
                  <li
                    key={job.id}
                    className="flex items-center justify-between gap-3 py-2 text-[13px] first:pt-0 last:pb-0"
                  >
                    <span className="font-medium">
                      {jobKind(job.kind)}{" "}
                      {job.is_catch_up ? <Badge tone="info">Catch-up</Badge> : null}
                    </span>
                    <span className="text-ink-muted">
                      <LocalTime value={job.scheduled_for} timeZone={zone} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
        {isAdmin ? (
          <Card>
            <CardHeader
              title="Changes"
              description="Lifecycle and configuration changes to this campaign."
            />
            <CardBody>
              {(audit.data ?? []).length === 0 ? (
                <p className="text-ink-muted text-[13px]">Nothing recorded yet.</p>
              ) : (
                <ul className="divide-line divide-y">
                  {(audit.data ?? []).map((event) => (
                    <li
                      key={event.id}
                      className="flex items-center justify-between gap-3 py-2 text-[13px] first:pt-0 last:pb-0"
                    >
                      <span className="font-medium">
                        {humanize(event.action.replace(/^campaign\./, "").replace(/\./g, " "))}
                      </span>
                      <span className="text-ink-muted text-right text-xs">
                        {event.actor_kind === "user" ? "by a person" : `by the ${event.actor_kind}`}{" "}
                        · <LocalTime value={event.created_at} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        ) : null}
      </div>

      <div>
        <h2 className="text-ink mb-3 text-[15px] font-semibold">Recent work</h2>
        {(recent.data ?? []).length === 0 ? (
          <p className="border-line-strong bg-surface text-ink-muted rounded-2xl border border-dashed px-4 py-8 text-center text-[13px]">
            No work has been dispatched yet.
          </p>
        ) : (
          <TableWrap label="Recent work">
            <Table>
              <thead>
                <tr>
                  <Th>Work</Th>
                  <Th>Scheduled</Th>
                  <Th>Status</Th>
                  <Th>Detail</Th>
                  <Th className="text-right">Attempts</Th>
                </tr>
              </thead>
              <tbody>
                {(recent.data ?? []).map((job) => (
                  <Tr key={job.id}>
                    <Td>
                      {job.run_id ? (
                        <Link
                          href={`/conversations/${job.run_id}`}
                          className="hover:text-brand-strong font-medium"
                        >
                          {jobKind(job.kind)}
                        </Link>
                      ) : job.fresh_check_id ? (
                        <Link
                          href={`/fresh-checks/${job.fresh_check_id}`}
                          className="hover:text-brand-strong font-medium"
                        >
                          {jobKind(job.kind)}
                        </Link>
                      ) : (
                        <span className="font-medium">{jobKind(job.kind)}</span>
                      )}{" "}
                      {job.is_catch_up ? <Badge tone="info">Catch-up</Badge> : null}
                    </Td>
                    <Td>
                      <LocalTime value={job.scheduled_for} timeZone={zone} />
                    </Td>
                    <Td>
                      <JobStatusBadge status={job.status} />
                    </Td>
                    <Td className="text-ink-muted max-w-sm whitespace-normal">
                      {reasonText(job.status_reason) ?? errorClass(job.last_error_class) ?? "—"}
                    </Td>
                    <Td className="tabular text-right">{job.attempts}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </div>
    </div>
  );
}

async function ConfigurationTab({
  supabase,
  campaign,
  revision,
  launched,
}: {
  supabase: ServerClient;
  campaign: Campaign;
  revision: Revision;
  launched: boolean;
}) {
  const [steps, connection, probeSet, revisions] = await Promise.all([
    loadRevisionSteps(supabase, revision.id),
    revision.connection_id
      ? supabase
          .from("provider_connections")
          .select("name")
          .eq("id", revision.connection_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    loadProbeSetSummary(supabase, revision),
    supabase
      .from("campaign_revisions")
      .select("id, revision_number, state, frozen_at, effective_at, model, created_at")
      .eq("campaign_id", campaign.id)
      .order("revision_number", { ascending: false }),
  ]);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-ink-muted max-w-2xl text-[13px]">
          {launched
            ? `Revision ${revision.revision_number} is in effect. It is immutable: editing the campaign creates a new revision for future work, and every conversation and fresh check records the revision it used.`
            : "This is the draft configuration. It becomes revision 1 when the campaign is launched."}
        </p>
        <ExportLinks campaignId={campaign.id} launched={false} />
      </div>
      {(revisions.data ?? []).length > 1 ? (
        <Card>
          <CardHeader title="Revisions" />
          <CardBody>
            <DefinitionList
              items={(revisions.data ?? []).map((item) => ({
                term: `Revision ${item.revision_number}`,
                value: (
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        item.id === campaign.active_revision_id
                          ? "good"
                          : item.state === "draft"
                            ? "warn"
                            : "neutral"
                      }
                    >
                      {item.id === campaign.active_revision_id
                        ? "In effect"
                        : item.state === "draft"
                          ? "Pending changes"
                          : item.state === "discarded"
                            ? "Discarded"
                            : "Superseded"}
                    </Badge>
                    {item.effective_at ? (
                      <span className="text-ink-muted">
                        effective <LocalTime value={item.effective_at} />
                      </span>
                    ) : null}
                  </span>
                ),
              }))}
            />
          </CardBody>
        </Card>
      ) : null}
      <ConfigSummary
        revision={revision}
        steps={steps}
        connectionName={connection.data?.name ?? null}
        probeSet={probeSet}
      />
    </div>
  );
}
