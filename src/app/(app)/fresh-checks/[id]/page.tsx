import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CorrectClassificationButton,
  ModelClassificationButton,
} from "@/components/classification-controls";
import { RetryJobButton } from "@/components/operations-buttons";
import { ResponseText } from "@/components/response-text";
import { AttemptStatusBadge, CheckStatusBadge, InclusionBadge } from "@/components/status";
import { Badge, Callout, Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { DefinitionList, Screen } from "@/components/ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate, formatDuration, formatNumber, formatUsd } from "@/lib/format";
import { errorClass, humanize, phaseLabel } from "@/lib/labels";
import type { MatchSpan } from "@/lib/queries/types";
import { hasRole, requireSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Fresh check" };

export default function FreshCheckPage(props: PageProps<"/fresh-checks/[id]">) {
  return (
    <Screen>
      <FreshCheck params={props.params} />
    </Screen>
  );
}

async function FreshCheck({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const session = await requireSession();
  const supabase = await createClient();
  const { data: check } = await supabase
    .from("fresh_checks")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", session.workspace.id)
    .maybeSingle();
  if (!check) notFound();
  const isAdmin = hasRole(session.role, "admin");

  const [
    { data: campaign },
    { data: revision },
    { data: group },
    { data: attempts },
    { data: classifications },
    { data: job },
  ] = await Promise.all([
    supabase.from("campaigns").select("id, name").eq("id", check.campaign_id).maybeSingle(),
    supabase
      .from("campaign_revisions")
      .select("revision_number, timezone")
      .eq("id", check.revision_id)
      .maybeSingle(),
    supabase
      .from("comparison_groups")
      .select("sequence")
      .eq("id", check.comparison_group_id)
      .maybeSingle(),
    supabase
      .from("provider_attempts")
      .select("*")
      .eq("fresh_check_id", check.id)
      .order("started_at"),
    supabase
      .from("classifications")
      .select("id, method, inclusion, matched_spans, reason, note, is_current, created_at")
      .eq("subject_type", "fresh_check")
      .eq("subject_id", check.id)
      .order("created_at"),
    supabase.from("jobs").select("id, status").eq("id", check.job_id).maybeSingle(),
  ]);
  const zone = revision?.timezone ?? null;
  const current = (classifications ?? []).find((item) => item.is_current);
  const sent = (attempts ?? []).at(-1)?.request_params as Record<string, unknown> | undefined;
  const settings = Object.entries((check.params ?? {}) as Record<string, unknown>).filter(
    ([, value]) => value !== null && value !== "",
  );

  return (
    <>
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-1.5">
            <Link
              href={`/fresh-checks?campaign=${check.campaign_id}`}
              className="hover:text-brand-strong"
            >
              Fresh Checks
            </Link>
            <span aria-hidden="true">/</span>
            <Link href={`/campaigns/${check.campaign_id}`} className="hover:text-brand-strong">
              {campaign?.name ?? "Campaign"}
            </Link>
          </span>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {phaseLabel(check.phase)} fresh check
            <CheckStatusBadge status={check.status} />
            {check.is_held_out ? <Badge tone="info">Held-out question</Badge> : null}
          </span>
        }
        description="One question, sent on its own in a new request."
        actions={
          isAdmin && job && ["dead", "blocked"].includes(job.status) ? (
            <RetryJobButton jobId={job.id} />
          ) : null
        }
      />

      {check.status === "excluded" ? (
        <Callout tone="warn" className="mb-4" title="Excluded from the results">
          {check.exclusion_reason ? humanize(check.exclusion_reason) : "This check was not sent."}.
          It is shown here so that nothing is hidden, and it is not counted.
        </Callout>
      ) : null}
      {check.content_purged_at ? (
        <Callout tone="neutral" className="mb-4" title="Text removed by the retention setting">
          The question and answer text was removed on{" "}
          <LocalTime value={check.content_purged_at} dateOnly />. The classification and usage are
          kept.
        </Callout>
      ) : null}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardBody className="flex flex-col gap-4">
              <div className="bg-brand-faint rounded-xl px-4 py-3">
                <p className="text-brand-strong mb-1 text-[11px] font-semibold tracking-wide uppercase">
                  The only message sent
                </p>
                <p className="text-ink text-[13px] leading-relaxed break-words whitespace-pre-wrap">
                  {check.rendered_prompt ?? <span className="text-ink-muted">Not sent yet.</span>}
                </p>
              </div>
              <div className="border-line rounded-xl border px-4 py-3">
                <p className="text-ink-muted mb-1 text-[11px] font-semibold tracking-wide uppercase">
                  The model answered
                </p>
                {check.output_text ? (
                  <ResponseText
                    text={check.output_text}
                    spans={(current?.matched_spans ?? []) as unknown as MatchSpan[]}
                  />
                ) : (
                  <p className="text-ink-muted text-[13px]">
                    {check.status === "completed"
                      ? "Text removed."
                      : "No answer has been received."}
                  </p>
                )}
                {check.status === "incomplete" ? (
                  <p className="text-warn mt-2 text-xs font-medium">
                    The response was cut off
                    {check.incomplete_reason
                      ? `: ${humanize(check.incomplete_reason).toLowerCase()}`
                      : ""}
                    . It is not counted.
                  </p>
                ) : null}
                {check.refusal ? (
                  <p className="text-warn mt-2 text-xs font-medium">
                    The model refused this request.
                  </p>
                ) : null}
              </div>
              {check.status === "completed" ? (
                <div className="bg-surface-alt flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-ink-muted mb-1 text-xs font-medium">Classification</p>
                    <InclusionBadge
                      inclusion={check.inclusion}
                      rank={check.rank}
                      listPosition={check.list_position}
                    />
                    {current ? (
                      <p className="text-ink-muted mt-1 text-xs">
                        {current.method === "manual"
                          ? "Set by a person"
                          : current.method === "model"
                            ? "Classified by the model"
                            : "Classified by the rules"}
                        {current.reason ? ` · ${current.reason}` : ""}
                        {current.note ? ` · Note: ${current.note}` : ""}
                      </p>
                    ) : null}
                    {(classifications ?? []).length > 1 ? (
                      <details className="text-ink-muted mt-1 text-xs">
                        <summary className="cursor-pointer">
                          History ({(classifications ?? []).length})
                        </summary>
                        <ul className="mt-1 flex flex-col gap-0.5">
                          {(classifications ?? []).map((item) => (
                            <li key={item.id}>
                              <LocalTime value={item.created_at} /> — {humanize(item.inclusion)} (
                              {item.method}){item.note ? `: ${item.note}` : ""}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </div>
                  {isAdmin && check.output_text ? (
                    <div className="flex flex-wrap gap-2">
                      <ModelClassificationButton subjectType="fresh_check" subjectId={check.id} />
                      <CorrectClassificationButton
                        subjectType="fresh_check"
                        subjectId={check.id}
                        current={{
                          inclusion: check.inclusion,
                          rank: check.rank,
                          listPosition: check.list_position,
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="What the request contained"
              description="Recorded from the request itself, so independence can be checked rather than assumed."
            />
            <CardBody>
              <DefinitionList
                items={[
                  {
                    term: "Earlier turns",
                    value:
                      sent && "previous_response_id" in sent && sent.previous_response_id ? (
                        <span className="text-bad">Continued from a previous response</span>
                      ) : (
                        "None — a new context"
                      ),
                  },
                  {
                    term: "Instructions",
                    value:
                      sent && "instructions" in sent && sent.instructions ? (
                        <span className="text-bad">Present</span>
                      ) : (
                        "None"
                      ),
                  },
                  {
                    term: "Business name, website or campaign details",
                    value:
                      "Not sent. The business is only used afterwards, in this app, to classify the answer.",
                  },
                  {
                    term: "Stored at the provider",
                    value: check.store_response ? "Yes (connection setting)" : "No",
                  },
                ]}
              />
            </CardBody>
          </Card>

          {(attempts ?? []).length > 0 ? (
            <TableWrap label="Requests sent for this check">
              <Table>
                <thead>
                  <tr>
                    <Th>Attempt</Th>
                    <Th>Outcome</Th>
                    <Th>Detail</Th>
                    <Th className="text-right">Time</Th>
                    <Th className="text-right">Est. cost</Th>
                    <Th>Sent</Th>
                  </tr>
                </thead>
                <tbody>
                  {(attempts ?? []).map((attempt) => (
                    <Tr key={attempt.id}>
                      <Td className="tabular">{attempt.attempt_number}</Td>
                      <Td>
                        <AttemptStatusBadge status={attempt.status} />
                      </Td>
                      <Td className="text-ink-muted max-w-sm text-xs whitespace-normal">
                        {attempt.error_class
                          ? errorClass(attempt.error_class)
                          : attempt.response_status
                            ? humanize(attempt.response_status)
                            : "—"}{" "}
                        {attempt.error_message ?? ""}
                        {attempt.provider_request_id ? (
                          <span className="block font-mono text-[11px] break-all">
                            Request ID {attempt.provider_request_id}
                          </span>
                        ) : null}
                      </Td>
                      <Td className="tabular text-right">{formatDuration(attempt.latency_ms)}</Td>
                      <Td className="tabular text-right">
                        {formatUsd(attempt.cost_usd, { precise: true })}
                      </Td>
                      <Td>
                        <LocalTime value={attempt.started_at} timeZone={zone} />
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          ) : null}
        </div>

        <aside className="flex flex-col gap-4" aria-label="Fresh check details">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <DefinitionList
                stacked
                items={[
                  {
                    term: "Phase",
                    value: `${phaseLabel(check.phase)}${check.phase === "daily" ? ` · ${formatDate(check.local_day)}` : ""}`,
                  },
                  { term: "Comparison group", value: group ? `Group ${group.sequence}` : "—" },
                  {
                    term: "Campaign revision",
                    value: revision ? `Revision ${revision.revision_number}` : "—",
                  },
                  {
                    term: "Question",
                    value: `Position ${check.question_position} in the set${check.is_held_out ? " · held out" : ""}`,
                  },
                  {
                    term: "Model requested → returned",
                    value: (
                      <span className="font-mono text-xs break-all">
                        {check.model} → {check.returned_model ?? "—"}
                      </span>
                    ),
                  },
                  {
                    term: "Settings",
                    value: `${settings.length ? settings.map(([key, value]) => `${key.replace(/_/g, " ")} ${String(value)}`).join(" · ") : "Model defaults"} · output cap ${formatNumber(check.max_output_tokens)}`,
                  },
                  {
                    term: "Response ID",
                    value: (
                      <span className="font-mono text-xs break-all">
                        {check.response_id ?? "—"}
                      </span>
                    ),
                  },
                  {
                    term: "Scheduled",
                    value: <LocalTime value={check.scheduled_for} timeZone={zone} />,
                  },
                  {
                    term: "Completed",
                    value: <LocalTime value={check.completed_at} timeZone={zone} />,
                  },
                ]}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Usage" description="Estimates from recorded tokens." />
            <CardBody>
              <DefinitionList
                stacked
                items={[
                  {
                    term: "Input tokens",
                    value: `${formatNumber(check.input_tokens)}${check.cached_input_tokens ? ` (${formatNumber(check.cached_input_tokens)} cached)` : ""}`,
                  },
                  {
                    term: "Output tokens",
                    value: `${formatNumber(check.output_tokens)}${check.reasoning_tokens ? ` (${formatNumber(check.reasoning_tokens)} reasoning)` : ""}`,
                  },
                  { term: "Estimated cost", value: formatUsd(check.cost_usd, { precise: true }) },
                  { term: "Response time", value: formatDuration(check.latency_ms) },
                ]}
              />
            </CardBody>
          </Card>
        </aside>
      </div>
    </>
  );
}
