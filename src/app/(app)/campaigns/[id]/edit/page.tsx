import type { Metadata } from "next";
import Link from "next/link";
import { CampaignEditor, type EditorModel } from "@/components/campaigns/campaign-editor";
import type { LibraryTemplate } from "@/components/campaigns/step-prompts";
import { CampaignStatusBadge } from "@/components/status";
import { ButtonLink } from "@/components/ui/button";
import { Callout, PageHeader } from "@/components/ui/card";
import { Screen } from "@/components/ui/misc";
import { inChunks, readError, rowsOf, selectAll } from "@/lib/batch";
import { first, type SearchParams } from "@/lib/params";
import {
  loadCampaign,
  loadRevision,
  loadRevisionSteps,
  toDraftInput,
} from "@/lib/queries/campaign";
import type { LaunchCheck, PlanPreview } from "@/lib/queries/types";
import { hasRole, requireSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import type { CapabilityProfile } from "@shared/core/capabilities.ts";
import type { TemplateKind } from "@shared/core/templates.ts";

export const metadata: Metadata = { title: "Edit campaign" };

export default function EditCampaignPage(props: PageProps<"/campaigns/[id]/edit">) {
  return (
    <Screen>
      <EditCampaign params={props.params} searchParams={props.searchParams} />
    </Screen>
  );
}

async function EditCampaign({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const showProblems = first((await searchParams).check) === "1";
  const session = await requireSession();
  const supabase = await createClient();
  const campaign = await loadCampaign(supabase, session, id);
  const workspaceId = session.workspace.id;
  const header = (
    <PageHeader
      eyebrow={
        <span className="flex flex-wrap items-center gap-1.5">
          <Link href="/campaigns" className="hover:text-brand-strong">
            Campaigns
          </Link>
          <span aria-hidden="true">/</span>
          <Link href={`/campaigns/${campaign.id}`} className="hover:text-brand-strong">
            {campaign.name}
          </Link>
        </span>
      }
      title={
        <span className="flex flex-wrap items-center gap-3">
          {campaign.status === "draft" ? "Set up campaign" : "Edit campaign"}
          <CampaignStatusBadge status={campaign.status} archived={Boolean(campaign.archived_at)} />
        </span>
      }
      description="Fields start empty: enter the values for this campaign. Save as often as you like; nothing is sent to the provider until you launch."
    />
  );

  if (!hasRole(session.role, "admin")) {
    return (
      <>
        {header}
        <Callout
          tone="neutral"
          title="You can view this campaign but not change it"
          action={
            <ButtonLink
              href={`/campaigns/${campaign.id}?tab=configuration`}
              variant="secondary"
              size="sm"
            >
              View configuration
            </ButtonLink>
          }
        >
          Only admins and owners can edit campaigns.
        </Callout>
      </>
    );
  }
  if (campaign.archived_at || ["completed", "canceled", "finalizing"].includes(campaign.status)) {
    return (
      <>
        {header}
        <Callout
          tone="neutral"
          title="This campaign can no longer be edited"
          action={
            <ButtonLink href={`/campaigns/${campaign.id}`} variant="secondary" size="sm">
              Back to campaign
            </ButtonLink>
          }
        >
          {campaign.archived_at
            ? "Restore it from the archive first."
            : "It has finished. Duplicate it from the campaign list to run it again with changes."}
        </Callout>
      </>
    );
  }

  const revisionId = campaign.draft_revision_id ?? campaign.active_revision_id;
  if (!revisionId) throw new Error("This campaign has no configuration.");
  const [
    revision,
    steps,
    templatesResult,
    connectionsResult,
    modelsResult,
    probeSetsResult,
    pricesResult,
    checkResult,
    previewResult,
  ] = await Promise.all([
    loadRevision(supabase, revisionId),
    loadRevisionSteps(supabase, revisionId),
    selectAll("Prompts", (from, to) =>
      supabase
        .from("templates")
        .select("id, kind, label, collection, archived_at, current_version_id")
        .eq("workspace_id", workspaceId)
        .neq("kind", "fresh_check")
        .order("created_at")
        .order("id")
        .range(from, to),
    ),
    supabase
      .from("provider_connections")
      .select("id, name, status, max_concurrent_requests")
      .eq("workspace_id", workspaceId)
      .is("archived_at", null)
      .order("created_at"),
    supabase
      .from("provider_models")
      .select("connection_id, model_id, capabilities, is_listed")
      .eq("workspace_id", workspaceId)
      .eq("verification_status", "verified")
      .order("model_id"),
    selectAll("Question sets", (from, to) =>
      supabase
        .from("probe_sets")
        .select("id, name, current_version_id, archived_at")
        .eq("workspace_id", workspaceId)
        .order("created_at")
        .order("id")
        .range(from, to),
    ),
    supabase.rpc("effective_prices", { p_workspace_id: workspaceId }),
    supabase.rpc("campaign_launch_check", { p_campaign_id: campaign.id }),
    supabase.rpc("campaign_plan_preview", { p_campaign_id: campaign.id }),
  ]);
  // A list that could not be read is not an empty list: the editor would otherwise claim that
  // there is no connection, no verified model or no price.
  const failed =
    connectionsResult.error ??
    modelsResult.error ??
    pricesResult.error ??
    checkResult.error ??
    previewResult.error;
  if (failed) throw readError("The campaign", failed);

  const allTemplates = templatesResult;
  const versionIds = allTemplates
    .map((template) => template.current_version_id)
    .filter((value): value is string => Boolean(value));
  const setVersionIds = probeSetsResult
    .map((set) => set.current_version_id)
    .filter((value): value is string => Boolean(value));
  // Asked for in chunks: a library of a few hundred prompts no longer fits in one request URL.
  const [versions, questions] = await Promise.all([
    inChunks(versionIds, (chunk) =>
      rowsOf(
        "Prompt wording",
        supabase.from("template_versions").select("id, body").in("id", chunk),
      ),
    ),
    inChunks(setVersionIds, (chunk) =>
      selectAll("Questions", (from, to) =>
        supabase
          .from("probe_questions")
          .select("probe_set_version_id, is_held_out")
          .in("probe_set_version_id", chunk)
          .order("probe_set_version_id")
          .order("position")
          .range(from, to),
      ),
    ),
  ]);
  const bodyByVersion = new Map(versions.map((version) => [version.id, version.body]));
  const selectedIds = new Set(
    steps.flatMap((step) => step.wordings.map((wording) => wording.templateId)),
  );
  const templates: LibraryTemplate[] = allTemplates
    .filter((template) => !template.archived_at || selectedIds.has(template.id))
    .map((template) => ({
      id: template.id,
      kind: template.kind as TemplateKind,
      body: (template.current_version_id && bodyByVersion.get(template.current_version_id)) || "",
      label: template.label,
      collection: template.collection,
      archived: Boolean(template.archived_at),
    }));

  const priced = new Set((pricesResult.data ?? []).map((price) => price.model_id));
  const models: EditorModel[] = (modelsResult.data ?? [])
    .filter((model) => model.capabilities)
    .map((model) => ({
      connectionId: model.connection_id,
      model: model.model_id,
      capabilities: model.capabilities as unknown as CapabilityProfile,
      priced: priced.has(model.model_id),
      listed: model.is_listed,
    }));
  const probeSets = probeSetsResult
    .filter((set) => !set.archived_at || set.id === revision.probe_set_id)
    .map((set) => {
      const own = questions.filter(
        (question) => question.probe_set_version_id === set.current_version_id,
      );
      return {
        id: set.id,
        name: set.name,
        questions: own.length,
        heldOut: own.filter((question) => question.is_held_out).length,
        archived: Boolean(set.archived_at),
      };
    });

  return (
    <>
      {header}
      <CampaignEditor
        data={{
          workspaceId,
          campaign: {
            id: campaign.id,
            status: campaign.status,
            launched: campaign.status !== "draft",
            started: Boolean(campaign.started_at),
          },
          initial: toDraftInput(campaign, revision, steps),
          templates,
          connections: (connectionsResult.data ?? []).map((connection) => ({
            id: connection.id,
            name: connection.name,
            status: connection.status,
            maxConcurrent: connection.max_concurrent_requests,
          })),
          models,
          probeSets,
          check: checkResult.data as unknown as LaunchCheck,
          preview: previewResult.data as unknown as PlanPreview,
          showProblems,
        }}
      />
    </>
  );
}
