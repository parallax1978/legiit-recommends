import { PromptText } from "@/components/library/prompt-fields";
import { Badge, Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";
import { templateKind } from "@/lib/labels";
import type { ServerClient } from "@/lib/supabase/server";

/**
 * How often each wording has been used by the campaign's scheduled conversations, and how many
 * of the possible combinations have been used at least once.
 */
export async function WordingCoverage({
  supabase,
  campaignId,
}: {
  supabase: ServerClient;
  campaignId: string;
}) {
  const [coverage, runs] = await Promise.all([
    supabase.rpc("variation_coverage", { p_campaign_id: campaignId }),
    supabase
      .from("runs")
      .select("combination_index, revision_id")
      .eq("campaign_id", campaignId)
      .eq("kind", "scheduled")
      .not("combination_index", "is", null)
      .order("created_at", { ascending: false })
      .limit(1000),
  ]);
  const rows = coverage.data ?? [];
  if (coverage.error || rows.length === 0) return null;

  const steps = [...new Set(rows.map((row) => row.step_index))].sort((a, b) => a - b);
  const total = steps.reduce(
    (product, step) =>
      product *
      BigInt(
        Math.max(
          rows.filter((row) => row.step_index === step && row.in_current_revision).length,
          1,
        ),
      ),
    1n,
  );
  // Combination numbers are only comparable within one revision: count the newest one.
  const latestRevision = (runs.data ?? [])[0]?.revision_id;
  const used = new Set(
    (runs.data ?? [])
      .filter((run) => run.revision_id === latestRevision)
      .map((run) => String(run.combination_index)),
  ).size;
  const maxUses = Math.max(1, ...rows.map((row) => Number(row.uses)));

  return (
    <Card>
      <CardHeader
        title="Wording coverage"
        description={
          <>
            {formatNumber(used)} of {total.toLocaleString("en-US")} possible combination
            {total === 1n ? "" : "s"} used so far by the current revision. When every combination
            has been used, they repeat.
          </>
        }
      />
      <CardBody className="flex flex-col gap-5">
        {steps.map((step) => {
          const own = rows.filter((row) => row.step_index === step);
          return (
            <div key={step}>
              <h3 className="text-ink mb-2 text-[13px] font-semibold">
                Turn {step} · {templateKind(own[0]?.step_kind).label}
              </h3>
              <ul className="flex flex-col gap-2">
                {own.map((row) => (
                  <li
                    key={row.template_id}
                    className="grid grid-cols-1 items-center gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_8rem_5rem]"
                  >
                    <span className="min-w-0 text-[13px]">
                      <PromptText body={row.body ?? ""} />
                      {!row.in_current_revision ? (
                        <>
                          {" "}
                          <Badge>Earlier revision</Badge>
                        </>
                      ) : null}
                    </span>
                    <span
                      className="bg-brand-faint h-2 overflow-hidden rounded-full"
                      role="img"
                      aria-label={`Used ${row.uses} times`}
                    >
                      <span
                        className="bg-brand block h-full rounded-full"
                        style={{ width: `${(Number(row.uses) / maxUses) * 100}%` }}
                      />
                    </span>
                    <span className="tabular text-ink-muted text-[13px] sm:text-right">
                      <span className="text-ink font-semibold">{formatNumber(row.uses)}</span> use
                      {Number(row.uses) === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}
