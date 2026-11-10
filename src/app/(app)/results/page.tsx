import { BarChart3, Download } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { CampaignResults } from "@/components/results/campaign-results";
import { CampaignStatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/card";
import { Select } from "@/components/ui/form";
import { Screen } from "@/components/ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatNumber, formatShare } from "@/lib/format";
import { uuidParam, type SearchParams } from "@/lib/params";
import { requireSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Results" };

export default function ResultsPage(props: PageProps<"/results">) {
  return (
    <Screen>
      <Results searchParams={props.searchParams} />
    </Screen>
  );
}

async function Results({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await requireSession();
  const params = await searchParams;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("campaign_summaries", {
    p_workspace_id: session.workspace.id,
  });
  if (error) throw new Error("Results could not be loaded.");
  const launched = (data ?? []).filter((campaign) => campaign.status !== "draft");
  const selectedId = uuidParam(params.campaign);
  const selected = launched.find((campaign) => campaign.id === selectedId) ?? null;

  const header = (
    <PageHeader
      title="Results"
      description="First-response inclusion, final-response inclusion and fresh-check inclusion are separate measurements. Each is shown with its own counts and valid denominator, and they are never blended."
    />
  );

  if (launched.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          icon={<BarChart3 className="size-5" aria-hidden="true" />}
          title="No results yet"
          description="Results appear after a campaign has been launched and its first fresh checks and conversations have completed. Nothing is estimated or filled in before then."
        />
      </>
    );
  }

  const exportLink =
    "inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-surface-alt";

  return (
    <>
      {header}
      <form method="get" action="/results" className="mb-6 flex flex-wrap items-end gap-3">
        <div className="flex min-w-56 flex-1 flex-col gap-1.5 sm:max-w-sm">
          <label htmlFor="r-campaign" className="text-ink-muted text-xs font-medium">
            Campaign
          </label>
          <Select id="r-campaign" name="campaign" defaultValue={selected?.id ?? ""}>
            <option value="">All campaigns (summary)</option>
            {launched.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>

      {selected ? (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-ink flex flex-wrap items-center gap-2 text-[17px] font-semibold">
              <Link href={`/campaigns/${selected.id}`} className="hover:text-brand-strong">
                {selected.name}
              </Link>
              <CampaignStatusBadge
                status={selected.status}
                archived={Boolean(selected.archived_at)}
              />
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-ink-muted flex items-center gap-1 text-xs font-medium">
                <Download className="size-3.5" aria-hidden="true" />
                Export
              </span>
              <a
                className={exportLink}
                href={`/exports/campaigns/${selected.id}/conversations.csv`}
                download
              >
                Conversation results (CSV)
              </a>
              <a
                className={exportLink}
                href={`/exports/campaigns/${selected.id}/fresh-checks.csv`}
                download
              >
                Fresh checks (CSV)
              </a>
            </div>
          </div>
          <CampaignResults supabase={supabase} campaignId={selected.id} launched />
        </div>
      ) : (
        <>
          <TableWrap label="Results by campaign">
            <Table>
              <thead>
                <tr>
                  <Th>Campaign</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Conversations completed</Th>
                  <Th className="text-right">First-response inclusion</Th>
                  <Th className="text-right">Final-response inclusion</Th>
                  <Th className="text-right">Fresh checks completed</Th>
                  <Th className="text-right">Need review</Th>
                </tr>
              </thead>
              <tbody>
                {launched.map((campaign) => (
                  <Tr key={campaign.id}>
                    <Td>
                      <Link
                        href={`/results?campaign=${campaign.id}`}
                        className="text-ink hover:text-brand-strong font-semibold"
                      >
                        {campaign.name}
                      </Link>
                      <div className="text-ink-muted text-xs">{campaign.business_name}</div>
                    </Td>
                    <Td>
                      <CampaignStatusBadge
                        status={campaign.status}
                        archived={Boolean(campaign.archived_at)}
                      />
                    </Td>
                    <Td className="tabular text-right">{formatNumber(campaign.runs_completed)}</Td>
                    <Td className="tabular text-right">
                      {campaign.first_valid > 0 ? (
                        formatShare(campaign.first_included, campaign.first_valid)
                      ) : (
                        <span className="text-ink-muted">No valid results</span>
                      )}
                    </Td>
                    <Td className="tabular text-right">
                      {campaign.final_valid > 0 ? (
                        formatShare(campaign.final_included, campaign.final_valid)
                      ) : (
                        <span className="text-ink-muted">No valid results</span>
                      )}
                    </Td>
                    <Td className="tabular text-right">
                      {formatNumber(campaign.checks_completed)}
                    </Td>
                    <Td className="tabular text-right">
                      {campaign.needs_review > 0 ? (
                        formatNumber(campaign.needs_review)
                      ) : (
                        <span className="text-ink-muted">0</span>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
          <p className="text-ink-muted mt-3 text-xs">
            Choose a campaign for fresh-check comparisons (baseline, scheduled, final and held-out
            questions), per-model cohorts and daily charts. Campaigns are not combined: they can
            differ in business, prompts, model and settings.
          </p>
        </>
      )}
    </>
  );
}
