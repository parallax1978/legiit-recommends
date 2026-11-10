import { BookOpenText, Plus, ScanSearch } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import {
  AddPromptButton,
  ExportPromptsLink,
  GenerateButton,
  ImportCsvButton,
  PromptRowActions,
  type GeneratorModel,
} from "@/components/library/prompt-dialogs";
import { PromptText } from "@/components/library/prompt-fields";
import {
  ArchiveQuestionSetButton,
  QuestionSetButton,
} from "@/components/library/question-set-editor";
import { Button } from "@/components/ui/button";
import { Badge, Callout, EmptyState, PageHeader } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/form";
import { LocalTime } from "@/components/ui/local-time";
import { PermissionNote, Screen, Tabs, buildHref } from "@/components/ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { CONVERSATION_KINDS, templateKind } from "@/lib/labels";
import { first, type SearchParams } from "@/lib/params";
import { hasRole, requireSession, type Session } from "@/lib/session";
import { createClient, type ServerClient } from "@/lib/supabase/server";
import type { TemplateKind } from "@shared/core/templates.ts";

export const metadata: Metadata = { title: "Prompt Library" };

export default function LibraryPage(props: PageProps<"/library">) {
  return (
    <Screen>
      <Library searchParams={props.searchParams} />
    </Screen>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  manual: "Written",
  csv_import: "CSV import",
  ai_generated: "AI generated",
};

async function Library({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await requireSession();
  const params = await searchParams;
  const tab = first(params.tab) === "question-sets" ? "question-sets" : "prompts";
  const supabase = await createClient();

  return (
    <>
      <PageHeader
        title="Prompt Library"
        description="The wordings your campaigns choose from. Nothing here is sent anywhere until a campaign that uses it is launched."
      />
      <Tabs
        label="Library sections"
        active={tab}
        tabs={[
          { id: "prompts", label: "Conversation prompts", href: "/library" },
          {
            id: "question-sets",
            label: "Fresh-check question sets",
            href: "/library?tab=question-sets",
          },
        ]}
      />
      {tab === "prompts" ? (
        <Prompts session={session} supabase={supabase} params={params} />
      ) : (
        <QuestionSets session={session} supabase={supabase} params={params} />
      )}
    </>
  );
}

async function Prompts({
  session,
  supabase,
  params,
}: {
  session: Session;
  supabase: ServerClient;
  params: SearchParams;
}) {
  const admin = hasRole(session.role, "admin");
  const workspaceId = session.workspace.id;
  const requestedKind = first(params.kind);
  const kind = (
    (CONVERSATION_KINDS as readonly string[]).includes(requestedKind)
      ? requestedKind
      : "initial_question"
  ) as TemplateKind;
  const query = first(params.q).trim().toLowerCase();
  const collectionFilter = first(params.collection);
  const showArchived = first(params.show) === "archived";

  const [{ data: templates }, { data: usage }, { data: connections }, { data: verifiedModels }] =
    await Promise.all([
      supabase
        .from("templates")
        .select("id, kind, label, collection, source, archived_at, updated_at, current_version_id")
        .eq("workspace_id", workspaceId)
        .neq("kind", "fresh_check")
        .order("created_at"),
      supabase
        .from("campaign_revision_step_templates")
        .select("template_id")
        .eq("workspace_id", workspaceId),
      supabase
        .from("provider_connections")
        .select("id, name")
        .eq("workspace_id", workspaceId)
        .eq("status", "ok")
        .is("archived_at", null),
      supabase
        .from("provider_models")
        .select("connection_id, model_id")
        .eq("workspace_id", workspaceId)
        .eq("verification_status", "verified")
        .eq("is_listed", true),
    ]);
  const all = templates ?? [];
  const versionIds = all
    .map((template) => template.current_version_id)
    .filter((id): id is string => Boolean(id));
  const { data: versions } = versionIds.length
    ? await supabase.from("template_versions").select("id, body, version").in("id", versionIds)
    : { data: [] };
  const versionById = new Map((versions ?? []).map((version) => [version.id, version]));
  const used = new Set((usage ?? []).map((row) => row.template_id));

  const counts = Object.fromEntries(
    CONVERSATION_KINDS.map((item) => [
      item,
      all.filter((template) => template.kind === item && !template.archived_at).length,
    ]),
  );
  const ofKind = all.filter((template) => template.kind === kind);
  const collections = [
    ...new Set(
      all.map((template) => template.collection).filter((name): name is string => Boolean(name)),
    ),
  ].sort();
  const rows = ofKind
    .filter((template) => (showArchived ? template.archived_at : !template.archived_at))
    .filter((template) => !collectionFilter || template.collection === collectionFilter)
    .map((template) => ({
      template,
      version: template.current_version_id
        ? versionById.get(template.current_version_id)
        : undefined,
    }))
    .filter(
      ({ template, version }) =>
        !query ||
        (version?.body ?? "").toLowerCase().includes(query) ||
        (template.label ?? "").toLowerCase().includes(query),
    );
  const archivedCount = ofKind.filter((template) => template.archived_at).length;
  const activeBodies = ofKind
    .filter((template) => !template.archived_at)
    .map((template) =>
      template.current_version_id ? versionById.get(template.current_version_id)?.body : undefined,
    )
    .filter((body): body is string => Boolean(body));

  const connectionName = new Map(
    (connections ?? []).map((connection) => [connection.id, connection.name]),
  );
  const generatorModels: GeneratorModel[] = (verifiedModels ?? [])
    .filter((model) => connectionName.has(model.connection_id))
    .map((model) => ({
      connectionId: model.connection_id,
      connectionName: connectionName.get(model.connection_id)!,
      model: model.model_id,
    }));
  const info = templateKind(kind);

  return (
    <div className="flex flex-col gap-5">
      <nav aria-label="Prompt type" className="flex flex-wrap gap-2">
        {CONVERSATION_KINDS.map((item) => (
          <Link
            key={item}
            href={buildHref("/library", { kind: item })}
            aria-current={item === kind ? "page" : undefined}
            className={cn(
              "rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors",
              item === kind
                ? "border-brand bg-brand-faint text-brand-strong"
                : "border-line-strong bg-surface text-ink-muted hover:text-ink",
            )}
          >
            {templateKind(item).plural}{" "}
            <span className="tabular text-xs opacity-80">{formatNumber(counts[item] ?? 0)}</span>
          </Link>
        ))}
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-ink-muted max-w-2xl text-[13px]">
          {info.help}{" "}
          {kind === "extra_step"
            ? "Add these to a campaign as steps after the revised-list request."
            : "A campaign picks one wording per step for each conversation, so more wordings mean more combinations."}
        </p>
        <div className="flex flex-wrap gap-2">
          {ofKind.length > 0 ? <ExportPromptsLink kind={kind} /> : null}
          {admin ? (
            <>
              <GenerateButton
                workspaceId={workspaceId}
                kind={kind}
                models={generatorModels}
                examples={activeBodies}
                collections={collections}
              />
              <ImportCsvButton workspaceId={workspaceId} kind={kind} collections={collections} />
              <AddPromptButton workspaceId={workspaceId} kind={kind} collections={collections} />
            </>
          ) : null}
        </div>
      </div>

      {ofKind.length > 0 ? (
        <form
          method="get"
          action="/library"
          className="flex flex-wrap items-end gap-3"
          role="search"
        >
          <input type="hidden" name="kind" value={kind} />
          <div className="flex min-w-48 flex-1 flex-col gap-1.5 sm:max-w-xs">
            <label htmlFor="library-search" className="text-ink-muted text-xs font-medium">
              Search
            </label>
            <Input id="library-search" name="q" type="search" defaultValue={first(params.q)} />
          </div>
          {collections.length > 0 ? (
            <div className="flex w-48 flex-col gap-1.5">
              <label htmlFor="library-collection" className="text-ink-muted text-xs font-medium">
                Collection
              </label>
              <Select id="library-collection" name="collection" defaultValue={collectionFilter}>
                <option value="">All collections</option>
                {collections.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          <div className="flex w-40 flex-col gap-1.5">
            <label htmlFor="library-show" className="text-ink-muted text-xs font-medium">
              Show
            </label>
            <Select id="library-show" name="show" defaultValue={showArchived ? "archived" : ""}>
              <option value="">Active</option>
              <option value="archived">Archived ({archivedCount})</option>
            </Select>
          </div>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
        </form>
      ) : null}

      {ofKind.length === 0 ? (
        <EmptyState
          icon={<BookOpenText className="size-5" aria-hidden="true" />}
          title={`No ${info.plural.toLowerCase()} yet`}
          description={
            admin
              ? "Write them here, import a CSV, or generate variations for review. Use variables such as {{category}} so the same wording works for any campaign."
              : "An admin can add prompts to the library."
          }
          action={
            admin ? (
              <AddPromptButton workspaceId={workspaceId} kind={kind} collections={collections} />
            ) : null
          }
        />
      ) : rows.length === 0 ? (
        <p className="border-line-strong bg-surface text-ink-muted rounded-2xl border border-dashed px-4 py-10 text-center text-[13px]">
          No prompts match these filters.{" "}
          <Link
            href={buildHref("/library", { kind })}
            className="text-brand hover:text-brand-strong font-medium"
          >
            Clear filters
          </Link>
        </p>
      ) : (
        <TableWrap label={info.plural}>
          <Table className="min-w-[44rem]">
            <thead>
              <tr>
                <Th className="w-full">Prompt</Th>
                <Th>Collection</Th>
                <Th>Source</Th>
                <Th>Updated</Th>
                {admin ? <Th className="text-right">Actions</Th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ template, version }) => (
                <Tr key={template.id}>
                  <Td className="max-w-xl whitespace-normal">
                    <PromptText body={version?.body ?? ""} />
                    <div className="text-ink-muted mt-1 flex flex-wrap items-center gap-2 text-xs">
                      {template.label ? (
                        <span className="text-ink font-medium">{template.label}</span>
                      ) : null}
                      <span>Version {version?.version ?? 1}</span>
                      {used.has(template.id) ? (
                        <Badge tone="brand">Used by a campaign</Badge>
                      ) : null}
                    </div>
                  </Td>
                  <Td>{template.collection ?? <span className="text-ink-muted">—</span>}</Td>
                  <Td>{SOURCE_LABEL[template.source] ?? template.source}</Td>
                  <Td>
                    <LocalTime value={template.updated_at} dateOnly />
                  </Td>
                  {admin ? (
                    <Td className="text-right">
                      <PromptRowActions
                        collections={collections}
                        prompt={{
                          id: template.id,
                          kind: template.kind as TemplateKind,
                          body: version?.body ?? "",
                          label: template.label,
                          collection: template.collection,
                          archived: Boolean(template.archived_at),
                          inUse: used.has(template.id),
                        }}
                      />
                    </Td>
                  ) : null}
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
      {!admin ? (
        <PermissionNote>Only admins and owners can add or change prompts.</PermissionNote>
      ) : null}
      <p className="text-ink-muted text-xs">
        Showing {formatNumber(rows.length)} of{" "}
        {formatNumber(
          ofKind.filter((template) => (showArchived ? template.archived_at : !template.archived_at))
            .length,
        )}
        .
      </p>
    </div>
  );
}

async function QuestionSets({
  session,
  supabase,
  params,
}: {
  session: Session;
  supabase: ServerClient;
  params: SearchParams;
}) {
  const admin = hasRole(session.role, "admin");
  const workspaceId = session.workspace.id;
  const showArchived = first(params.show) === "archived";
  const { data: sets } = await supabase
    .from("probe_sets")
    .select("id, name, description, current_version_id, archived_at, updated_at")
    .eq("workspace_id", workspaceId)
    .order("created_at");
  const versionIds = (sets ?? [])
    .map((set) => set.current_version_id)
    .filter((id): id is string => Boolean(id));
  const [{ data: questions }, { data: versions }, { data: revisions }] = await Promise.all([
    versionIds.length
      ? supabase
          .from("probe_questions")
          .select("probe_set_version_id, position, body, is_held_out")
          .in("probe_set_version_id", versionIds)
          .order("position")
      : Promise.resolve({ data: [] as never[] }),
    versionIds.length
      ? supabase.from("probe_set_versions").select("id, version").in("id", versionIds)
      : Promise.resolve({ data: [] as never[] }),
    supabase
      .from("campaign_revisions")
      .select("probe_set_id")
      .eq("workspace_id", workspaceId)
      .not("probe_set_id", "is", null)
      .neq("state", "discarded"),
  ]);
  const versionNumber = new Map((versions ?? []).map((version) => [version.id, version.version]));
  const inUse = new Set((revisions ?? []).map((revision) => revision.probe_set_id));
  const visible = (sets ?? []).filter((set) => (showArchived ? set.archived_at : !set.archived_at));
  const archivedCount = (sets ?? []).filter((set) => set.archived_at).length;

  const newButton = (
    <QuestionSetButton
      workspaceId={workspaceId}
      trigger={
        <Button>
          <Plus className="size-4" aria-hidden="true" />
          New question set
        </Button>
      }
    />
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-ink-muted max-w-2xl text-[13px]">
          A fresh check asks one of these questions in a brand-new request: no earlier turns, no
          instructions, no campaign or business details. Campaigns sample the same set before,
          during and after their conversations so the answers can be compared.
        </p>
        {admin ? newButton : null}
      </div>
      <Callout tone="info" title="Questions are checked for leaks before launch">
        A campaign cannot launch if a question in its set contains the business name, an alias or
        the website, or if a held-out question repeats one of its initial questions.
      </Callout>

      {(sets ?? []).length === 0 ? (
        <EmptyState
          icon={<ScanSearch className="size-5" aria-hidden="true" />}
          title="No question sets yet"
          description={
            admin
              ? "Create a set of recommendation questions a real person might ask about the category."
              : "An admin can create fresh-check question sets."
          }
          action={admin ? newButton : null}
        />
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {visible.map((set) => {
            const own = (questions ?? []).filter(
              (question) => question.probe_set_version_id === set.current_version_id,
            );
            const heldOut = own.filter((question) => question.is_held_out).length;
            return (
              <li
                key={set.id}
                className="border-line bg-surface shadow-card flex flex-col rounded-2xl border p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-ink text-[15px] font-semibold">{set.name}</h2>
                    {set.description ? (
                      <p className="text-ink-muted mt-0.5 text-[13px]">{set.description}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {set.archived_at ? <Badge>Archived</Badge> : null}
                    {inUse.has(set.id) ? <Badge tone="brand">Used by a campaign</Badge> : null}
                  </div>
                </div>
                <p className="text-ink-muted mt-3 text-xs">
                  {formatNumber(own.length)} question{own.length === 1 ? "" : "s"} ·{" "}
                  {formatNumber(heldOut)} held out · version{" "}
                  {versionNumber.get(set.current_version_id ?? "") ?? 1} · updated{" "}
                  <LocalTime value={set.updated_at} dateOnly />
                </p>
                <ol className="mt-3 flex flex-1 flex-col gap-1.5 text-[13px]">
                  {own.slice(0, 5).map((question) => (
                    <li key={question.position} className="flex items-start gap-2">
                      <span className="tabular text-ink-muted w-4 shrink-0 text-right text-xs">
                        {question.position}
                      </span>
                      <span className="min-w-0 flex-1">
                        <PromptText body={question.body} />{" "}
                        {question.is_held_out ? <Badge tone="info">Held out</Badge> : null}
                      </span>
                    </li>
                  ))}
                  {own.length > 5 ? (
                    <li className="text-ink-muted pl-6 text-xs">and {own.length - 5} more</li>
                  ) : null}
                </ol>
                {admin ? (
                  <div className="border-line mt-4 flex flex-wrap gap-2 border-t pt-4">
                    <QuestionSetButton
                      workspaceId={workspaceId}
                      set={{
                        id: set.id,
                        name: set.name,
                        description: set.description ?? "",
                        questions: own.map((question) => ({
                          body: question.body,
                          is_held_out: question.is_held_out,
                        })),
                      }}
                      trigger={
                        <Button variant="secondary" size="sm">
                          Edit
                        </Button>
                      }
                    />
                    <ArchiveQuestionSetButton id={set.id} archived={Boolean(set.archived_at)} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {archivedCount > 0 || showArchived ? (
        <p className="text-ink-muted text-xs">
          <Link
            href={
              showArchived
                ? "/library?tab=question-sets"
                : "/library?tab=question-sets&show=archived"
            }
            className="text-brand hover:text-brand-strong font-medium"
          >
            {showArchived ? "Show active question sets" : `Show ${archivedCount} archived`}
          </Link>
        </p>
      ) : null}
      {!admin ? (
        <PermissionNote>Only admins and owners can add or change question sets.</PermissionNote>
      ) : null}
    </div>
  );
}
