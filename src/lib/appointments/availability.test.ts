import { describe, it, expect } from "vitest";
import {
  localTimeToUtc,
  formatTimeInTimezone,
  getDayOfWeekForDate,
  getTodayDateString,
} from "./availability";
import { intervalsOverlap } from "./conflicts";

describe("Appointment Availability & Utilities", () => {
  it("converts local time to UTC correctly for Asia/Kolkata (UTC+5:30)", () => {
    // 2026-09-30 11:30 in Asia/Kolkata is 06:00 UTC
    const utcDate = localTimeToUtc("2026-09-30", "11:30", "Asia/Kolkata");
    expect(utcDate.toISOString()).toBe("2026-09-30T06:00:00.000Z");

    // Format back to timezone
    const formatted = formatTimeInTimezone(utcDate, "Asia/Kolkata");
    expect(formatted).toBe("11:30");
  });

  it("calculates day of week correctly", () => {
    // 2026-09-24 is Thursday (4)
    expect(getDayOfWeekForDate("2026-09-24")).toBe(4);
    // 2026-09-27 is Sunday (0)
    expect(getDayOfWeekForDate("2026-09-27")).toBe(0);
    // 2026-09-28 is Monday (1)
    expect(getDayOfWeekForDate("2026-09-28")).toBe(1);
  });

  it("detects interval overlaps accurately", () => {
    const t = (h: number, m: number) => new Date(2026, 8, 30, h, m).getTime();

    // [10:00, 10:45) vs [10:30, 11:15) -> Overlap!
    expect(intervalsOverlap(t(10, 0), t(10, 45), t(10, 30), t(11, 15))).toBe(true);

    // [10:00, 10:30) vs [10:30, 11:00) -> Adjacent, no overlap!
    expect(intervalsOverlap(t(10, 0), t(10, 30), t(10, 30), t(11, 0))).toBe(false);

    // [11:00, 11:45) vs [09:00, 09:30) -> No overlap
    expect(intervalsOverlap(t(11, 0), t(11, 45), t(9, 0), t(9, 30))).toBe(false);

    // [09:00, 12:00) contains [10:00, 11:00) -> Overlap!
    expect(intervalsOverlap(t(9, 0), t(12, 0), t(10, 0), t(11, 0))).toBe(true);
  });

  it("gets current date in timezone", () => {
    const today = getTodayDateString("Asia/Kolkata");
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
