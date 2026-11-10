import { MessagesSquare } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { RunsTable } from "@/components/runs-table";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/card";
import { Select } from "@/components/ui/form";
import { Pagination, Screen } from "@/components/ui/misc";
import { first, pageNumber, uuidParam, type SearchParams } from "@/lib/params";
import { RUN_PAGE_SIZE, listRuns } from "@/lib/queries/runs";
import { requireSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Conversations" };

export default function ConversationsPage(props: PageProps<"/conversations">) {
  return (
    <Screen>
      <Conversations searchParams={props.searchParams} />
    </Screen>
  );
}

const STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  { value: "active", label: "Queued or in progress" },
  { value: "done", label: "Completed" },
  { value: "completed_early", label: "Finished early" },
  { value: "problem", label: "With problems" },
  { value: "incomplete", label: "Incomplete" },
  { value: "failed", label: "Failed" },
  { value: "expired", label: "Expired" },
  { value: "unresolved", label: "Unresolved" },
  { value: "canceled", label: "Canceled" },
];

async function Conversations({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await requireSession();
  const params = await searchParams;
  const supabase = await createClient();
  const campaignId = uuidParam(params.campaign);
  const status = STATUS_OPTIONS.some((option) => option.value === first(params.status))
    ? first(params.status)
    : "";
  const kind = ["scheduled", "test"].includes(first(params.kind)) ? first(params.kind) : "";
  const inclusion = ["included", "mentioned_only", "not_mentioned", "ambiguous"].includes(
    first(params.inclusion),
  )
    ? first(params.inclusion)
    : "";
  const page = pageNumber(params.page);

  const [{ data: campaigns }, { rows, total }, anyRun] = await Promise.all([
    supabase
      .from("campaigns")
      .select("id, name")
      .eq("workspace_id", session.workspace.id)
      .neq("status", "draft")
      .order("created_at", { ascending: false }),
    listRuns(
      supabase,
      { workspaceId: session.workspace.id, campaignId, status, kind, inclusion },
      page,
    ),
    supabase
      .from("runs")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", session.workspace.id),
  ]);
  const filtered = Boolean(campaignId || status || kind || inclusion);

  return (
    <>
      <PageHeader
        title="Conversations"
        description="Every conversation the campaigns have run, with the exact messages sent and the model's real answers."
      />
      {(anyRun.count ?? 0) === 0 ? (
        <EmptyState
          icon={<MessagesSquare className="size-5" aria-hidden="true" />}
          title="No conversations yet"
          description="Conversations appear here as soon as a launched campaign starts running them, or when you run a test conversation from a campaign."
        />
      ) : (
        <>
          <form
            method="get"
            action="/conversations"
            className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))_auto]"
            role="search"
          >
            <div className="flex flex-col gap-1.5">
              <label htmlFor="f-campaign" className="text-ink-muted text-xs font-medium">
                Campaign
              </label>
              <Select id="f-campaign" name="campaign" defaultValue={campaignId ?? ""}>
                <option value="">All campaigns</option>
                {(campaigns ?? []).map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="f-status" className="text-ink-muted text-xs font-medium">
                Status
              </label>
              <Select id="f-status" name="status" defaultValue={status}>
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="f-inclusion" className="text-ink-muted text-xs font-medium">
                Any response classified as
              </label>
              <Select id="f-inclusion" name="inclusion" defaultValue={inclusion}>
                <option value="">Any classification</option>
                <option value="included">Included</option>
                <option value="mentioned_only">Mentioned only</option>
                <option value="not_mentioned">Not mentioned</option>
                <option value="ambiguous">Needs review</option>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="f-kind" className="text-ink-muted text-xs font-medium">
                Type
              </label>
              <Select id="f-kind" name="kind" defaultValue={kind}>
                <option value="">Scheduled and test</option>
                <option value="scheduled">Scheduled only</option>
                <option value="test">Test only</option>
              </Select>
            </div>
            <div className="flex items-end gap-3">
              <Button type="submit" variant="secondary">
                Apply
              </Button>
              {filtered ? (
                <Link
                  href="/conversations"
                  className="text-brand hover:text-brand-strong pb-2 text-[13px] font-medium"
                >
                  Clear
                </Link>
              ) : null}
            </div>
          </form>
          {rows.length === 0 ? (
            <p className="border-line-strong bg-surface text-ink-muted rounded-2xl border border-dashed px-4 py-10 text-center text-[13px]">
              No conversations match these filters.
            </p>
          ) : (
            <RunsTable rows={rows} showCampaign={!campaignId} />
          )}
          <Pagination
            page={page}
            pageSize={RUN_PAGE_SIZE}
            total={total}
            path="/conversations"
            params={{ campaign: campaignId, status, kind, inclusion }}
          />
        </>
      )}
    </>
  );
}
