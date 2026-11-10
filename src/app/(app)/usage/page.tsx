import { Download } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { TimeBarChart, type ChartRow } from "@/components/charts/charts";
import { ChartFrame } from "@/components/charts/chart-frame";
import { Meter } from "@/components/charts/figures";
import { PURPOSE_COLORS } from "@/components/charts/theme";
import { ResolveAttemptButtons } from "@/components/operations-buttons";
import { Button } from "@/components/ui/button";
import { Callout, Card, CardBody, CardHeader, PageHeader, Stat } from "@/components/ui/card";
import { Select } from "@/components/ui/form";
import { LocalTime } from "@/components/ui/local-time";
import { Screen } from "@/components/ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatCompact, formatDate, formatNumber, formatUsd } from "@/lib/format";
import { PURPOSES, errorClass, purposeLabel } from "@/lib/labels";
import { first, uuidParam, type SearchParams } from "@/lib/params";
import type { BudgetStatus } from "@/lib/queries/types";
import { hasRole, requireSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Usage" };

export default function UsagePage(props: PageProps<"/usage">) {
  return (
    <Screen>
      <Usage searchParams={props.searchParams} />
    </Screen>
  );
}

const RANGES = [7, 30, 90];
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

async function Usage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await requireSession();
  const params = await searchParams;
  const supabase = await createClient();
  const workspaceId = session.workspace.id;
  const isOwner = hasRole(session.role, "owner");
  const range = RANGES.includes(Number(first(params.range))) ? Number(first(params.range)) : 30;
  const campaignId = uuidParam(params.campaign);
  const today = new Date();
  const to = isoDay(today);
  const from = isoDay(
    new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (range - 1)),
    ),
  );

  const [usage, budgets, campaigns, unresolved, held] = await Promise.all([
    supabase.rpc("usage_daily", {
      p_workspace_id: workspaceId,
      p_from: from,
      p_to: to,
      p_campaign_id: campaignId ?? undefined,
    }),
    supabase.rpc("budget_status", { p_workspace_id: workspaceId }),
    supabase
      .from("campaigns")
      .select("id, name")
      .eq("workspace_id", workspaceId)
      .neq("status", "draft")
      .order("created_at", { ascending: false }),
    supabase
      .from("provider_attempts")
      .select(
        "id, purpose, requested_model, started_at, error_class, error_message, response_id, run_id, fresh_check_id, campaign_id, reservation_id, is_test",
      )
      .eq("workspace_id", workspaceId)
      .eq("status", "uncertain")
      .is("resolved_at", null)
      .order("started_at", { ascending: false })
      .limit(50),
    supabase
      .from("budget_reservations")
      .select("id, amount_usd, purpose, created_at, campaign_id")
      .eq("workspace_id", workspaceId)
      .eq("status", "held")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);
  if (usage.error || budgets.error) throw new Error("Usage could not be loaded.");
  const rows = usage.data ?? [];
  const budget = budgets.data as unknown as BudgetStatus;
  const campaignName = new Map(
    (campaigns.data ?? []).map((campaign) => [campaign.id, campaign.name]),
  );

  const reservationIds = (unresolved.data ?? [])
    .map((attempt) => attempt.reservation_id)
    .filter((value): value is string => Boolean(value));
  const { data: reservations } = reservationIds.length
    ? await supabase.from("budget_reservations").select("id, amount_usd").in("id", reservationIds)
    : { data: [] };
  const reservedAmount = new Map(
    (reservations ?? []).map((reservation) => [reservation.id, Number(reservation.amount_usd)]),
  );

  const totals = rows.reduce(
    (sum, row) => ({
      cost: sum.cost + Number(row.cost_usd),
      requests: sum.requests + Number(row.requests),
      input: sum.input + Number(row.input_tokens),
      cached: sum.cached + Number(row.cached_input_tokens),
      output: sum.output + Number(row.output_tokens),
      reasoning: sum.reasoning + Number(row.reasoning_tokens),
      test: sum.test + (row.is_test ? Number(row.cost_usd) : 0),
    }),
    { cost: 0, requests: 0, input: 0, cached: 0, output: 0, reasoning: 0, test: 0 },
  );

  // Every day in the range gets a column, so gaps in activity are visible as gaps.
  const usedPurposes = PURPOSES.filter((purpose) => rows.some((row) => row.purpose === purpose));
  const days: ChartRow[] = [];
  for (let offset = range - 1; offset >= 0; offset -= 1) {
    const day = isoDay(
      new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset)),
    );
    const entry: ChartRow = { label: formatDate(day).replace(/, \d{4}$/, ""), day };
    for (const purpose of usedPurposes) entry[purpose] = 0;
    days.push(entry);
  }
  const dayIndex = new Map(days.map((entry, index) => [entry.day as string, index]));
  for (const row of rows) {
    const index = dayIndex.get(row.usage_day);
    if (index === undefined) continue;
    const entry = days[index]!;
    entry[row.purpose] = Number(entry[row.purpose] ?? 0) + Number(row.cost_usd);
  }

  const byModel = new Map<
    string,
    {
      requests: number;
      input: number;
      cached: number;
      output: number;
      reasoning: number;
      cost: number;
    }
  >();
  for (const row of rows) {
    const entry = byModel.get(row.model) ?? {
      requests: 0,
      input: 0,
      cached: 0,
      output: 0,
      reasoning: 0,
      cost: 0,
    };
    entry.requests += Number(row.requests);
    entry.input += Number(row.input_tokens);
    entry.cached += Number(row.cached_input_tokens);
    entry.output += Number(row.output_tokens);
    entry.reasoning += Number(row.reasoning_tokens);
    entry.cost += Number(row.cost_usd);
    byModel.set(row.model, entry);
  }
  const byPurpose = usedPurposes.map((purpose) => {
    const own = rows.filter((row) => row.purpose === purpose);
    return {
      purpose,
      requests: own.reduce((sum, row) => sum + Number(row.requests), 0),
      cost: own.reduce((sum, row) => sum + Number(row.cost_usd), 0),
    };
  });
  const heldTotal = (held.data ?? []).reduce(
    (sum, reservation) => sum + Number(reservation.amount_usd),
    0,
  );
  const unresolvedTotal = (unresolved.data ?? []).reduce(
    (sum, attempt) => sum + (reservedAmount.get(attempt.reservation_id ?? "") ?? 0),
    0,
  );

  return (
    <>
      <PageHeader
        title="Usage"
        description="Token counts recorded from provider responses, and cost estimates computed from them with the price versions in Settings. These are estimates for budgeting, not invoices."
        actions={
          <a
            href={`/exports/usage?from=${from}&to=${to}${campaignId ? `&campaign=${campaignId}` : ""}`}
            download
            className="border-line-strong bg-surface text-ink hover:bg-surface-alt inline-flex h-9 items-center gap-2 rounded-full border px-4 text-sm font-semibold"
          >
            <Download className="size-4" aria-hidden="true" />
            Export CSV
          </a>
        }
      />

      <form method="get" action="/usage" className="mb-6 flex flex-wrap items-end gap-3">
        <div className="flex w-44 flex-col gap-1.5">
          <label htmlFor="u-range" className="text-ink-muted text-xs font-medium">
            Period (UTC days)
          </label>
          <Select id="u-range" name="range" defaultValue={String(range)}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </Select>
        </div>
        <div className="flex min-w-56 flex-1 flex-col gap-1.5 sm:max-w-sm">
          <label htmlFor="u-campaign" className="text-ink-muted text-xs font-medium">
            Campaign
          </label>
          <Select id="u-campaign" name="campaign" defaultValue={campaignId ?? ""}>
            <option value="">Everything in this workspace</option>
            {(campaigns.data ?? []).map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="secondary">
          Apply
        </Button>
      </form>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label={`Estimated spend, ${formatDate(from)} – ${formatDate(to)}`}
          value={formatUsd(totals.cost)}
          detail={
            totals.test > 0
              ? `Includes ${formatUsd(totals.test)} of test conversations`
              : "From recorded usage"
          }
        />
        <Stat
          label="Provider requests"
          value={formatNumber(totals.requests)}
          detail="Every attempt that was billed or reserved, including retries"
        />
        <Stat
          label="Input tokens"
          value={formatCompact(totals.input)}
          detail={`${formatCompact(totals.cached)} served from the provider's cache`}
        />
        <Stat
          label="Output tokens"
          value={formatCompact(totals.output)}
          detail={`${formatCompact(totals.reasoning)} of them reasoning tokens`}
        />
      </div>

      <ChartFrame
        className="mt-6"
        title="Estimated spend per day"
        description="By what the requests were for. Days are UTC days, matching the connection's daily limit."
        legend={usedPurposes.map((purpose) => ({
          label: purposeLabel(purpose),
          color: PURPOSE_COLORS[purpose] ?? "#64748b",
        }))}
        table={{
          columns: [
            { key: "day", label: "Day (UTC)" },
            ...usedPurposes.map((purpose) => ({
              key: purpose,
              label: purposeLabel(purpose),
              numeric: true,
            })),
            { key: "total", label: "Total", numeric: true },
          ],
          rows: days
            .filter((entry) => usedPurposes.some((purpose) => Number(entry[purpose]) > 0))
            .map((entry) => ({
              day: formatDate(entry.day as string),
              ...Object.fromEntries(
                usedPurposes.map((purpose) => [
                  purpose,
                  formatUsd(Number(entry[purpose]), { precise: true }),
                ]),
              ),
              total: formatUsd(
                usedPurposes.reduce((sum, purpose) => sum + Number(entry[purpose]), 0),
                { precise: true },
              ),
            })),
        }}
        empty={rows.length === 0 ? "No usage was recorded in this period." : undefined}
      >
        <TimeBarChart
          data={days}
          series={usedPurposes.map((purpose) => ({
            key: purpose,
            label: purposeLabel(purpose),
            color: PURPOSE_COLORS[purpose] ?? "#64748b",
          }))}
          format="usd"
          ariaLabel="Estimated spend per day, stacked by purpose"
        />
      </ChartFrame>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Connection limits"
            description="Spending today counts recorded cost plus amounts reserved for requests in flight or unresolved."
          />
          <CardBody className="flex flex-col gap-5">
            {budget.connections.length === 0 ? (
              <p className="text-ink-muted text-[13px]">No connections.</p>
            ) : null}
            {budget.connections.map((connection) => {
              const today_ =
                Number(connection.spent_today_usd) +
                Number(connection.reserved_today_usd) +
                Number(connection.unresolved_today_usd);
              const total = Number(connection.spent_total_usd) + Number(connection.open_total_usd);
              return (
                <div key={connection.connection_id}>
                  <p className="text-ink mb-2 text-[13px] font-semibold">{connection.name}</p>
                  <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                    <span className="text-ink-muted">Today (UTC)</span>
                    <span className="tabular">
                      <span className="font-semibold">{formatUsd(today_)}</span>{" "}
                      <span className="text-ink-muted">
                        of {formatUsd(connection.daily_budget_usd)}
                      </span>
                    </span>
                  </div>
                  <Meter
                    value={today_}
                    max={
                      connection.daily_budget_usd === null
                        ? null
                        : Number(connection.daily_budget_usd)
                    }
                    label={`Daily limit used by ${connection.name}`}
                  />
                  <p className="tabular text-ink-muted mt-1 text-xs">
                    {formatUsd(connection.spent_today_usd)} recorded ·{" "}
                    {formatUsd(connection.reserved_today_usd)} reserved ·{" "}
                    {formatUsd(connection.unresolved_today_usd)} unresolved
                  </p>
                  {connection.total_budget_usd !== null ? (
                    <>
                      <div className="mt-3 mb-1 flex items-baseline justify-between gap-3 text-xs">
                        <span className="text-ink-muted">All time</span>
                        <span className="tabular">
                          <span className="font-semibold">{formatUsd(total)}</span>{" "}
                          <span className="text-ink-muted">
                            of {formatUsd(connection.total_budget_usd)}
                          </span>
                        </span>
                      </div>
                      <Meter
                        value={total}
                        max={Number(connection.total_budget_usd)}
                        label={`Total limit used by ${connection.name}`}
                      />
                    </>
                  ) : (
                    <p className="tabular text-ink-muted mt-2 text-xs">
                      All time: {formatUsd(total)} · no total limit
                    </p>
                  )}
                </div>
              );
            })}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Campaign budgets"
            description="Per campaign, in each campaign's own timezone day."
          />
          <CardBody>
            {budget.campaigns.filter((campaign) => campaign.status !== "draft").length === 0 ? (
              <p className="text-ink-muted text-[13px]">No launched campaigns.</p>
            ) : (
              <ul className="flex flex-col gap-5">
                {budget.campaigns
                  .filter((campaign) => campaign.status !== "draft")
                  .slice(0, 8)
                  .map((campaign) => {
                    const total =
                      Number(campaign.spent_total_usd) + Number(campaign.open_total_usd);
                    const today_ =
                      Number(campaign.spent_today_usd) + Number(campaign.reserved_today_usd);
                    return (
                      <li key={campaign.campaign_id}>
                        <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
                          <Link
                            href={`/campaigns/${campaign.campaign_id}`}
                            className="text-ink hover:text-brand-strong min-w-0 truncate font-semibold"
                          >
                            {campaign.name}
                          </Link>
                          <span className="tabular shrink-0 text-xs">
                            <span className="font-semibold">{formatUsd(total)}</span>{" "}
                            <span className="text-ink-muted">
                              of {formatUsd(campaign.total_budget_usd)}
                            </span>
                          </span>
                        </div>
                        <Meter
                          value={total}
                          max={
                            campaign.total_budget_usd === null
                              ? null
                              : Number(campaign.total_budget_usd)
                          }
                          label={`Total budget used by ${campaign.name}`}
                        />
                        <p className="tabular text-ink-muted mt-1 text-xs">
                          Today: {formatUsd(today_)} of {formatUsd(campaign.daily_budget_usd)}
                          {campaign.budget_skips > 0
                            ? ` · ${formatNumber(campaign.budget_skips)} slots skipped for budget`
                            : ""}
                          {campaign.budget_blocked > 0
                            ? ` · ${formatNumber(campaign.budget_blocked)} jobs waiting on budget`
                            : ""}
                        </p>
                      </li>
                    );
                  })}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div>
          <h2 className="text-ink mb-3 text-[15px] font-semibold">Cost by model</h2>
          {byModel.size === 0 ? (
            <p className="border-line-strong bg-surface text-ink-muted rounded-2xl border border-dashed px-4 py-8 text-center text-[13px]">
              No usage in this period.
            </p>
          ) : (
            <TableWrap label="Cost by model">
              <Table>
                <thead>
                  <tr>
                    <Th>Model</Th>
                    <Th className="text-right">Requests</Th>
                    <Th className="text-right">Input</Th>
                    <Th className="text-right">Cached</Th>
                    <Th className="text-right">Output</Th>
                    <Th className="text-right">Est. cost</Th>
                  </tr>
                </thead>
                <tbody>
                  {[...byModel.entries()]
                    .sort((a, b) => b[1].cost - a[1].cost)
                    .map(([model, entry]) => (
                      <Tr key={model}>
                        <Td className="font-mono text-xs font-semibold">{model}</Td>
                        <Td className="tabular text-right">{formatNumber(entry.requests)}</Td>
                        <Td className="tabular text-right">{formatNumber(entry.input)}</Td>
                        <Td className="tabular text-right">{formatNumber(entry.cached)}</Td>
                        <Td className="tabular text-right">{formatNumber(entry.output)}</Td>
                        <Td className="tabular text-right font-semibold">
                          {formatUsd(entry.cost, { precise: true })}
                        </Td>
                      </Tr>
                    ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </div>
        <div>
          <h2 className="text-ink mb-3 text-[15px] font-semibold">Cost by purpose</h2>
          {byPurpose.length === 0 ? (
            <p className="border-line-strong bg-surface text-ink-muted rounded-2xl border border-dashed px-4 py-8 text-center text-[13px]">
              No usage in this period.
            </p>
          ) : (
            <TableWrap label="Cost by purpose">
              <Table className="min-w-0">
                <thead>
                  <tr>
                    <Th>Purpose</Th>
                    <Th className="text-right">Requests</Th>
                    <Th className="text-right">Est. cost</Th>
                  </tr>
                </thead>
                <tbody>
                  {byPurpose.map((entry) => (
                    <Tr key={entry.purpose}>
                      <Td>
                        <span className="flex items-center gap-2">
                          <span
                            className="size-2.5 rounded-[3px]"
                            style={{ backgroundColor: PURPOSE_COLORS[entry.purpose] }}
                            aria-hidden="true"
                          />
                          {purposeLabel(entry.purpose)}
                        </span>
                      </Td>
                      <Td className="tabular text-right">{formatNumber(entry.requests)}</Td>
                      <Td className="tabular text-right font-semibold">
                        {formatUsd(entry.cost, { precise: true })}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </div>
      </div>

      <section className="mt-8" aria-labelledby="reservations">
        <h2 id="reservations" className="text-ink mb-1 text-[15px] font-semibold">
          Reservations
        </h2>
        <p className="text-ink-muted mb-3 max-w-3xl text-[13px]">
          Before a request is sent, its worst-case cost is reserved against the campaign and
          connection limits. When the response arrives the reservation is replaced by the actual
          estimated cost.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Stat
            label="Held for requests in flight"
            value={formatUsd(heldTotal)}
            detail={`${formatNumber((held.data ?? []).length)} reservation${(held.data ?? []).length === 1 ? "" : "s"} right now`}
          />
          <Stat
            label="Held for requests with an unknown outcome"
            value={formatUsd(unresolvedTotal)}
            tone={(unresolved.data ?? []).length > 0 ? "bad" : undefined}
            detail={`${formatNumber((unresolved.data ?? []).length)} waiting for a decision`}
          />
        </div>
      </section>

      <section className="mt-8 scroll-mt-24" id="unresolved" aria-labelledby="unresolved-title">
        <h2 id="unresolved-title" className="text-ink mb-1 text-[15px] font-semibold">
          Requests with an unknown outcome
        </h2>
        <p className="text-ink-muted mb-3 max-w-3xl text-[13px]">
          A request that timed out or lost its connection after being sent may still have been
          processed and billed. Where the provider gave a response ID, the app looks the response up
          and settles it automatically. The rest are listed here with their reservation still held,
          so budgets are not overstated or understated without a person deciding.
        </p>
        {(unresolved.data ?? []).length === 0 ? (
          <p className="border-line-strong bg-surface text-ink-muted rounded-2xl border border-dashed px-4 py-8 text-center text-[13px]">
            No requests are waiting for a decision.
          </p>
        ) : (
          <>
            <TableWrap label="Requests with an unknown outcome">
              <Table>
                <thead>
                  <tr>
                    <Th>Request</Th>
                    <Th>Sent</Th>
                    <Th>What happened</Th>
                    <Th className="text-right">Reserved</Th>
                    <Th className="text-right">Decision</Th>
                  </tr>
                </thead>
                <tbody>
                  {(unresolved.data ?? []).map((attempt) => (
                    <Tr key={attempt.id}>
                      <Td>
                        {attempt.run_id ? (
                          <Link
                            href={`/conversations/${attempt.run_id}`}
                            className="hover:text-brand-strong font-medium"
                          >
                            {purposeLabel(attempt.purpose)}
                          </Link>
                        ) : attempt.fresh_check_id ? (
                          <Link
                            href={`/fresh-checks/${attempt.fresh_check_id}`}
                            className="hover:text-brand-strong font-medium"
                          >
                            {purposeLabel(attempt.purpose)}
                          </Link>
                        ) : (
                          <span className="font-medium">{purposeLabel(attempt.purpose)}</span>
                        )}
                        <div className="text-ink-muted text-xs">
                          {attempt.campaign_id
                            ? (campaignName.get(attempt.campaign_id) ?? "Campaign")
                            : "Workspace tool"}{" "}
                          · <span className="font-mono">{attempt.requested_model}</span>
                        </div>
                      </Td>
                      <Td>
                        <LocalTime value={attempt.started_at} />
                      </Td>
                      <Td className="text-ink-muted max-w-sm text-xs whitespace-normal">
                        {errorClass(attempt.error_class) ?? "No response was received."}{" "}
                        {attempt.error_message ?? ""}
                      </Td>
                      <Td className="tabular text-right">
                        {formatUsd(reservedAmount.get(attempt.reservation_id ?? "") ?? null, {
                          precise: true,
                        })}
                      </Td>
                      <Td className="text-right">
                        {isOwner ? (
                          <ResolveAttemptButtons attemptId={attempt.id} />
                        ) : (
                          <span className="text-ink-muted text-xs">An owner decides</span>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
            {isOwner ? (
              <Callout tone="neutral" className="mt-3">
                Check the provider&apos;s usage dashboard for the time shown. “Count as spent” records
                the reserved amount as cost; “Release” returns it to the budgets.
              </Callout>
            ) : null}
          </>
        )}
      </section>
    </>
  );
}
