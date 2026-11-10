// The one Data API setting the web app depends on. Pure, so it is tested without a project.

/**
 * The web app reads long lists a page of this many rows at a time and takes a shorter page as
 * the last one (src/lib/batch.ts, src/lib/export.ts). That is right while the Data API returns
 * up to this many rows per request, which is its default "Max rows".
 */
export const REQUIRED_MAX_ROWS = 1000;

/**
 * Why a project's "Max rows" setting cannot be deployed to, or null when it is fine. With a
 * lower value every long list and every export would stop after its first page without any
 * error, so such a project is refused instead.
 */
export function maxRowsProblem(maxRows: unknown): string | null {
  if (typeof maxRows !== "number" || !Number.isFinite(maxRows)) {
    return (
      'The project\'s Data API settings did not include "Max rows", so it could not be checked. ' +
      `This app needs at least ${REQUIRED_MAX_ROWS} (Project Settings → Data API).`
    );
  }
  if (maxRows < REQUIRED_MAX_ROWS) {
    return (
      `The project's Data API returns at most ${maxRows} rows per request ("Max rows" under ` +
      `Project Settings → Data API). This app needs at least ${REQUIRED_MAX_ROWS}: with fewer, ` +
      "long lists and exports would stop after their first page without any error. Raise the " +
      "setting and run the command again."
    );
  }
  return null;
}
