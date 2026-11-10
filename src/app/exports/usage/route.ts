import { csvResponse, exportContext, notFoundResponse } from "@/lib/export";
import { toCsv } from "@shared/core/csv.ts";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Daily usage totals for the current workspace as CSV. */
export async function GET(request: Request) {
  const ctx = await exportContext();
  if (ctx instanceof Response) return ctx;
  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const campaign = url.searchParams.get("campaign");
  if (!DAY.test(from) || !DAY.test(to) || (campaign !== null && !UUID.test(campaign)))
    return notFoundResponse();

  const [{ data, error }, { data: campaigns }] = await Promise.all([
    ctx.supabase.rpc("usage_daily", {
      p_workspace_id: ctx.session.workspace.id,
      p_from: from,
      p_to: to,
      p_campaign_id: campaign ?? undefined,
    }),
    ctx.supabase.from("campaigns").select("id, name").eq("workspace_id", ctx.session.workspace.id),
  ]);
  if (error) return notFoundResponse();
  const scope = campaign
    ? ((campaigns ?? []).find((item) => item.id === campaign)?.name ?? "")
    : "All activity in the workspace";

  return csvResponse(
    `usage-${from}-to-${to}.csv`,
    toCsv(data ?? [], [
      { header: "day_utc", value: (row) => row.usage_day },
      { header: "scope", value: () => scope },
      { header: "purpose", value: (row) => row.purpose },
      { header: "model", value: (row) => row.model },
      { header: "test", value: (row) => row.is_test },
      { header: "requests", value: (row) => Number(row.requests) },
      { header: "input_tokens", value: (row) => Number(row.input_tokens) },
      { header: "cached_input_tokens", value: (row) => Number(row.cached_input_tokens) },
      { header: "output_tokens", value: (row) => Number(row.output_tokens) },
      { header: "reasoning_tokens", value: (row) => Number(row.reasoning_tokens) },
      { header: "estimated_cost_usd", value: (row) => Number(row.cost_usd) },
      { header: "note", value: () => "Estimate from recorded token usage; not an invoice" },
    ]),
  );
}
