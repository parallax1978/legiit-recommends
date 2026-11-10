import { inChunks, rowsOf } from "@/lib/batch";
import {
  EXPORT_ROW_LIMIT,
  csvResponse,
  exportContext,
  fetchAll,
  notFoundResponse,
} from "@/lib/export";
import { toCsv } from "@shared/core/csv.ts";
import { TEMPLATE_KINDS } from "@shared/core/templates.ts";

/** The prompts of one type in the current workspace as CSV, in the same shape the importer reads. */
export async function GET(request: Request) {
  const ctx = await exportContext();
  if (ctx instanceof Response) return ctx;
  const kind = new URL(request.url).searchParams.get("kind") ?? "";
  if (!(TEMPLATE_KINDS as readonly string[]).includes(kind) || kind === "fresh_check")
    return notFoundResponse();

  const { rows: templates, truncated } = await fetchAll((from, to) =>
    ctx.supabase
      .from("templates")
      .select("id, label, collection, source, archived_at, current_version_id")
      .eq("workspace_id", ctx.session.workspace.id)
      .eq("kind", kind as "initial_question")
      .order("created_at")
      .order("id")
      .range(from, to),
  );
  const versionIds = templates
    .map((template) => template.current_version_id)
    .filter((id): id is string => Boolean(id));
  // In chunks that fit a request URL; a chunk that cannot be read fails the export instead of
  // leaving those prompts with an empty body.
  const versions = await inChunks(versionIds, (chunk) =>
    rowsOf(
      "The export",
      ctx.supabase.from("template_versions").select("id, body, version").in("id", chunk),
    ),
  );
  const bodies = new Map(
    versions.map((version) => [version.id, { body: version.body, version: version.version }]),
  );

  return csvResponse(
    // A file that stops at the row limit says so in its name.
    `prompts-${kind.replace(/_/g, "-")}${truncated ? `-first-${EXPORT_ROW_LIMIT}-rows` : ""}.csv`,
    toCsv(templates, [
      { header: "body", value: (row) => bodies.get(row.current_version_id ?? "")?.body ?? "" },
      { header: "label", value: (row) => row.label },
      { header: "collection", value: (row) => row.collection },
      {
        header: "version",
        value: (row) => bodies.get(row.current_version_id ?? "")?.version ?? null,
      },
      { header: "source", value: (row) => row.source },
      { header: "archived", value: (row) => Boolean(row.archived_at) },
    ]),
  );
}
