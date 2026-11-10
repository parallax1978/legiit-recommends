import { describe, expect, it } from "vitest";
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
import { first, likePattern, pageNumber, uuidParam } from "@/lib/params";
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
