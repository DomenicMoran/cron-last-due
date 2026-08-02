import { describe, expect, it } from "vitest";
import { cronMatches, hasMissedRun, lastDueBefore, parseCron } from "./index";

const BERLIN = "Europe/Berlin";
const UTC = "UTC";

describe("parseCron", () => {
  it("reads the five standard fields", () => {
    const c = parseCron("30 7 * * 1-5");
    expect(c).not.toBeNull();
    expect([...c!.minute]).toEqual([30]);
    expect([...c!.hour]).toEqual([7]);
    expect([...c!.dayOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect(c!.dayOfMonthRestricted).toBe(false);
    expect(c!.dayOfWeekRestricted).toBe(true);
  });

  it("drops the leading seconds field of the six-field form", () => {
    const five = parseCron("0 15 * * *");
    const six = parseCron("0 0 15 * * *");
    expect([...six!.hour]).toEqual([...five!.hour]);
    expect([...six!.minute]).toEqual([...five!.minute]);
  });

  it("treats 7 as Sunday", () => {
    expect([...parseCron("0 0 * * 7")!.dayOfWeek]).toEqual([0]);
  });

  it("expands step values", () => {
    expect([...parseCron("*/15 * * * *")!.minute]).toEqual([0, 15, 30, 45]);
    // "5/10" means: from 5, then every 10.
    expect([...parseCron("5/10 * * * *")!.minute]).toEqual([5, 15, 25, 35, 45, 55]);
  });

  it("returns null rather than silently matching nothing", () => {
    expect(parseCron("")).toBeNull();
    expect(parseCron("* * *")).toBeNull();
    expect(parseCron("60 * * * *")).toBeNull(); // there is no minute 60
    expect(parseCron("* 24 * * *")).toBeNull();
    expect(parseCron("abc * * * *")).toBeNull();
    expect(parseCron("*/0 * * * *")).toBeNull();
    expect(parseCron("10-5 * * * *")).toBeNull();
  });
});

describe("cronMatches", () => {
  it("evaluates the expression in the given zone", () => {
    const c = parseCron("0 7 * * *")!;
    // 05:00 UTC is 07:00 in Berlin during summer time.
    const summer = new Date("2026-07-01T05:00:00Z");
    expect(cronMatches(c, summer, BERLIN)).toBe(true);
    expect(cronMatches(c, summer, UTC)).toBe(false);
  });

  it("follows the daylight saving change", () => {
    const c = parseCron("0 7 * * *")!;
    // In winter, 07:00 Berlin is 06:00 UTC.
    const winter = new Date("2026-01-15T06:00:00Z");
    expect(cronMatches(c, winter, BERLIN)).toBe(true);
    expect(cronMatches(c, new Date("2026-01-15T05:00:00Z"), BERLIN)).toBe(false);
  });

  it("combines day-of-month and day-of-week with OR when both are set", () => {
    // The first of every month AND every Monday, not their intersection.
    const c = parseCron("0 0 1 * 1")!;
    const firstOfMonth = new Date("2026-07-01T00:00:00Z"); // 1 July 2026, a Wednesday
    const aMonday = new Date("2026-07-06T00:00:00Z");
    expect(cronMatches(c, firstOfMonth, UTC)).toBe(true);
    expect(cronMatches(c, aMonday, UTC)).toBe(true);
    expect(cronMatches(c, new Date("2026-07-07T00:00:00Z"), UTC)).toBe(false);
  });

  it("combines with AND when only one of the two fields is set", () => {
    const dayOnly = parseCron("0 0 15 * *")!;
    expect(cronMatches(dayOnly, new Date("2026-07-15T00:00:00Z"), UTC)).toBe(true);
    expect(cronMatches(dayOnly, new Date("2026-07-16T00:00:00Z"), UTC)).toBe(false);
  });
});

describe("lastDueBefore", () => {
  it("finds the most recent due time", () => {
    const now = new Date("2026-07-15T10:17:00Z"); // Wednesday
    const due = lastDueBefore("0 * * * *", now, UTC);
    expect(due?.toISOString()).toBe("2026-07-15T10:00:00.000Z");
  });

  it("stays strictly before the reference instant", () => {
    // Exactly on the hour, the currently starting run must not be reported as
    // its own due time, or it looks overdue.
    const now = new Date("2026-07-15T10:00:00Z");
    expect(lastDueBefore("0 * * * *", now, UTC)?.toISOString()).toBe(
      "2026-07-15T09:00:00.000Z",
    );
  });

  it("skips the weekend for a Monday-to-Friday expression", () => {
    // Sunday, 12 July 2026, 09:00 UTC. Last due time: Friday 07:00 Berlin,
    // which is 05:00 UTC in summer.
    const sunday = new Date("2026-07-12T09:00:00Z");
    const due = lastDueBefore("0 7 * * 1-5", sunday, BERLIN);
    expect(due?.toISOString()).toBe("2026-07-10T05:00:00.000Z");
  });

  it("returns null when nothing was due inside the window", () => {
    // Yearly on 1 January, window only seven days.
    expect(lastDueBefore("0 0 1 1 *", new Date("2026-07-15T00:00:00Z"), UTC)).toBeNull();
  });

  it("finds the same due time with a wider window", () => {
    const due = lastDueBefore("0 0 1 1 *", new Date("2026-07-15T00:00:00Z"), UTC, {
      lookbackMs: 400 * 24 * 3600_000,
    });
    expect(due?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("returns null for an invalid expression", () => {
    expect(lastDueBefore("broken", new Date(), UTC)).toBeNull();
  });
});

describe("hasMissedRun", () => {
  const now = new Date("2026-07-15T10:30:00Z"); // Wednesday

  it("reports a missed run", () => {
    const lastRun = new Date("2026-07-15T08:00:00Z");
    expect(hasMissedRun("0 * * * *", lastRun, now, UTC)).toBe(true);
  });

  it("reports nothing while the run is inside the tolerance", () => {
    // Due at 10:00, ran at 09:58. Two minutes early is within the margin.
    const lastRun = new Date("2026-07-15T09:58:00Z");
    expect(hasMissedRun("0 * * * *", lastRun, now, UTC)).toBe(false);
  });

  it("reports nothing at the weekend for a Monday-to-Friday expression", () => {
    // This is the false alarm this library exists for: Sunday, last run on
    // Friday, and a blanket 36-hour rule would have fired here.
    const sunday = new Date("2026-07-12T09:00:00Z");
    const friday = new Date("2026-07-10T05:00:00Z");
    expect(hasMissedRun("0 7 * * 1-5", friday, sunday, BERLIN)).toBe(false);
    expect(sunday.getTime() - friday.getTime()).toBeGreaterThan(36 * 3600_000);
  });

  it("counts a missing run as missed as soon as something was due", () => {
    expect(hasMissedRun("0 * * * *", null, now, UTC)).toBe(true);
  });

  it("reports nothing when nothing was due inside the window", () => {
    expect(hasMissedRun("0 0 1 1 *", null, now, UTC)).toBe(false);
  });

  it("accepts a tolerance of its own", () => {
    const lastRun = new Date("2026-07-15T09:50:00Z");
    expect(hasMissedRun("0 * * * *", lastRun, now, UTC, { toleranceMs: 60_000 })).toBe(true);
    expect(hasMissedRun("0 * * * *", lastRun, now, UTC, { toleranceMs: 20 * 60_000 })).toBe(false);
  });
});

describe("unreadable expression", () => {
  it("throws instead of reporting health", () => {
    // The dangerous case: a typo in the expression must not look like
    // "nothing missed". This line used to return false and the watchdog
    // stayed quiet permanently.
    expect(() =>
      hasMissedRun("*/5 * * *", null, new Date("2026-08-01T10:00:00Z"), "UTC"),
    ).toThrow(/cannot parse/);
  });

  it("leaves parseCron checking silently", () => {
    expect(parseCron("*/5 * * *")).toBeNull();
    expect(parseCron("*/5 * * * *")).not.toBeNull();
  });
});
