import { Megaphone, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { CampaignRowMenu } from "@/components/campaigns/campaign-actions";
import { Meter } from "@/components/charts/figures";
import { CampaignStatusBadge } from "@/components/status";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, EmptyState, PageHeader } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/form";
import { LocalTime } from "@/components/ui/local-time";
import { Screen } from "@/components/ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatNumber, formatShare, formatUsd } from "@/lib/format";
import { CAMPAIGN_STATUS_FILTERS, pauseReason } from "@/lib/labels";
import { first, type SearchParams } from "@/lib/params";
import { hasRole, requireSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Campaigns" };

export default function CampaignsPage(props: PageProps<"/campaigns">) {
  return (
    <Screen>
      <Campaigns searchParams={props.searchParams} />
    </Screen>
  );
}

const ACTIVE = ["baseline", "running", "finalizing"];

async function Campaigns({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await requireSession();
  const params = await searchParams;
  const supabase = await createClient();
  const isAdmin = hasRole(session.role, "admin");
  const isOwner = hasRole(session.role, "owner");
  const query = first(params.q).trim().toLowerCase();
  const status = first(params.status);

  const { data, error } = await supabase.rpc("campaign_summaries", {
    p_workspace_id: session.workspace.id,
  });
  if (error) throw new Error("Campaigns could not be loaded.");
  const all = data ?? [];
  const rows = all
    .filter((campaign) => {
      if (status === "archived") return Boolean(campaign.archived_at);
      if (campaign.archived_at) return false;
      if (status === "active") return ACTIVE.includes(campaign.status);
      return !status || campaign.status === status;
    })
    .filter(
      (campaign) =>
        !query ||
        [campaign.name, campaign.business_name, campaign.category, campaign.website_url].some(
          (value) => (value ?? "").toLowerCase().includes(query),
        ),
    );

  const newButton = isAdmin ? (
    <ButtonLink href="/campaigns/new">
      <Plus className="size-4" aria-hidden="true" />
      New campaign
    </ButtonLink>
  ) : null;

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Each campaign runs a conversation sequence on a schedule and measures fresh responses before, during and after."
        actions={newButton}
      />

      {all.length === 0 ? (
        <EmptyState
          icon={<Megaphone className="size-5" aria-hidden="true" />}
          title="No campaigns yet"
          description={
            isAdmin
              ? "Create a campaign to describe the business, choose the prompts and schedule, and set budgets. Nothing is sent to the provider until you review and launch it."
              : "Campaigns created by an admin or owner will appear here."
          }
          action={newButton}
        />
      ) : (
        <>
          <form
            method="get"
            action="/campaigns"
            className="mb-4 flex flex-wrap items-end gap-3"
            role="search"
          >
            <div className="flex min-w-48 flex-1 flex-col gap-1.5 sm:max-w-xs">
              <label htmlFor="campaign-search" className="text-ink-muted text-xs font-medium">
                Search
              </label>
              <Input id="campaign-search" name="q" type="search" defaultValue={first(params.q)} />
            </div>
            <div className="flex w-44 flex-col gap-1.5">
              <label htmlFor="campaign-status" className="text-ink-muted text-xs font-medium">
                Status
              </label>
              <Select id="campaign-status" name="status" defaultValue={status}>
                {CAMPAIGN_STATUS_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
            <Button type="submit" variant="secondary">
              Apply
            </Button>
            {query || status ? (
              <Link
                href="/campaigns"
                className="text-brand hover:text-brand-strong pb-2 text-[13px] font-medium"
              >
                Clear
              </Link>
            ) : null}
          </form>

          {rows.length === 0 ? (
            <p className="border-line-strong bg-surface text-ink-muted rounded-2xl border border-dashed px-4 py-10 text-center text-[13px]">
              No campaigns match these filters.
            </p>
          ) : (
            <TableWrap label="Campaigns">
              <Table>
                <thead>
                  <tr>
                    <Th>Campaign</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Conversations</Th>
                    <Th className="text-right">Final-response inclusion</Th>
                    <Th>Estimated spend</Th>
                    <Th>Next slot</Th>
                    <Th>
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((campaign) => (
                    <Tr key={campaign.id}>
                      <Td className="max-w-xs whitespace-normal">
                        <Link
                          href={`/campaigns/${campaign.id}`}
                          className="text-ink hover:text-brand-strong font-semibold"
                        >
                          {campaign.name}
                        </Link>
                        <div className="text-ink-muted text-xs">
                          {campaign.business_name ?? "No business set"}
                          {campaign.category ? ` · ${campaign.category}` : ""}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {campaign.has_pending_changes ? (
                            <Badge tone="warn">Unapplied changes</Badge>
                          ) : null}
                          {campaign.needs_review > 0 ? (
                            <Badge tone="warn">
                              {formatNumber(campaign.needs_review)} to review
                            </Badge>
                          ) : null}
                          {campaign.jobs_dead > 0 ? (
                            <Badge tone="bad">{formatNumber(campaign.jobs_dead)} failed</Badge>
                          ) : null}
                        </div>
                      </Td>
                      <Td className="whitespace-normal">
                        <CampaignStatusBadge
                          status={campaign.status}
                          archived={Boolean(campaign.archived_at)}
                        />
                        {campaign.status === "paused" && campaign.pause_reason !== "user" ? (
                          <div className="text-warn mt-1 max-w-48 text-xs">
                            {pauseReason(campaign.pause_reason)}
                          </div>
                        ) : null}
                      </Td>
                      <Td className="tabular text-right">
                        {campaign.status === "draft" ? (
                          <span className="text-ink-muted">—</span>
                        ) : (
                          <>
                            {formatNumber(campaign.runs_completed)}
                            <span className="text-ink-muted"> done</span>
                            {campaign.runs_problem > 0 ? (
                              <div className="text-bad text-xs">
                                {formatNumber(campaign.runs_problem)} with problems
                              </div>
                            ) : null}
                            {campaign.runs_in_progress > 0 ? (
                              <div className="text-ink-muted text-xs">
                                {formatNumber(campaign.runs_in_progress)} in progress
                              </div>
                            ) : null}
                          </>
                        )}
                      </Td>
                      <Td className="tabular text-right">
                        {campaign.final_valid > 0 ? (
                          formatShare(campaign.final_included, campaign.final_valid)
                        ) : (
                          <span className="text-ink-muted">
                            {campaign.status === "draft" ? "—" : "No valid results yet"}
                          </span>
                        )}
                      </Td>
                      <Td>
                        {campaign.status === "draft" && Number(campaign.spend_total_usd) === 0 ? (
                          <span className="text-ink-muted">—</span>
                        ) : (
                          <div className="w-40">
                            <div className="tabular mb-1 text-xs">
                              {formatUsd(campaign.spend_total_usd)}{" "}
                              <span className="text-ink-muted">
                                of {formatUsd(campaign.total_budget_usd)}
                              </span>
                            </div>
                            <Meter
                              value={Number(campaign.spend_total_usd)}
                              max={
                                campaign.total_budget_usd === null
                                  ? null
                                  : Number(campaign.total_budget_usd)
                              }
                              label={`Total budget used by ${campaign.name}`}
                            />
                          </div>
                        )}
                      </Td>
                      <Td>
                        {campaign.next_slot_at &&
                        ["scheduled", "baseline", "running", "finalizing"].includes(
                          campaign.status,
                        ) ? (
                          <LocalTime value={campaign.next_slot_at} />
                        ) : (
                          <span className="text-ink-muted">—</span>
                        )}
                      </Td>
                      <Td className="text-right">
                        <CampaignRowMenu
                          isAdmin={isAdmin}
                          isOwner={isOwner}
                          campaign={{
                            id: campaign.id,
                            name: campaign.name,
                            status: campaign.status,
                            archived: Boolean(campaign.archived_at),
                            everLaunched: Boolean(campaign.launched_at),
                          }}
                        />
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
          <p className="text-ink-muted mt-3 text-xs">
            Showing {formatNumber(rows.length)} of{" "}
            {formatNumber(
              all.filter((campaign) =>
                status === "archived" ? campaign.archived_at : !campaign.archived_at,
              ).length,
            )}{" "}
            campaigns. Spend is an estimate from recorded token usage.
          </p>
        </>
      )}
    </>
  );
}
