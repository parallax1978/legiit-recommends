import { Badge } from "@/components/ui/card";
import {
  attemptStatus,
  campaignStatus,
  checkStatus,
  connectionStatus,
  inclusionStatus,
  jobStatus,
  runStatus,
  turnStatus,
  type StatusLabel,
} from "@/lib/labels";

function StatusBadge({ status, className }: { status: StatusLabel; className?: string }) {
  return (
    <span title={status.hint}>
      <Badge tone={status.tone} dot className={className}>
        {status.label}
      </Badge>
    </span>
  );
}

export function CampaignStatusBadge({ status, archived }: { status: string; archived?: boolean }) {
  if (archived) return <Badge tone="neutral">Archived</Badge>;
  return <StatusBadge status={campaignStatus(status)} />;
}
export const RunStatusBadge = ({ status }: { status: string | null }) => (
  <StatusBadge status={runStatus(status)} />
);
export const TurnStatusBadge = ({ status }: { status: string | null }) => (
  <StatusBadge status={turnStatus(status)} />
);
export const CheckStatusBadge = ({ status }: { status: string | null }) => (
  <StatusBadge status={checkStatus(status)} />
);
export const JobStatusBadge = ({ status }: { status: string | null }) => (
  <StatusBadge status={jobStatus(status)} />
);
export const AttemptStatusBadge = ({ status }: { status: string | null }) => (
  <StatusBadge status={attemptStatus(status)} />
);
export const ConnectionStatusBadge = ({ status }: { status: string | null }) => (
  <StatusBadge status={connectionStatus(status)} />
);

/** Classification of one response. Rank is shown only for numbered lists. */
export function InclusionBadge({
  inclusion,
  rank,
  listPosition,
}: {
  inclusion: string | null | undefined;
  rank?: number | null;
  listPosition?: number | null;
}) {
  if (!inclusion) return <span className="text-ink-muted">Not classified</span>;
  const status = inclusionStatus(inclusion);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" title={status.hint}>
      <Badge tone={status.tone}>{status.label}</Badge>
      {rank ? <span className="text-ink-muted text-xs">Ranked #{rank}</span> : null}
      {!rank && listPosition ? (
        <span className="text-ink-muted text-xs">List position {listPosition} (unranked)</span>
      ) : null}
    </span>
  );
}
