import { csvResponse, exportContext, fetchAll, notFoundResponse } from "@/lib/export";
import { toCsv } from "@shared/core/csv.ts";
import { TEMPLATE_KINDS } from "@shared/core/templates.ts";

/** The prompts of one type in the current workspace as CSV, in the same shape the importer reads. */
export async function GET(request: Request) {
  const ctx = await exportContext();
  if (ctx instanceof Response) return ctx;
  const kind = new URL(request.url).searchParams.get("kind") ?? "";
  if (!(TEMPLATE_KINDS as readonly string[]).includes(kind) || kind === "fresh_check")
    return notFoundResponse();

  const { rows: templates } = await fetchAll((from, to) =>
    ctx.supabase
      .from("templates")
      .select("id, label, collection, source, archived_at, current_version_id")
      .eq("workspace_id", ctx.session.workspace.id)
      .eq("kind", kind as "initial_question")
      .order("created_at")
      .range(from, to),
  );
  const versionIds = templates
    .map((template) => template.current_version_id)
    .filter((id): id is string => Boolean(id));
  const bodies = new Map<string, { body: string; version: number }>();
  for (let index = 0; index < versionIds.length; index += 200) {
    const { data } = await ctx.supabase
      .from("template_versions")
      .select("id, body, version")
      .in("id", versionIds.slice(index, index + 200));
    for (const version of data ?? [])
      bodies.set(version.id, { body: version.body, version: version.version });
  }

  return csvResponse(
    `prompts-${kind.replace(/_/g, "-")}.csv`,
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
