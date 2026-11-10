import { Download } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CorrectClassificationButton,
  ModelClassificationButton,
} from "@/components/classification-controls";
import { RestartRunButton, RetryJobButton } from "@/components/operations-buttons";
import { ResponseText } from "@/components/response-text";
import {
  AttemptStatusBadge,
  InclusionBadge,
  JobStatusBadge,
  RunStatusBadge,
  TurnStatusBadge,
} from "@/components/status";
import { Badge, Callout, Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { DefinitionList, Screen } from "@/components/ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDuration, formatNumber, formatUsd } from "@/lib/format";
import { errorClass, humanize, reasonText, templateKind } from "@/lib/labels";
import type { MatchSpan } from "@/lib/queries/types";
import { hasRole, requireSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Conversation" };

export default function ConversationPage(props: PageProps<"/conversations/[id]">) {
  return (
    <Screen>
      <Conversation params={props.params} />
    </Screen>
  );
}

function paramsText(params: unknown): string {
  const entries = Object.entries((params ?? {}) as Record<string, unknown>).filter(
    ([, value]) => value !== null && value !== undefined && value !== "",
  );
  return entries.length === 0
    ? "Model defaults"
    : entries.map(([key, value]) => `${key.replace(/_/g, " ")} ${String(value)}`).join(" · ");
}

async function Conversation({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const session = await requireSession();
  const supabase = await createClient();
  const { data: run } = await supabase
    .from("runs")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", session.workspace.id)
    .maybeSingle();
  if (!run) notFound();
  const isAdmin = hasRole(session.role, "admin");

  const [
    { data: campaign },
    { data: revision },
    { data: job },
    { data: turns },
    { data: attempts },
    { data: restarts },
  ] = await Promise.all([
    supabase.from("campaigns").select("id, name, status").eq("id", run.campaign_id).maybeSingle(),
    supabase
      .from("campaign_revisions")
      .select("revision_number, timezone")
      .eq("id", run.revision_id)
      .maybeSingle(),
    supabase
      .from("jobs")
      .select(
        "id, status, status_reason, attempts, max_attempts, next_attempt_at, last_error_class, last_error_message",
      )
      .eq("id", run.job_id)
      .maybeSingle(),
    supabase.from("run_turns").select("*").eq("run_id", run.id).order("step_index"),
    supabase.from("provider_attempts").select("*").eq("run_id", run.id).order("started_at"),
    supabase.from("runs").select("id, status").eq("restart_of_run_id", run.id),
  ]);
  const turnIds = (turns ?? []).map((turn) => turn.id);
  const { data: classifications } = turnIds.length
    ? await supabase
        .from("classifications")
        .select(
          "id, subject_id, method, inclusion, rank, list_position, list_kind, matched_spans, reason, note, is_current, created_at",
        )
        .eq("subject_type", "run_turn")
        .in("subject_id", turnIds)
        .order("created_at")
    : { data: [] };

  const totals = (turns ?? []).reduce(
    (sum, turn) => ({
      input: sum.input + (turn.input_tokens ?? 0),
      cached: sum.cached + (turn.cached_input_tokens ?? 0),
      output: sum.output + (turn.output_tokens ?? 0),
      reasoning: sum.reasoning + (turn.reasoning_tokens ?? 0),
      cost: sum.cost + Number(turn.cost_usd ?? 0),
    }),
    { input: 0, cached: 0, output: 0, reasoning: 0, cost: 0 },
  );
  const attemptCost = (attempts ?? []).reduce(
    (sum, attempt) => sum + Number(attempt.cost_usd ?? 0),
    0,
  );
  const zone = revision?.timezone ?? null;
  const combination = (run.combination ?? null) as { template_ids?: string[] } | null;
  const restartable =
    ["expired", "failed", "incomplete"].includes(run.status) && (restarts ?? []).length === 0;
  const title = run.kind === "test" ? "Test conversation" : `Conversation ${run.ordinal + 1}`;

  return (
    <>
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-1.5">
            <Link href="/conversations" className="hover:text-brand-strong">
              Conversations
            </Link>
            <span aria-hidden="true">/</span>
            <Link href={`/campaigns/${run.campaign_id}`} className="hover:text-brand-strong">
              {campaign?.name ?? "Campaign"}
            </Link>
          </span>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {title}
            <RunStatusBadge status={run.status} />
            {run.kind === "test" ? <Badge tone="info">Test — excluded from results</Badge> : null}
          </span>
        }
        description="The exact messages sent and the model's own answers, turn by turn."
        actions={
          <>
            {isAdmin &&
            job &&
            ["dead", "blocked"].includes(job.status) &&
            run.status !== "expired" ? (
              <RetryJobButton jobId={job.id} label="Retry from the last saved turn" />
            ) : null}
            {isAdmin && restartable ? <RestartRunButton runId={run.id} /> : null}
            <a
              href={`/exports/conversations/${run.id}`}
              download
              className="border-line-strong bg-surface text-ink hover:bg-surface-alt inline-flex h-9 items-center gap-2 rounded-full border px-4 text-sm font-semibold"
            >
              <Download className="size-4" aria-hidden="true" />
              Transcript (JSON)
            </a>
          </>
        }
      />

      {run.status === "expired" ? (
        <Callout tone="warn" className="mb-4" title="This conversation can no longer be continued">
          The provider no longer has the stored response the next turn would continue from. It is
          never silently replayed: an admin can start it again as a new conversation, which is
          recorded separately.
        </Callout>
      ) : null}
      {run.status === "unresolved" ? (
        <Callout tone="warn" className="mb-4" title="A request has an unknown outcome">
          A request timed out or its connection dropped after it was sent, so the provider may still
          have processed it. Its reserved cost stays held until an owner resolves it under Usage.
        </Callout>
      ) : null}
      {job && ["dead", "blocked", "waiting", "paused"].includes(job.status) ? (
        <Callout
          tone={job.status === "dead" ? "bad" : "warn"}
          className="mb-4"
          title={
            <span className="flex items-center gap-2">
              Background job <JobStatusBadge status={job.status} />
            </span>
          }
        >
          {reasonText(job.status_reason) ?? errorClass(job.last_error_class) ?? ""}{" "}
          {job.last_error_message ?? ""}
          {job.status === "waiting" && job.next_attempt_at ? (
            <>
              {" "}
              Next attempt <LocalTime value={job.next_attempt_at} />.
            </>
          ) : null}
        </Callout>
      ) : null}
      {(restarts ?? []).length > 0 ? (
        <Callout tone="info" className="mb-4" title="This conversation was restarted">
          <Link
            href={`/conversations/${restarts![0]!.id}`}
            className="text-brand hover:text-brand-strong font-medium"
          >
            Open the new conversation
          </Link>
        </Callout>
      ) : null}
      {run.content_purged_at ? (
        <Callout tone="neutral" className="mb-4" title="Text removed by the retention setting">
          The prompt and response text of this conversation was removed on{" "}
          <LocalTime value={run.content_purged_at} dateOnly />. Its classifications, usage and
          timing are kept.
        </Callout>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          {(turns ?? []).length === 0 ? (
            <Card>
              <CardBody>
                <p className="text-ink-muted text-[13px]">
                  Nothing has been sent yet. The messages are fixed when the conversation is picked
                  up by a worker.
                </p>
              </CardBody>
            </Card>
          ) : null}
          {(turns ?? []).map((turn) => {
            const history = (classifications ?? []).filter((item) => item.subject_id === turn.id);
            const current = history.find((item) => item.is_current);
            const own = (attempts ?? []).filter((attempt) => attempt.run_turn_id === turn.id);
            return (
              <Card key={turn.id}>
                <CardHeader
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      Turn {turn.step_index} · {templateKind(turn.step_kind).label}
                      <TurnStatusBadge status={turn.status} />
                    </span>
                  }
                  description={
                    turn.completed_at ? (
                      <>
                        Answered <LocalTime value={turn.completed_at} timeZone={zone} /> ·{" "}
                        {formatDuration(turn.latency_ms)}
                      </>
                    ) : turn.started_at ? (
                      <>
                        Sent <LocalTime value={turn.started_at} timeZone={zone} />
                      </>
                    ) : (
                      "Not sent yet"
                    )
                  }
                />
                <CardBody className="flex flex-col gap-4">
                  <div className="bg-brand-faint rounded-xl px-4 py-3">
                    <p className="text-brand-strong mb-1 text-[11px] font-semibold tracking-wide uppercase">
                      You sent
                    </p>
                    <p className="text-ink text-[13px] leading-relaxed break-words whitespace-pre-wrap">
                      {turn.rendered_prompt ?? (
                        <span className="text-ink-muted">Text removed.</span>
                      )}
                    </p>
                  </div>
                  <div className="border-line rounded-xl border px-4 py-3">
                    <p className="text-ink-muted mb-1 text-[11px] font-semibold tracking-wide uppercase">
                      The model answered
                    </p>
                    {turn.output_text ? (
                      <ResponseText
                        text={turn.output_text}
                        spans={(current?.matched_spans ?? []) as unknown as MatchSpan[]}
                      />
                    ) : (
                      <p className="text-ink-muted text-[13px]">
                        {turn.status === "completed"
                          ? "Text removed."
                          : turn.status === "pending"
                            ? "Not sent yet."
                            : turn.status === "skipped"
                              ? "Skipped."
                              : "No answer was received."}
                      </p>
                    )}
                    {turn.status === "incomplete" ? (
                      <p className="text-warn mt-2 text-xs font-medium">
                        The response was cut off
                        {turn.incomplete_reason
                          ? `: ${humanize(turn.incomplete_reason).toLowerCase()}`
                          : ""}
                        . It is not counted.
                      </p>
                    ) : null}
                    {turn.refusal ? (
                      <p className="text-warn mt-2 text-xs font-medium">
                        The model refused this request.
                      </p>
                    ) : null}
                  </div>

                  {turn.status === "completed" ? (
                    <div className="bg-surface-alt flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-ink-muted mb-1 text-xs font-medium">Classification</p>
                        <InclusionBadge
                          inclusion={turn.inclusion}
                          rank={turn.rank}
                          listPosition={turn.list_position}
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
                        {history.length > 1 ? (
                          <details className="text-ink-muted mt-1 text-xs">
                            <summary className="cursor-pointer">History ({history.length})</summary>
                            <ul className="mt-1 flex flex-col gap-0.5">
                              {history.map((item) => (
                                <li key={item.id}>
                                  <LocalTime value={item.created_at} /> — {humanize(item.inclusion)}{" "}
                                  ({item.method}){item.note ? `: ${item.note}` : ""}
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                      </div>
                      {isAdmin && turn.output_text ? (
                        <div className="flex flex-wrap gap-2">
                          <ModelClassificationButton subjectType="run_turn" subjectId={turn.id} />
                          <CorrectClassificationButton
                            subjectType="run_turn"
                            subjectId={turn.id}
                            current={{
                              inclusion: turn.inclusion,
                              rank: turn.rank,
                              listPosition: turn.list_position,
                            }}
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
                    <div>
                      <dt className="text-ink-muted">Input tokens</dt>
                      <dd className="tabular font-medium">
                        {formatNumber(turn.input_tokens)}
                        {turn.cached_input_tokens ? (
                          <span className="text-ink-muted font-normal">
                            {" "}
                            ({formatNumber(turn.cached_input_tokens)} cached)
                          </span>
                        ) : null}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-muted">Output tokens</dt>
                      <dd className="tabular font-medium">
                        {formatNumber(turn.output_tokens)}
                        {turn.reasoning_tokens ? (
                          <span className="text-ink-muted font-normal">
                            {" "}
                            ({formatNumber(turn.reasoning_tokens)} reasoning)
                          </span>
                        ) : null}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-muted">Estimated cost</dt>
                      <dd className="tabular font-medium">
                        {formatUsd(turn.cost_usd, { precise: true })}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-muted">Attempts</dt>
                      <dd className="tabular font-medium">
                        {formatNumber(own.length || turn.attempt_count)}
                      </dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-ink-muted">Model requested → returned</dt>
                      <dd className="font-mono text-[11px] break-all">
                        {turn.requested_model ?? "—"} → {turn.returned_model ?? "—"}
                      </dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-ink-muted">
                        Response ID{turn.previous_response_id ? " ← continues from" : ""}
                      </dt>
                      <dd className="font-mono text-[11px] break-all">
                        {turn.response_id ?? "—"}
                        {turn.previous_response_id
                          ? ` ← ${turn.previous_response_id}`
                          : turn.step_index === 1 && turn.response_id
                            ? " (new context)"
                            : ""}
                      </dd>
                    </div>
                  </dl>
                </CardBody>
              </Card>
            );
          })}

          <div>
            <h2 className="text-ink mb-3 text-[15px] font-semibold">Request history</h2>
            {(attempts ?? []).length === 0 ? (
              <p className="border-line-strong bg-surface text-ink-muted rounded-2xl border border-dashed px-4 py-6 text-center text-[13px]">
                No requests have been sent for this conversation.
              </p>
            ) : (
              <TableWrap label="Every request sent for this conversation">
                <Table>
                  <thead>
                    <tr>
                      <Th>Turn</Th>
                      <Th>Attempt</Th>
                      <Th>Outcome</Th>
                      <Th>Detail</Th>
                      <Th className="text-right">Time</Th>
                      <Th className="text-right">Est. cost</Th>
                      <Th>Sent</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {(attempts ?? []).map((attempt) => {
                      const turn = (turns ?? []).find((item) => item.id === attempt.run_turn_id);
                      return (
                        <Tr key={attempt.id}>
                          <Td className="tabular">{turn ? turn.step_index : "—"}</Td>
                          <Td className="tabular">
                            {attempt.attempt_number}
                            {attempt.mode === "background" ? (
                              <span className="text-ink-muted"> · background</span>
                            ) : null}
                          </Td>
                          <Td>
                            <AttemptStatusBadge status={attempt.status} />
                          </Td>
                          <Td className="text-ink-muted max-w-sm text-xs whitespace-normal">
                            {attempt.error_class
                              ? errorClass(attempt.error_class)
                              : attempt.response_status
                                ? humanize(attempt.response_status)
                                : "—"}
                            {attempt.http_status ? ` HTTP ${attempt.http_status}.` : ""}{" "}
                            {attempt.error_message ?? ""}
                            {attempt.retry_after_ms
                              ? ` Provider asked to wait ${formatDuration(attempt.retry_after_ms)}.`
                              : ""}
                            {attempt.resolution
                              ? ` Resolved: ${humanize(attempt.resolution).toLowerCase()}.`
                              : ""}
                            {attempt.provider_request_id ? (
                              <span className="block font-mono text-[11px] break-all">
                                Request ID {attempt.provider_request_id}
                              </span>
                            ) : null}
                          </Td>
                          <Td className="tabular text-right">
                            {formatDuration(attempt.latency_ms)}
                          </Td>
                          <Td className="tabular text-right">
                            {formatUsd(attempt.cost_usd, { precise: true })}
                          </Td>
                          <Td>
                            <LocalTime value={attempt.started_at} timeZone={zone} />
                          </Td>
                        </Tr>
                      );
                    })}
                  </tbody>
                </Table>
              </TableWrap>
            )}
            <p className="text-ink-muted mt-2 text-xs">
              Each request is recorded before it is sent. Automatic retries by the client library
              are switched off, so every attempt appears here.
            </p>
          </div>
        </div>

        <aside className="flex flex-col gap-4" aria-label="Conversation details">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <DefinitionList
                stacked
                items={[
                  {
                    term: "Campaign revision",
                    value: revision ? `Revision ${revision.revision_number}` : "—",
                  },
                  {
                    term: "Model requested",
                    value: <span className="font-mono text-xs">{run.model ?? "—"}</span>,
                  },
                  {
                    term: "Settings",
                    value: `${paramsText(run.model_params)} · output cap ${formatNumber(run.max_output_tokens)}`,
                  },
                  {
                    term: "Turns",
                    value: `${run.steps_completed} of ${run.steps_total ?? "—"} completed`,
                  },
                  {
                    term: "Business in the first answer",
                    value:
                      run.target_in_first_response === null
                        ? "Not known yet"
                        : run.target_in_first_response
                          ? "Yes — before it was requested"
                          : "No",
                  },
                  ...(run.target_in_initial_prompt
                    ? [
                        {
                          term: "Initial question",
                          value: <span className="text-warn">Named the business itself</span>,
                        },
                      ]
                    : []),
                  {
                    term: "Scheduled",
                    value: <LocalTime value={run.scheduled_for} timeZone={zone} />,
                  },
                  { term: "Started", value: <LocalTime value={run.started_at} timeZone={zone} /> },
                  {
                    term: "Finished",
                    value: <LocalTime value={run.completed_at} timeZone={zone} />,
                  },
                  ...(run.restart_of_run_id
                    ? [
                        {
                          term: "Restart of",
                          value: (
                            <Link
                              href={`/conversations/${run.restart_of_run_id}`}
                              className="text-brand hover:text-brand-strong font-medium"
                            >
                              the original conversation
                            </Link>
                          ),
                        },
                      ]
                    : []),
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
                    value: `${formatNumber(totals.input)}${totals.cached ? ` (${formatNumber(totals.cached)} cached)` : ""}`,
                  },
                  {
                    term: "Output tokens",
                    value: `${formatNumber(totals.output)}${totals.reasoning ? ` (${formatNumber(totals.reasoning)} reasoning)` : ""}`,
                  },
                  {
                    term: "Estimated cost of completed turns",
                    value: formatUsd(totals.cost, { precise: true }),
                  },
                  {
                    term: "Estimated cost of all requests",
                    value: formatUsd(attemptCost, { precise: true }),
                  },
                ]}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Wording selection" />
            <CardBody>
              <DefinitionList
                stacked
                items={[
                  {
                    term: "Method",
                    value:
                      run.selection_mode === "seeded_random"
                        ? "Seeded random"
                        : run.selection_mode === "balanced"
                          ? "Balanced"
                          : "—",
                  },
                  {
                    term: "Seed",
                    value: (
                      <span className="font-mono text-xs break-all">
                        {run.selection_seed ?? "—"}
                      </span>
                    ),
                  },
                  {
                    term: "Combination",
                    value:
                      run.combination_index === null
                        ? "—"
                        : `#${Number(run.combination_index) + 1}${combination?.template_ids ? ` (${combination.template_ids.length} prompts)` : ""}`,
                  },
                ]}
              />
            </CardBody>
          </Card>
        </aside>
      </div>
    </>
  );
}
