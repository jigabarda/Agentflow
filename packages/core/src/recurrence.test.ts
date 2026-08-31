import { describe, expect, it } from "vitest";
import {
  CronError,
  describeCron,
  dueSlots,
  isValidCron,
  nextFireTimes,
  parseCron,
  RECURRENCE_PRESETS,
} from "./recurrence";

/**
 * Recurrence. Every test pins the clock — nothing here reads the wall time.
 */

const utc = (iso: string) => new Date(`${iso}Z`);

describe("parseCron", () => {
  it("reads the five fields", () => {
    const fields = parseCron("0 9 * * 1-5");
    expect([...fields.minutes]).toEqual([0]);
    expect([...fields.hours]).toEqual([9]);
    expect([...fields.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it("understands lists, ranges and steps", () => {
    expect([...parseCron("0,30 * * * *").minutes]).toEqual([0, 30]);
    expect([...parseCron("*/15 * * * *").minutes]).toEqual([0, 15, 30, 45]);
    expect([...parseCron("0 9-11 * * *").hours]).toEqual([9, 10, 11]);
  });

  it("understands named months and days", () => {
    expect([...parseCron("0 9 * jan *").months]).toEqual([1]);
    expect([...parseCron("0 9 * * mon-fri").daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it("treats 7 as Sunday, as cron everywhere does", () => {
    expect([...parseCron("0 9 * * 7").daysOfWeek]).toEqual([0]);
  });

  it("says what is wrong with a bad expression", () => {
    expect(() => parseCron("0 9 * *")).toThrow(/five fields/);
    expect(() => parseCron("0 99 * * *")).toThrow(/out of range/);
    expect(() => parseCron("nonsense * * * *")).toThrow(CronError);
  });

  it("validates without throwing, for form input", () => {
    expect(isValidCron("0 9 * * 1-5")).toBe(true);
    expect(isValidCron("every morning")).toBe(false);
  });

  it("accepts every preset it offers", () => {
    for (const preset of RECURRENCE_PRESETS) {
      expect(isValidCron(preset.cron)).toBe(true);
    }
  });
});

describe("dueSlots", () => {
  it("finds the one slot in an ordinary window", () => {
    const slots = dueSlots(
      "0 9 * * *",
      "UTC",
      utc("2026-03-10T08:30:00"),
      utc("2026-03-10T09:30:00"),
    );
    expect(slots.map((slot) => slot.toISOString())).toEqual(["2026-03-10T09:00:00.000Z"]);
  });

  it("excludes the lower bound, so re-running a tick finds nothing new", () => {
    const slot = utc("2026-03-10T09:00:00");
    // First tick catches it…
    expect(dueSlots("0 9 * * *", "UTC", utc("2026-03-10T08:59:00"), slot)).toHaveLength(1);
    // …and a second tick over the same ground does not.
    expect(dueSlots("0 9 * * *", "UTC", slot, utc("2026-03-10T09:30:00"))).toHaveLength(0);
  });

  it("spawns exactly once when ticks are 30 seconds apart", () => {
    // The scheduler ticks at T and again at T+30s; both round to the same
    // minute, and the slot must not be produced twice.
    const first = dueSlots(
      "0 9 * * *",
      "UTC",
      utc("2026-03-10T08:59:30"),
      utc("2026-03-10T09:00:10"),
    );
    expect(first).toHaveLength(1);

    const second = dueSlots("0 9 * * *", "UTC", first[0]!, utc("2026-03-10T09:00:40"));
    expect(second).toHaveLength(0);
  });

  it("catches up after downtime with one slot per missed hour, not one per minute", () => {
    // Hourly job, worker down for three hours.
    const slots = dueSlots(
      "0 * * * *",
      "UTC",
      utc("2026-03-10T06:00:00"),
      utc("2026-03-10T09:00:00"),
    );
    expect(slots.map((slot) => slot.toISOString())).toEqual([
      "2026-03-10T07:00:00.000Z",
      "2026-03-10T08:00:00.000Z",
      "2026-03-10T09:00:00.000Z",
    ]);
  });

  it("returns the missed slots in order", () => {
    const slots = dueSlots(
      "0 * * * *",
      "UTC",
      utc("2026-03-10T06:00:00"),
      utc("2026-03-10T09:00:00"),
    );
    const times = slots.map((slot) => slot.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("does not spawn a month of cards after a month of downtime", () => {
    // The window is clamped to a week, so a daily job yields at most 7-ish.
    const slots = dueSlots(
      "0 9 * * *",
      "UTC",
      utc("2026-01-01T00:00:00"),
      utc("2026-03-10T09:00:00"),
    );
    expect(slots.length).toBeLessThanOrEqual(8);
  });

  it("finds nothing when the expression does not fire in the window", () => {
    expect(
      dueSlots("0 9 * * *", "UTC", utc("2026-03-10T10:00:00"), utc("2026-03-10T23:00:00")),
    ).toEqual([]);
  });

  it("skips the weekend for a weekday schedule", () => {
    // 2026-03-14 is a Saturday, 2026-03-15 a Sunday, 2026-03-16 a Monday.
    const slots = dueSlots(
      "0 9 * * 1-5",
      "UTC",
      utc("2026-03-13T10:00:00"),
      utc("2026-03-16T10:00:00"),
    );
    expect(slots.map((slot) => slot.toISOString())).toEqual(["2026-03-16T09:00:00.000Z"]);
  });
});

describe("timezones", () => {
  it("fires at the local hour, not the UTC one", () => {
    // 09:00 in Manila is 01:00 UTC.
    const slots = dueSlots(
      "0 9 * * *",
      "Asia/Manila",
      utc("2026-03-10T00:00:00"),
      utc("2026-03-10T05:00:00"),
    );
    expect(slots.map((slot) => slot.toISOString())).toEqual(["2026-03-10T01:00:00.000Z"]);
  });

  it("follows a spring-forward change without firing twice", () => {
    // US DST 2026 begins 08 March. 09:00 New York is 14:00 UTC before and
    // 13:00 UTC after, and each day must still produce exactly one slot.
    const before = dueSlots(
      "0 9 * * *",
      "America/New_York",
      utc("2026-03-07T00:00:00"),
      utc("2026-03-08T00:00:00"),
    );
    const after = dueSlots(
      "0 9 * * *",
      "America/New_York",
      utc("2026-03-09T00:00:00"),
      utc("2026-03-10T00:00:00"),
    );

    expect(before).toHaveLength(1);
    expect(before[0]!.toISOString()).toBe("2026-03-07T14:00:00.000Z");
    expect(after).toHaveLength(1);
    expect(after[0]!.toISOString()).toBe("2026-03-09T13:00:00.000Z");
  });

  it("fires exactly once on the day the clocks go forward", () => {
    const slots = dueSlots(
      "0 9 * * *",
      "America/New_York",
      utc("2026-03-08T00:00:00"),
      utc("2026-03-09T00:00:00"),
    );
    expect(slots).toHaveLength(1);
  });

  it("fires exactly once on the day the clocks go back", () => {
    // US DST 2026 ends 01 November; 01:00 local happens twice that day.
    const slots = dueSlots(
      "0 9 * * *",
      "America/New_York",
      utc("2026-11-01T00:00:00"),
      utc("2026-11-02T00:00:00"),
    );
    expect(slots).toHaveLength(1);
  });

  it("never fires for a wall-clock time that does not exist", () => {
    // 02:30 New York does not happen on 08 March 2026 — the clock jumps 2→3.
    const slots = dueSlots(
      "30 2 * * *",
      "America/New_York",
      utc("2026-03-08T00:00:00"),
      utc("2026-03-09T00:00:00"),
    );
    expect(slots).toHaveLength(0);
  });

  it("refuses a timezone it does not know", () => {
    expect(() =>
      dueSlots("0 9 * * *", "Mars/Olympus", utc("2026-03-10T00:00:00"), utc("2026-03-10T12:00:00")),
    ).toThrow(CronError);
  });
});

describe("nextFireTimes", () => {
  it("previews the next three", () => {
    const times = nextFireTimes("0 9 * * 1-5", "UTC", utc("2026-03-13T10:00:00"), 3);
    expect(times.map((time) => time.toISOString())).toEqual([
      "2026-03-16T09:00:00.000Z",
      "2026-03-17T09:00:00.000Z",
      "2026-03-18T09:00:00.000Z",
    ]);
  });

  it("handles a date that only comes round every four years", () => {
    const times = nextFireTimes("0 0 29 2 *", "UTC", utc("2026-03-01T00:00:00"), 1);
    expect(times[0]?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });
});

describe("describeCron", () => {
  it("describes the presets in words", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("Every weekday at 09:00");
    expect(describeCron("0 9 * * *")).toBe("Every day at 09:00");
    expect(describeCron("0 9 * * 1")).toBe("Every Monday at 09:00");
    expect(describeCron("0 9 1 * *")).toBe("On day 1 of every month at 09:00");
    expect(describeCron("0 * * * *")).toBe("Every hour");
  });

  it("describes a weekend schedule", () => {
    expect(describeCron("0 10 * * 0,6")).toBe("Every weekend day at 10:00");
  });

  it("returns the expression itself rather than describing it wrongly", () => {
    // Being vague is fine; being wrong about when work appears is not.
    expect(describeCron("*/7 3 5 6 2")).toBe("*/7 3 5 6 2");
  });

  it("passes an unparseable string straight back", () => {
    expect(describeCron("every morning")).toBe("every morning");
  });
});
