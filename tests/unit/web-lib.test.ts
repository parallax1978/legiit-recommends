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
import { first, likePattern, pageNumber, uuidParam } from "@/lib/params";
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
