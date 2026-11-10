import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/safe-path";
import { isOpsResult, runOpsAction, type OpsContext } from "@shared/ops/handlers";

describe("post-login destination", () => {
  it("keeps ordinary same-site paths, with their query and fragment", () => {
    expect(safeNextPath("/campaigns", "/overview")).toBe("/campaigns");
    expect(safeNextPath("/campaigns/abc?tab=results#chart", "/overview")).toBe(
      "/campaigns/abc?tab=results#chart",
    );
    expect(safeNextPath("/settings?tab=profile", "/overview")).toBe("/settings?tab=profile");
  });

  it("falls back for anything that could leave the site", () => {
    for (const hostile of [
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      "/ /evil.example",
      "https://evil.example/",
      "javascript:alert(1)",
      "evil.example",
      "",
      "/ /evil.example",
      "/path\\..\\..//evil.example",
      // Dot segments that the URL parser folds into a leading double slash.
      "/.//evil.example",
      "/..//evil.example",
      "/a/..//evil.example",
    ]) {
      expect(safeNextPath(hostile, "/overview"), JSON.stringify(hostile)).toBe("/overview");
    }
    expect(safeNextPath(null, "/overview")).toBe("/overview");
    expect(safeNextPath(undefined, "/reset-password")).toBe("/reset-password");
    expect(safeNextPath(42, "/overview")).toBe("/overview");
  });

  it("never returns something a browser would resolve to another origin", () => {
    for (const candidate of ["/a/../b", "/%2F%2Fevil.example", "/.//evil.example", "/x?y=//z"]) {
      const result = safeNextPath(candidate, "/overview");
      expect(new URL(result, "https://app.example").origin).toBe("https://app.example");
    }
  });
});

describe("ops action dispatch", () => {
  // The handlers are never reached in these cases, so the context is not used.
  const context = {} as OpsContext;

  it("treats names every object inherits as unknown actions", async () => {
    for (const name of [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "__proto__",
      "isPrototypeOf",
      "",
      "connection.test ",
    ]) {
      expect(await runOpsAction(context, name, {}), name).toEqual({
        ok: false,
        code: "unknown_action",
        message: "Unknown operation.",
      });
    }
  });

  it("recognises only well-formed results as safe to return", () => {
    expect(isOpsResult({ ok: true })).toBe(true);
    expect(isOpsResult({ ok: false, code: "x", message: "y" })).toBe(true);
    expect(isOpsResult(context)).toBe(false);
    expect(isOpsResult("[object Undefined]")).toBe(false);
    expect(isOpsResult(null)).toBe(false);
    expect(isOpsResult({ ok: "yes" })).toBe(false);
  });
});
