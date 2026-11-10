import { describe, expect, it, vi } from "vitest";
import {
  NO_VALUE,
  describeWeekdays,
  formatPercent,
  formatPointChange,
  formatShare,
  formatUsd,
  minutesToTime,
  rate,
  timeToMinutes,
} from "@/lib/format";
import {
  axisFractionDigits,
  axisWidth,
  formatAxisTick,
  formatChartValue,
} from "@/components/charts/theme";
import { ID_CHUNK, PAGE_SIZE, inChunks, rowsOf, selectAll } from "@/lib/batch";
import { first, likePattern, pageNumber, uuidParam } from "@/lib/params";
import { signInFailure } from "@/lib/sign-in-failure";
import { sessionCookieOptions } from "@/lib/supabase/env";
import { describeWakes } from "@/lib/wakes";
import { isValidTimeZone, offsetMinutes, utcToZonedInput, zonedInputToUtc } from "@/lib/timezone";

describe("campaign timezone conversion", () => {
  it("converts wall-clock time in the campaign timezone to UTC, in winter and summer", () => {
    expect(zonedInputToUtc("2026-11-12T09:30", "America/Chicago")?.toISOString()).toBe(
      "2026-11-12T15:30:00.000Z",
    );
    expect(zonedInputToUtc("2026-07-01T09:30", "America/Chicago")?.toISOString()).toBe(
      "2026-07-01T14:30:00.000Z",
    );
    expect(zonedInputToUtc("2026-06-15T18:00", "Asia/Kolkata")?.toISOString()).toBe(
      "2026-06-15T12:30:00.000Z",
    );
  });

  it("handles a local midnight that falls on the previous UTC day", () => {
    expect(zonedInputToUtc("2026-11-12T00:00", "Pacific/Auckland")?.toISOString()).toBe(
      "2026-11-11T11:00:00.000Z",
    );
    expect(utcToZonedInput("2026-11-11T11:00:00Z", "Pacific/Auckland")).toBe("2026-11-12T00:00");
  });

  it("round-trips ordinary times in zones with unusual offsets", () => {
    for (const zone of [
      "UTC",
      "America/Chicago",
      "Europe/London",
      "Asia/Kolkata",
      "Asia/Kathmandu",
      "Australia/Lord_Howe",
      "Pacific/Auckland",
      "America/St_Johns",
    ]) {
      for (const local of [
        "2026-01-15T00:00",
        "2026-04-30T12:45",
        "2026-08-01T23:59",
        "2026-12-31T06:05",
      ]) {
        const instant = zonedInputToUtc(local, zone);
        expect(instant, `${local} ${zone}`).not.toBeNull();
        expect(utcToZonedInput(instant!, zone), `${local} ${zone}`).toBe(local);
      }
    }
  });

  it("maps a time skipped by daylight saving to a real instant instead of failing", () => {
    // 02:30 on 8 March 2026 does not exist in Chicago: clocks jump from 02:00 to 03:00.
    const instant = zonedInputToUtc("2026-03-08T02:30", "America/Chicago");
    expect(instant).not.toBeNull();
    expect(["2026-03-08T07:30:00.000Z", "2026-03-08T08:30:00.000Z"]).toContain(
      instant!.toISOString(),
    );
  });

  it("maps a time repeated by daylight saving to one of its two instants", () => {
    // 01:30 on 1 November 2026 happens twice in Chicago.
    const instant = zonedInputToUtc("2026-11-01T01:30", "America/Chicago");
    expect(["2026-11-01T06:30:00.000Z", "2026-11-01T07:30:00.000Z"]).toContain(
      instant!.toISOString(),
    );
    expect(utcToZonedInput(instant!, "America/Chicago")).toBe("2026-11-01T01:30");
  });

  it("reports offsets and rejects unknown zones or malformed input", () => {
    expect(offsetMinutes(new Date("2026-01-10T12:00:00Z"), "America/Chicago")).toBe(-360);
    expect(offsetMinutes(new Date("2026-07-10T12:00:00Z"), "America/Chicago")).toBe(-300);
    expect(offsetMinutes(new Date("2026-07-10T12:00:00Z"), "Asia/Kolkata")).toBe(330);
    expect(isValidTimeZone("America/Chicago")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(zonedInputToUtc("2026-11-12 09:30", "America/Chicago")).toBeNull();
    expect(zonedInputToUtc("2026-11-12T09:30", "Mars/Olympus_Mons")).toBeNull();
    expect(utcToZonedInput(null, "UTC")).toBe("");
    expect(utcToZonedInput("not a date", "UTC")).toBe("");
  });
});

describe("figures shown in reports", () => {
  it("never invents a rate when there is nothing valid to divide by", () => {
    expect(rate(0, 0)).toBeNull();
    expect(rate(3, 0)).toBeNull();
    expect(rate(null, null)).toBeNull();
    expect(rate(1, 4)).toBe(0.25);
    expect(formatPercent(null)).toBe(NO_VALUE);
    expect(formatShare(0, 0)).toBe("0 of 0");
    expect(formatShare(3, 12)).toBe("3 of 12 (25%)");
  });

  it("expresses change as percentage points and only when both rates exist", () => {
    expect(formatPointChange(0.5, 0.25)).toBe("+25.0 pp");
    expect(formatPointChange(0.1, 0.4)).toBe("−30.0 pp");
    expect(formatPointChange(0.3, 0.3)).toBe("±0.0 pp");
    expect(formatPointChange(null, 0.3)).toBe(NO_VALUE);
    expect(formatPointChange(0.3, null)).toBe(NO_VALUE);
  });

  it("shows money without hiding small amounts or faking missing ones", () => {
    expect(formatUsd(null)).toBe(NO_VALUE);
    expect(formatUsd("")).toBe(NO_VALUE);
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatUsd(0.0032)).toBe("$0.0032");
    expect(formatUsd("40")).toBe("$40.00");
    // One small request can cost a few thousandths of a cent: it is not shown as zero.
    expect(formatUsd(0.00001)).toBe("<$0.0001");
    expect(formatUsd(0.00001, { precise: true })).toBe("<$0.0001");
    expect(formatUsd(0.00005)).toBe("$0.0001");
    expect(formatUsd(0.0001)).toBe("$0.0001");
  });

  it("labels a money axis so that neighbouring gridlines never read the same", () => {
    // A day of verification on a small model: fractions of a cent.
    const tiny = [0, 0.00003, 0.00006, 0.00009, 0.00012].map((tick) =>
      formatAxisTick(tick, "usd", 0.00012),
    );
    expect(tiny).toEqual(["$0", "$0.00003", "$0.00006", "$0.00009", "$0.00012"]);
    expect(new Set(tiny).size).toBe(tiny.length);

    expect([0, 0.15, 0.3, 0.45, 0.6].map((tick) => formatAxisTick(tick, "usd", 0.6))).toEqual([
      "$0",
      "$0.15",
      "$0.30",
      "$0.45",
      "$0.60",
    ]);
    expect([0, 5, 10, 15, 20].map((tick) => formatAxisTick(tick, "usd", 20))).toEqual([
      "$0",
      "$5",
      "$10",
      "$15",
      "$20",
    ]);
    expect(formatAxisTick(25_000, "usd", 50_000)).toBe("$25K");
    expect(formatAxisTick(40, "number", 80)).toBe("40");
    expect(formatAxisTick(50, "percent", 100)).toBe("50%");
    expect(axisFractionDigits(0)).toBe(2);
    expect(axisFractionDigits(0.5)).toBe(2);
    expect(axisFractionDigits(0.00012)).toBe(5);
    // Longer labels get more room so they are not clipped.
    expect(axisWidth("usd", 0.00012)).toBeGreaterThan(axisWidth("usd", 20));
    expect(formatChartValue(0.00001, "usd")).toBe("<$0.0001");
    expect(formatChartValue(0.0032, "usd")).toBe("$0.0032");
  });

  it("says whether the queue consumer is really being reached, not just configured", () => {
    const base = {
      window_minutes: 15,
      requested: 0,
      accepted: 0,
      rejected: 0,
      failed: 0,
      unanswered: 0,
      last_accepted_at: null,
      last_problem: null,
    };
    expect(describeWakes(false, base)).toMatchObject({ ok: false, detail: "Not activated" });
    // Nothing queued lately: there is nothing to judge by, and no alarm.
    expect(describeWakes(true, base)).toMatchObject({ ok: true, problem: null });
    expect(describeWakes(true, undefined)).toMatchObject({ ok: true, problem: null });
    expect(
      describeWakes(true, {
        ...base,
        requested: 4,
        accepted: 4,
        last_accepted_at: "2026-11-10T17:05:04+00:00",
      }),
    ).toEqual({
      ok: true,
      detail: "Activated · 4 wake-ups accepted in the last 15 minutes",
      problem: null,
    });

    // The settings exist, but the worker rejects every call: this used to look healthy.
    const rejected = describeWakes(true, {
      ...base,
      requested: 6,
      rejected: 6,
      last_problem: { at: "2026-11-10T17:05:04+00:00", status_code: 401, error: null },
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.detail).toBe("6 of 6 wake-ups failed (HTTP 401)");
    expect(rejected.problem).toContain("does not match");

    expect(
      describeWakes(true, {
        ...base,
        requested: 2,
        failed: 1,
        unanswered: 1,
        last_problem: { at: "2026-11-10T17:05:04+00:00", status_code: null, error: "timed out" },
      }),
    ).toMatchObject({ ok: false, detail: "2 of 2 wake-ups failed (timed out)" });

    // A problem that has since cleared is not an alarm.
    expect(
      describeWakes(true, {
        ...base,
        requested: 5,
        accepted: 3,
        rejected: 2,
        last_accepted_at: "2026-11-10T17:06:00+00:00",
        last_problem: { at: "2026-11-10T17:05:04+00:00", status_code: 401, error: null },
      }),
    ).toMatchObject({ ok: true, problem: null });
    // ...but one that came after the last success is.
    expect(
      describeWakes(true, {
        ...base,
        requested: 5,
        accepted: 3,
        rejected: 2,
        last_accepted_at: "2026-11-10T17:04:00+00:00",
        last_problem: { at: "2026-11-10T17:05:04+00:00", status_code: 404, error: null },
      }),
    ).toMatchObject({ ok: false, detail: "2 of 5 wake-ups failed (HTTP 404)" });
  });

  it("formats active hours and weekdays", () => {
    expect(minutesToTime(0)).toBe("00:00");
    expect(minutesToTime(570)).toBe("09:30");
    expect(minutesToTime(1440)).toBe("24:00");
    expect(minutesToTime(null)).toBe("");
    expect(timeToMinutes("09:30")).toBe(570);
    expect(timeToMinutes("24:00")).toBe(1440);
    expect(timeToMinutes("25:00")).toBeNull();
    expect(timeToMinutes("soon")).toBeNull();
    expect(describeWeekdays([1, 2, 3, 4, 5])).toBe("Weekdays");
    expect(describeWeekdays([6, 7])).toBe("Weekends");
    expect(describeWeekdays([1, 2, 3, 4, 5, 6, 7])).toBe("Every day");
    expect(describeWeekdays([3, 1])).toBe("Mon, Wed");
    expect(describeWeekdays([])).toBe(NO_VALUE);
  });
});

describe("URL parameters", () => {
  it("accepts only well-formed ids and page numbers", () => {
    expect(uuidParam("99eee476-c819-4840-b3e2-efc4fbb9f444")).toBe(
      "99eee476-c819-4840-b3e2-efc4fbb9f444",
    );
    expect(uuidParam("99eee476-c819-4840-b3e2-efc4fbb9f444' or 1=1")).toBeNull();
    expect(uuidParam(undefined)).toBeNull();
    expect(uuidParam(["99eee476-c819-4840-b3e2-efc4fbb9f444", "x"])).toBe(
      "99eee476-c819-4840-b3e2-efc4fbb9f444",
    );
    expect(pageNumber("3")).toBe(3);
    expect(pageNumber("0")).toBe(1);
    expect(pageNumber("-2")).toBe(1);
    expect(pageNumber("abc")).toBe(1);
    expect(first(["a", "b"])).toBe("a");
    expect(first(undefined)).toBe("");
  });

  it("escapes search text used in a pattern match", () => {
    expect(likePattern("50%_off")).toBe("%50\\%\\_off%");
    expect(likePattern("a,b(c)")).toBe("%a b c %");
  });
});

describe("reading more rows than fit in one request", () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  it("asks for a long id list in chunks that fit a request URL", async () => {
    const ids = Array.from({ length: 530 }, (_, index) => uuid(index));
    const seen: string[][] = [];
    const rows = await inChunks(ids, async (chunk) => {
      seen.push(chunk);
      return chunk.map((id) => ({ id }));
    });
    // Every id exactly once, in order, never more than ID_CHUNK at a time.
    expect(rows.map((row) => row.id)).toEqual(ids);
    expect(seen.map((chunk) => chunk.length)).toEqual([100, 100, 100, 100, 100, 30]);
    expect(Math.max(...seen.map((chunk) => chunk.length))).toBeLessThanOrEqual(ID_CHUNK);
    // The filter of one chunk stays far below the roughly 8,000 characters gateways accept.
    expect(`id=in.(${seen[0]!.join(",")})`.length).toBeLessThan(4000);
  });

  it("asks for each id once and for nothing when there are no ids", async () => {
    let calls = 0;
    const rows = await inChunks([uuid(1), uuid(2), uuid(1), uuid(2)], async (chunk) => {
      calls += 1;
      return chunk;
    });
    expect(rows).toEqual([uuid(1), uuid(2)]);
    expect(calls).toBe(1);
    expect(await inChunks([], async () => [1])).toEqual([]);
  });

  it("fails as a whole when one chunk cannot be read, instead of returning part of the rows", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const ids = Array.from({ length: 250 }, (_, index) => uuid(index));
    await expect(
      inChunks(ids, (chunk) =>
        rowsOf(
          "Prompt wording",
          Promise.resolve(
            chunk.includes(uuid(120))
              ? { data: null, error: { message: "414 Request-URI Too Large" } }
              : { data: chunk.map((id) => ({ id })), error: null },
          ),
        ),
      ),
    ).rejects.toThrow("Prompt wording could not be loaded.");
    // The screen only says that something could not be loaded; the server log keeps the reason.
    expect(logged).toHaveBeenCalledWith(
      "read_failed",
      "Prompt wording",
      "",
      "414 Request-URI Too Large",
    );
    logged.mockRestore();
  });

  it("reads every page of a long list and stops at the first short page", async () => {
    const total = PAGE_SIZE * 2 + 17;
    const ranges: [number, number][] = [];
    const rows = await selectAll("Prompts", (from, to) => {
      ranges.push([from, to]);
      const data = Array.from(
        { length: Math.max(0, Math.min(to, total - 1) - from + 1) },
        (_, i) => ({
          n: from + i,
        }),
      );
      return Promise.resolve({ data, error: null });
    });
    expect(rows).toHaveLength(total);
    expect(rows[0]).toEqual({ n: 0 });
    expect(rows.at(-1)).toEqual({ n: total - 1 });
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("stops at its row limit and treats a failed page as an error, not as the end", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let pages = 0;
    const capped = await selectAll(
      "Prompts",
      (from, to) => {
        pages += 1;
        return Promise.resolve({
          data: Array.from({ length: to - from + 1 }, (_, i) => from + i),
          error: null,
        });
      },
      3000,
    );
    expect(capped).toHaveLength(3000);
    expect(pages).toBe(3);

    await expect(
      selectAll("Prompts", (from) =>
        Promise.resolve(
          from === 0
            ? { data: Array.from({ length: PAGE_SIZE }, (_, i) => i), error: null }
            : { data: null, error: { message: "timeout" } },
        ),
      ),
    ).rejects.toThrow("Prompts could not be loaded.");
    expect(logged).toHaveBeenCalledWith("read_failed", "Prompts", "", "timeout");
    logged.mockRestore();
    expect(await rowsOf("Prompts", Promise.resolve({ data: null, error: null }))).toEqual([]);
  });
});

describe("sign-in failures", () => {
  it("says the credentials do not match only when the Auth server rejected them", () => {
    for (const error of [
      { status: 400, code: "invalid_credentials" },
      { status: 400, code: "email_not_confirmed" },
      { status: 422, code: "validation_failed" },
    ]) {
      const failure = signInFailure(error);
      expect(failure.code).toBe("invalid_credentials");
      expect(failure.message).toBe("That email and password do not match an account.");
      // Nothing to investigate: this is the ordinary wrong-password case.
      expect(failure.log).toBeNull();
    }
  });

  it("does not blame the password when the service is rate limiting or unavailable", () => {
    const limited = signInFailure({ status: 429, code: "over_request_rate_limit" });
    expect(limited.code).toBe("rate_limited");
    expect(limited.message).toMatch(/Too many sign-in attempts/);
    expect(limited.log).toBe("sign_in_rate_limited over_request_rate_limit");

    for (const error of [
      { status: 503, code: "unexpected_failure" },
      { status: 500 },
      { status: 0, name: "AuthRetryableFetchError" },
      { name: "AuthRetryableFetchError" },
      {},
      // Refusals from in front of the Auth server (a gateway rejecting the app's own API key)
      // say nothing about the person's password.
      { status: 401, name: "AuthApiError" },
      { status: 403 },
      { status: 404 },
    ]) {
      const failure = signInFailure(error);
      expect(failure.code).toBe("unavailable");
      expect(failure.message).toBe("Sign-in is temporarily unavailable. Try again in a moment.");
      expect(failure.log).toMatch(/^sign_in_unavailable \d+/);
    }
    // None of the messages says anything about whether an account exists.
    const messages = [{ status: 400 }, { status: 429 }, { status: 503 }].map(
      (error) => signInFailure(error).message,
    );
    for (const message of messages)
      expect(message).not.toMatch(/no account|not registered|exists/i);
  });
});

describe("session cookie", () => {
  it("is Secure exactly when the page is served over HTTPS", () => {
    for (const https of ["https", "https:", "HTTPS", "https,http", " https , http"]) {
      expect(sessionCookieOptions(https)).toEqual({ secure: true });
    }
    // A production build opened over plain HTTP (local `next start`, the browser tests) must
    // still get a cookie the browser will keep.
    for (const plain of ["http", "http:", "http,https", "", null, undefined]) {
      expect(sessionCookieOptions(plain)).toEqual({ secure: false });
    }
  });
});
