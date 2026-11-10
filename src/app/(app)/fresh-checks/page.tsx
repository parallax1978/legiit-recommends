import { ScanSearch } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { CorrectClassificationButton } from "@/components/classification-controls";
import { DeleteManualCheckButton, ManualCheckButton } from "@/components/manual-check-form";
import { ApiResultsNote, FreshCheckComparisons } from "@/components/results/campaign-results";
import { CheckStatusBadge, InclusionBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui/card";
import { Select } from "@/components/ui/form";
import { LocalTime } from "@/components/ui/local-time";
import { Pagination, Screen } from "@/components/ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { PAGE_OUT_OF_RANGE, readError } from "@/lib/batch";
import { formatDate, formatUsd } from "@/lib/format";
import { humanize, phaseLabel } from "@/lib/labels";
import { first, pageNumber, uuidParam, type SearchParams } from "@/lib/params";
import { hasRole, requireSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Fresh Checks" };

const PAGE_SIZE = 25;

export default function FreshChecksPage(props: PageProps<"/fresh-checks">) {
  return (
    <Screen>
      <FreshChecks searchParams={props.searchParams} />
    </Screen>
  );
}

async function FreshChecks({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await requireSession();
  const params = await searchParams;
  const supabase = await createClient();
  const isAdmin = hasRole(session.role, "admin");
  const workspaceId = session.workspace.id;

  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("id, name, status, launched_at")
    .eq("workspace_id", workspaceId)
    .neq("status", "draft")
    .order("launched_at", { ascending: false });
  const requested = uuidParam(params.campaign);
  const campaign =
    (campaigns ?? []).find((item) => item.id === requested) ?? (campaigns ?? [])[0] ?? null;

  const header = (
    <PageHeader
      title="Fresh Checks"
      description="Independent measurements: each check is one question sent in a brand-new request, with no conversation history, no instructions and nothing about the business or the campaign."
    />
  );
  if (!campaign) {
    return (
      <>
        {header}
        <EmptyState
          icon={<ScanSearch className="size-5" aria-hidden="true" />}
          title="No fresh checks yet"
          description="Fresh checks are collected by launched campaigns: a baseline before the conversations, scheduled checks while they run, and a final sample after they end."
        />
      </>
    );
  }

  const phase = ["baseline", "daily", "final"].includes(first(params.phase))
    ? first(params.phase)
    : "";
  const questions = ["regular", "held_out"].includes(first(params.questions))
    ? first(params.questions)
    : "";
  const outcome = [
    "included",
    "mentioned_only",
    "not_mentioned",
    "ambiguous",
    "not_counted",
  ].includes(first(params.outcome))
    ? first(params.outcome)
    : "";
  const page = pageNumber(params.page);

  let list = supabase
    .from("fresh_checks")
    .select(
      "id, phase, is_held_out, local_day, status, exclusion_reason, inclusion, rank, list_position, model, returned_model, cost_usd, completed_at, scheduled_for, rendered_prompt, comparison_group_id",
      { count: "exact" },
    )
    .eq("campaign_id", campaign.id)
    // Newest first; the id breaks ties so a check cannot appear on two pages.
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (phase) list = list.eq("phase", phase as "baseline" | "daily" | "final");
  if (questions) list = list.eq("is_held_out", questions === "held_out");
  if (outcome === "not_counted")
    list = list.in("status", ["incomplete", "failed", "uncertain", "excluded", "canceled"]);
  else if (outcome) list = list.eq("status", "completed").eq("inclusion", outcome);

  const [metrics, groups, checks, manual, revision] = await Promise.all([
    supabase.rpc("campaign_check_metrics", { p_campaign_id: campaign.id }),
    supabase.from("comparison_groups").select("*").eq("campaign_id", campaign.id).order("sequence"),
    list,
    supabase
      .from("manual_checks")
      .select(
        "id, observed_on, source_label, question, response_text, inclusion, rank, list_position, created_at",
      )
      .eq("campaign_id", campaign.id)
      .order("observed_on", { ascending: false }),
    supabase.from("campaigns").select("active_revision_id").eq("id", campaign.id).maybeSingle(),
  ]);
  // A page number past the end of the list is an empty page, not a failure.
  const pastEnd = checks.error?.code === PAGE_OUT_OF_RANGE;
  if (metrics.error) throw readError("Fresh checks", metrics.error);
  if (checks.error && !pastEnd) throw readError("Fresh checks", checks.error);
  const { data: zoneRow } = revision.data?.active_revision_id
    ? await supabase
        .from("campaign_revisions")
        .select("timezone")
        .eq("id", revision.data.active_revision_id)
        .maybeSingle()
    : { data: null };
  const zone = zoneRow?.timezone ?? null;
  const groupSequence = new Map((groups.data ?? []).map((group) => [group.id, group.sequence]));
  const multipleGroups = (groups.data ?? []).length > 1;
  const filtered = Boolean(phase || questions || outcome);

  return (
    <>
      {header}
      <form method="get" action="/fresh-checks" className="mb-6 flex flex-wrap items-end gap-3">
        <div className="flex min-w-56 flex-1 flex-col gap-1.5 sm:max-w-sm">
          <label htmlFor="fc-campaign" className="text-ink-muted text-xs font-medium">
            Campaign
          </label>
          <Select id="fc-campaign" name="campaign" defaultValue={campaign.id}>
            {(campaigns ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="secondary">
          Show
        </Button>
        <Link
          href={`/campaigns/${campaign.id}`}
          className="text-brand hover:text-brand-strong pb-2 text-[13px] font-medium"
        >
          Open campaign
        </Link>
      </form>

      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-4">
          <ApiResultsNote />
          <FreshCheckComparisons
            groups={groups.data ?? []}
            rows={metrics.data ?? []}
            heading={false}
          />
        </div>

        <section aria-labelledby="fc-responses">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <h2 id="fc-responses" className="text-ink text-[15px] font-semibold">
              Individual checks
            </h2>
            <a
              href={`/exports/campaigns/${campaign.id}/fresh-checks.csv`}
              download
              className="text-brand hover:text-brand-strong text-[13px] font-medium"
            >
              Export CSV
            </a>
          </div>
          <form method="get" action="/fresh-checks" className="mb-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="campaign" value={campaign.id} />
            <div className="flex w-44 flex-col gap-1.5">
              <label htmlFor="fc-phase" className="text-ink-muted text-xs font-medium">
                Phase
              </label>
              <Select id="fc-phase" name="phase" defaultValue={phase}>
                <option value="">All phases</option>
                <option value="baseline">Baseline</option>
                <option value="daily">Scheduled</option>
                <option value="final">Final</option>
              </Select>
            </div>
            <div className="flex w-48 flex-col gap-1.5">
              <label htmlFor="fc-questions" className="text-ink-muted text-xs font-medium">
                Questions
              </label>
              <Select id="fc-questions" name="questions" defaultValue={questions}>
                <option value="">Regular and held-out</option>
                <option value="regular">Regular only</option>
                <option value="held_out">Held-out only</option>
              </Select>
            </div>
            <div className="flex w-52 flex-col gap-1.5">
              <label htmlFor="fc-outcome" className="text-ink-muted text-xs font-medium">
                Outcome
              </label>
              <Select id="fc-outcome" name="outcome" defaultValue={outcome}>
                <option value="">Any outcome</option>
                <option value="included">Included</option>
                <option value="mentioned_only">Mentioned only</option>
                <option value="not_mentioned">Not mentioned</option>
                <option value="ambiguous">Needs review</option>
                <option value="not_counted">Not counted (errors, incomplete, excluded)</option>
              </Select>
            </div>
            <Button type="submit" variant="secondary">
              Apply
            </Button>
            {filtered ? (
              <Link
                href={`/fresh-checks?campaign=${campaign.id}`}
                className="text-brand hover:text-brand-strong pb-2 text-[13px] font-medium"
              >
                Clear
              </Link>
            ) : null}
          </form>
          {(checks.data ?? []).length === 0 ? (
            <p className="border-line-strong bg-surface text-ink-muted rounded-2xl border border-dashed px-4 py-8 text-center text-[13px]">
              {filtered
                ? "No checks match these filters."
                : "No fresh checks have been created for this campaign yet."}
            </p>
          ) : (
            <TableWrap label="Individual fresh checks">
              <Table>
                <thead>
                  <tr>
                    <Th>Question sent</Th>
                    <Th>Phase</Th>
                    <Th>Status</Th>
                    <Th>Result</Th>
                    <Th className="text-right">Est. cost</Th>
                    <Th>Completed</Th>
                  </tr>
                </thead>
                <tbody>
                  {(checks.data ?? []).map((check) => (
                    <Tr key={check.id}>
                      <Td className="max-w-md whitespace-normal">
                        <Link
                          href={`/fresh-checks/${check.id}`}
                          className="text-ink hover:text-brand-strong font-medium"
                        >
                          {check.rendered_prompt ?? "Not sent yet"}
                        </Link>
                        <div className="mt-0.5 flex flex-wrap gap-1.5">
                          {check.is_held_out ? <Badge tone="info">Held out</Badge> : null}
                          {multipleGroups ? (
                            <Badge>
                              Group {groupSequence.get(check.comparison_group_id) ?? "—"}
                            </Badge>
                          ) : null}
                        </div>
                      </Td>
                      <Td>
                        {phaseLabel(check.phase)}
                        {check.phase === "daily" ? (
                          <div className="text-ink-muted text-xs">
                            {formatDate(check.local_day)}
                          </div>
                        ) : null}
                      </Td>
                      <Td className="whitespace-normal">
                        <CheckStatusBadge status={check.status} />
                        {check.exclusion_reason ? (
                          <div className="text-ink-muted mt-1 max-w-48 text-xs">
                            {humanize(check.exclusion_reason)}
                          </div>
                        ) : null}
                      </Td>
                      <Td>
                        {check.status === "completed" ? (
                          <InclusionBadge
                            inclusion={check.inclusion}
                            rank={check.rank}
                            listPosition={check.list_position}
                          />
                        ) : (
                          <span className="text-ink-muted">—</span>
                        )}
                      </Td>
                      <Td className="tabular text-right">
                        {formatUsd(check.cost_usd, { precise: true })}
                      </Td>
                      <Td>
                        <LocalTime value={check.completed_at} timeZone={zone} />
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={checks.count ?? 0}
            path="/fresh-checks"
            params={{ campaign: campaign.id, phase, questions, outcome }}
          />
        </section>

        <section aria-labelledby="fc-manual">
          <Card>
            <CardHeader
              title={<span id="fc-manual">Manual ChatGPT observations</span>}
              description="A separate dataset. These are responses a person saw outside the API and typed in here; they are not measured by this app and are never combined with the API results above."
              action={isAdmin ? <ManualCheckButton campaignId={campaign.id} /> : null}
            />
            <CardBody>
              {(manual.data ?? []).length === 0 ? (
                <p className="text-ink-muted text-[13px]">
                  No manual observations have been recorded for this campaign.
                </p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {(manual.data ?? []).map((item) => (
                    <li key={item.id} className="border-line rounded-xl border p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-ink flex flex-wrap items-center gap-2 text-[13px] font-semibold">
                            {formatDate(item.observed_on)}
                            <Badge tone="warn">Manual · {item.source_label}</Badge>
                          </p>
                          {item.question ? (
                            <p className="text-ink-muted mt-1 text-[13px]">
                              Question: {item.question}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <InclusionBadge
                            inclusion={item.inclusion}
                            rank={item.rank}
                            listPosition={item.list_position}
                          />
                          {isAdmin ? (
                            <>
                              <CorrectClassificationButton
                                subjectType="manual_check"
                                subjectId={item.id}
                                current={{
                                  inclusion: item.inclusion,
                                  rank: item.rank,
                                  listPosition: item.list_position,
                                }}
                              />
                              <DeleteManualCheckButton id={item.id} />
                            </>
                          ) : null}
                        </div>
                      </div>
                      <details className="mt-2">
                        <summary className="text-brand cursor-pointer text-xs font-medium">
                          Show the recorded response
                        </summary>
                        <p className="text-ink mt-2 text-[13px] break-words whitespace-pre-wrap">
                          {item.response_text}
                        </p>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </section>
      </div>
    </>
  );
}
