import Link from "next/link";
import { InclusionBadge, RunStatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatUsd } from "@/lib/format";
import { errorClass } from "@/lib/labels";
import type { RunListRow } from "@/lib/queries/runs";

export function RunsTable({
  rows,
  showCampaign = true,
}: {
  rows: RunListRow[];
  showCampaign?: boolean;
}) {
  return (
    <TableWrap label="Conversations">
      <Table>
        <thead>
          <tr>
            <Th>Conversation</Th>
            {showCampaign ? <Th>Campaign</Th> : null}
            <Th>Status</Th>
            <Th className="text-right">Turns</Th>
            <Th>First response</Th>
            <Th>Final response</Th>
            <Th className="text-right">Est. cost</Th>
            <Th>Started</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((run) => (
            <Tr key={run.id}>
              <Td>
                <Link
                  href={`/conversations/${run.id}`}
                  className="text-ink hover:text-brand-strong font-semibold"
                >
                  {run.kind === "test" ? "Test conversation" : `Conversation ${run.ordinal + 1}`}
                </Link>
                <div className="text-ink-muted mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                  {run.kind === "test" ? <Badge tone="info">Test</Badge> : null}
                  {run.restartOfRunId ? <Badge>Restart</Badge> : null}
                  {run.model ? <span className="font-mono">{run.model}</span> : null}
                </div>
              </Td>
              {showCampaign ? (
                <Td className="max-w-48 truncate">
                  <Link href={`/campaigns/${run.campaignId}`} className="hover:text-brand-strong">
                    {run.campaignName}
                  </Link>
                </Td>
              ) : null}
              <Td className="whitespace-normal">
                <RunStatusBadge status={run.status} />
                {run.errorClass ? (
                  <div className="text-ink-muted mt-1 max-w-52 text-xs">
                    {errorClass(run.errorClass)}
                  </div>
                ) : null}
              </Td>
              <Td className="tabular text-right">
                {run.stepsCompleted}
                <span className="text-ink-muted"> of {run.stepsTotal ?? "—"}</span>
              </Td>
              <Td>
                {run.first ? (
                  <InclusionBadge
                    inclusion={run.first.inclusion}
                    rank={run.first.rank}
                    listPosition={run.first.listPosition}
                  />
                ) : (
                  <span className="text-ink-muted">—</span>
                )}
              </Td>
              <Td>
                {run.final ? (
                  <InclusionBadge
                    inclusion={run.final.inclusion}
                    rank={run.final.rank}
                    listPosition={run.final.listPosition}
                  />
                ) : (
                  <span className="text-ink-muted">—</span>
                )}
              </Td>
              <Td className="tabular text-right">
                {run.costUsd > 0 ? (
                  formatUsd(run.costUsd, { precise: true })
                ) : (
                  <span className="text-ink-muted">—</span>
                )}
              </Td>
              <Td>
                <LocalTime value={run.startedAt ?? run.scheduledFor} />
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableWrap>
  );
}
