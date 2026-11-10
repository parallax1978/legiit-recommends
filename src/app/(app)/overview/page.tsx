import { CalendarClock, Check, CircleAlert, Megaphone } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { TimeBarChart } from "@/components/charts/charts";
import { ChartFrame } from "@/components/charts/chart-frame";
import { CATEGORICAL } from "@/components/charts/theme";
import { CampaignStatusBadge } from "@/components/status";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { Screen } from "@/components/ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate, formatNumber, formatShare, formatUsd } from "@/lib/format";
import { jobKind } from "@/lib/labels";
import type { OverviewSummary } from "@/lib/queries/types";
import { hasRole, requireSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Overview" };

export default function OverviewPage() {
  return (
    <Screen>
      <Overview />
    </Screen>
  );
}

async function Overview() {
  const session = await requireSession();
  const supabase = await createClient();
  const workspaceId = session.workspace.id;
  const isAdmin = hasRole(session.role, "admin");
  const isOwner = hasRole(session.role, "owner");

  const [summaryResult, campaignsResult, templates, probeSets] = await Promise.all([
    supabase.rpc("overview_summary", { p_workspace_id: workspaceId }),
    supabase.rpc("campaign_summaries", { p_workspace_id: workspaceId }),
    supabase
      .from("templates")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .is("archived_at", null)
      .neq("kind", "fresh_check"),
    supabase
      .from("probe_sets")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .is("archived_at", null),
  ]);
  if (summaryResult.error) throw new Error("The overview could not be loaded.");
  const summary = summaryResult.data as unknown as OverviewSummary;
  const campaigns = (campaignsResult.data ?? []).filter((campaign) => !campaign.archived_at);
  const live = campaigns.filter((campaign) =>
    ["scheduled", "baseline", "running", "finalizing", "paused"].includes(campaign.status),
  );

  const steps = [
    {
      done: summary.attention.connections_ready > 0,
      title: "Connect OpenAI",
      text: "Store an API key and set a daily spending limit.",
      href: "/settings?tab=connections",
      role: "owner" as const,
    },
    {
      done: summary.attention.models_verified > 0,
      title: "Verify a model",
      text: "Confirm which models and parameters work with this key.",
      href: "/settings?tab=connections",
      role: "owner" as const,
    },
    {
      done: (templates.count ?? 0) > 0,
      title: "Write your prompts",
      text: "Add wordings for the question, the inclusion request and the revised-list request.",
      href: "/library",
      role: "admin" as const,
    },
    {
      done: (probeSets.count ?? 0) > 0,
      title: "Create a fresh-check question set",
      text: "Independent questions asked with no conversation history.",
      href: "/library?tab=question-sets",
      role: "admin" as const,
    },
    {
      done: campaigns.length > 0,
      title: "Create a campaign",
      text: "Describe the business, schedule and budgets, then review and launch.",
      href: "/campaigns/new",
      role: "admin" as const,
    },
  ];
  const setupComplete = steps.every((step) => step.done);

  const attention = [
    {
      count: summary.attention.connections_failing,
      label: "connection needs attention",
      plural: "connections need attention",
      href: "/settings?tab=connections",
    },
    {
      count: summary.attention.campaigns_paused_by_system,
      label: "campaign paused automatically",
      plural: "campaigns paused automatically",
      href: "/campaigns?status=paused",
    },
    {
      count: summary.attention.jobs_dead,
      label: "job stopped and needs review",
      plural: "jobs stopped and need review",
      href: "/settings?tab=status",
    },
    {
      count: summary.attention.jobs_blocked,
      label: "job blocked",
      plural: "jobs blocked",
      href: "/settings?tab=status",
    },
    {
      count: summary.attention.unresolved_attempts,
      label: "request with an unknown outcome",
      plural: "requests with an unknown outcome",
      href: "/usage#unresolved",
    },
    {
      count: summary.attention.needs_review,
      label: "response needs classification review",
      plural: "responses need classification review",
      href: "/conversations?inclusion=ambiguous",
    },
  ].filter((item) => item.count > 0);

  const daily = summary.daily.map((day) => ({
    label: formatDate(day.day).replace(/, \d{4}$/, ""),
    cost: Number(day.cost_usd),
    requests: day.requests,
    day: day.day,
  }));

  return (
    <>
      <PageHeader
        title="Overview"
        description={`Activity in ${session.workspace.name}.`}
        actions={
          isAdmin ? (
            <ButtonLink href="/campaigns/new">
              <Megaphone className="size-4" aria-hidden="true" />
              New campaign
            </ButtonLink>
          ) : null
        }
      />

      {!setupComplete ? (
        <Card className="mb-6">
          <CardHeader
            title="Get started"
            description="Nothing runs until a campaign is launched. These steps prepare one."
          />
          <CardBody>
            <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              {steps.map((step, index) => {
                const allowed = step.role === "owner" ? isOwner : isAdmin;
                return (
                  <li key={step.title} className="border-line flex gap-3 rounded-xl border p-3">
                    <span
                      className={
                        step.done
                          ? "bg-good-soft text-good flex size-6 shrink-0 items-center justify-center rounded-full"
                          : "bg-brand-faint text-brand-strong flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                      }
                    >
                      {step.done ? <Check className="size-3.5" aria-label="Done" /> : index + 1}
                    </span>
                    <span className="min-w-0">
                      {allowed && !step.done ? (
                        <Link
                          href={step.href}
                          className="text-brand-strong text-[13px] font-semibold underline-offset-2 hover:underline"
                        >
                          {step.title}
                        </Link>
                      ) : (
                        <span className="text-ink text-[13px] font-semibold">{step.title}</span>
                      )}
                      <span className="text-ink-muted mt-0.5 block text-xs">
                        {step.text}
                        {!allowed && !step.done
                          ? ` Needs ${step.role === "owner" ? "an owner" : "an admin"}.`
                          : ""}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ol>
          </CardBody>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Active campaigns"
          value={formatNumber(summary.campaigns.active)}
          detail={`${formatNumber(summary.campaigns.scheduled)} scheduled · ${formatNumber(summary.campaigns.paused)} paused · ${formatNumber(summary.campaigns.draft)} draft`}
        />
        <Stat
          label="Conversations completed, last 7 days"
          value={formatNumber(summary.conversations.completed_7d)}
          detail={`${formatNumber(summary.conversations.completed)} in total · ${formatNumber(summary.conversations.in_progress)} in progress`}
        />
        <Stat
          label="Fresh checks completed, last 7 days"
          value={formatNumber(summary.fresh_checks.completed_7d)}
          detail={
            summary.fresh_checks.valid > 0
              ? `Included in ${formatShare(summary.fresh_checks.included, summary.fresh_checks.valid)} valid checks overall`
              : "No valid fresh checks yet"
          }
        />
        <Stat
          label="Estimated spend today (UTC)"
          value={formatUsd(summary.usage.today_usd)}
          detail={`${formatUsd(summary.usage.last_7d_usd)} in 7 days · ${formatUsd(summary.usage.last_30d_usd)} in 30 days`}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <ChartFrame
          className="xl:col-span-2"
          title="Estimated spend per day"
          description="Last 14 days (UTC), all campaigns and tests. Estimates from recorded token usage, not invoices."
          table={{
            columns: [
              { key: "day", label: "Day (UTC)" },
              { key: "cost", label: "Estimated spend", numeric: true },
              { key: "requests", label: "Requests", numeric: true },
            ],
            rows: daily.map((day) => ({
              day: formatDate(day.day),
              cost: formatUsd(day.cost),
              requests: formatNumber(day.requests),
            })),
          }}
          empty={daily.length === 0 ? "No provider requests have been recorded yet." : undefined}
        >
          <TimeBarChart
            data={daily}
            series={[{ key: "cost", label: "Estimated spend", color: CATEGORICAL[0] }]}
            format="usd"
            ariaLabel="Estimated spend per day for the last 14 days"
          />
        </ChartFrame>

        <Card>
          <CardHeader title="Needs attention" />
          <CardBody>
            {attention.length === 0 ? (
              <p className="text-ink-muted flex items-center gap-2 text-[13px]">
                <Check className="text-good size-4" aria-hidden="true" />
                Nothing needs attention.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {attention.map((item) => (
                  <li key={item.label}>
                    <Link
                      href={item.href}
                      className="border-line hover:bg-surface-alt flex items-start gap-2 rounded-xl border px-3 py-2 text-[13px]"
                    >
                      <CircleAlert
                        className="text-warn mt-0.5 size-4 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="text-ink">
                        <span className="tabular font-semibold">{formatNumber(item.count)}</span>{" "}
                        {item.count === 1 ? item.label : item.plural}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <h2 className="text-ink mb-3 text-[15px] font-semibold">Campaigns in flight</h2>
          {live.length === 0 ? (
            <EmptyState
              icon={<Megaphone className="size-5" aria-hidden="true" />}
              title={
                campaigns.length === 0
                  ? "No campaigns yet"
                  : "No campaigns are scheduled or running"
              }
              description={
                campaigns.length === 0
                  ? "A campaign runs your conversation sequence on a schedule and measures fresh recommendation responses before, during and after."
                  : "Launched campaigns appear here while they are scheduled, running or paused."
              }
              action={
                isAdmin ? (
                  <ButtonLink
                    href={campaigns.length === 0 ? "/campaigns/new" : "/campaigns"}
                    variant={campaigns.length === 0 ? "primary" : "secondary"}
                  >
                    {campaigns.length === 0 ? "Create campaign" : "View all campaigns"}
                  </ButtonLink>
                ) : null
              }
            />
          ) : (
            <TableWrap label="Campaigns in flight">
              <Table>
                <thead>
                  <tr>
                    <Th>Campaign</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Conversations</Th>
                    <Th className="text-right">Final-response inclusion</Th>
                    <Th className="text-right">Estimated spend</Th>
                  </tr>
                </thead>
                <tbody>
                  {live.slice(0, 8).map((campaign) => (
                    <Tr key={campaign.id}>
                      <Td>
                        <Link
                          href={`/campaigns/${campaign.id}`}
                          className="text-ink hover:text-brand-strong font-semibold"
                        >
                          {campaign.name}
                        </Link>
                        <div className="text-ink-muted text-xs">
                          {campaign.business_name ?? "No business set"}
                        </div>
                      </Td>
                      <Td>
                        <CampaignStatusBadge status={campaign.status} />
                      </Td>
                      <Td className="tabular text-right">
                        {formatNumber(campaign.runs_completed)}
                        <span className="text-ink-muted">
                          {" "}
                          of {formatNumber(campaign.conversations_planned)} planned so far
                        </span>
                      </Td>
                      <Td className="tabular text-right">
                        {campaign.final_valid > 0 ? (
                          formatShare(campaign.final_included, campaign.final_valid)
                        ) : (
                          <span className="text-ink-muted">No valid results yet</span>
                        )}
                      </Td>
                      <Td className="tabular text-right">
                        {formatUsd(campaign.spend_total_usd)}
                        <span className="text-ink-muted">
                          {" "}
                          of {formatUsd(campaign.total_budget_usd)}
                        </span>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </div>

        <Card>
          <CardHeader title="Next scheduled work" description="Across running campaigns." />
          <CardBody>
            {summary.upcoming.length === 0 ? (
              <p className="text-ink-muted flex items-center gap-2 text-[13px]">
                <CalendarClock className="size-4" aria-hidden="true" />
                Nothing is scheduled.
              </p>
            ) : (
              <ul className="divide-line flex flex-col divide-y">
                {summary.upcoming.map((job) => (
                  <li
                    key={job.id}
                    className="flex items-start justify-between gap-3 py-2 text-[13px] first:pt-0 last:pb-0"
                  >
                    <span className="min-w-0">
                      <span className="text-ink block font-medium">{jobKind(job.kind)}</span>
                      <Link
                        href={`/campaigns/${job.campaign_id}`}
                        className="text-ink-muted hover:text-brand-strong block truncate text-xs"
                      >
                        {job.campaign_name}
                      </Link>
                    </span>
                    <span className="text-ink-muted shrink-0 text-right text-xs">
                      <LocalTime value={job.scheduled_for} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
