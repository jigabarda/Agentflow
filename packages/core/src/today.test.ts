import { describe, expect, it } from "vitest";
import { belongsOnToday, todayBucket, TODAY_BUCKET_ORDER } from "./today";

/**
 * Local dates on purpose. "Today" is the viewer's calendar day, not UTC's, so
 * a test written in Z would pass or fail depending on where it ran.
 */
const now = new Date(2026, 2, 10, 14, 0, 0);
const laterToday = new Date(2026, 2, 10, 23, 0, 0);
const earlierToday = new Date(2026, 2, 10, 9, 0, 0);
const yesterday = new Date(2026, 2, 9, 9, 0, 0);
const lastYear = new Date(2025, 0, 1, 9, 0, 0);

describe("todayBucket", () => {
  it("puts a card awaiting your decision first", () => {
    expect(todayBucket({ columnKind: "waiting", runStatus: "awaiting_approval" }, now)).toBe(
      "waiting",
    );
  });

  it("counts a running or queued card as in flight", () => {
    expect(todayBucket({ columnKind: "working", runStatus: "running" }, now)).toBe("in-flight");
    expect(todayBucket({ columnKind: "working", runStatus: "queued" }, now)).toBe("in-flight");
  });

  it("puts a decision ahead of a due date", () => {
    const bucket = todayBucket(
      { columnKind: "waiting", runStatus: "awaiting_approval", dueAt: lastYear },
      now,
    );
    expect(bucket).toBe("waiting");
  });

  it("calls a card due later today 'due'", () => {
    expect(todayBucket({ columnKind: "ready", dueAt: laterToday }, now)).toBe("due");
  });

  it("still calls a card due earlier today 'due', not overdue", () => {
    // Nagging at 2pm about something due at 9am the same day is not useful.
    expect(todayBucket({ columnKind: "ready", dueAt: earlierToday }, now)).toBe("due");
  });

  it("calls yesterday overdue", () => {
    expect(todayBucket({ columnKind: "ready", dueAt: yesterday }, now)).toBe("overdue");
  });

  it("leaves a card with no date and no run as later", () => {
    expect(todayBucket({ columnKind: "ready" }, now)).toBe("later");
    expect(todayBucket({ columnKind: "ready", dueAt: null, runStatus: null }, now)).toBe("later");
  });

  it("does not treat a finished run as in flight", () => {
    expect(todayBucket({ columnKind: "waiting", runStatus: "succeeded" }, now)).toBe("later");
    expect(todayBucket({ columnKind: "ready", runStatus: "failed" }, now)).toBe("later");
  });
});

describe("belongsOnToday", () => {
  it("keeps anything actually happening", () => {
    expect(belongsOnToday("waiting", "waiting")).toBe(true);
    expect(belongsOnToday("in-flight", "working")).toBe(true);
    expect(belongsOnToday("overdue", "ready")).toBe(true);
    expect(belongsOnToday("due", "ready")).toBe(true);
  });

  it("drops idle cards and finished work", () => {
    expect(belongsOnToday("later", "ready")).toBe(false);
    expect(belongsOnToday("due", "done")).toBe(false);
  });
});

describe("the order of the screen", () => {
  it("puts what is blocked on you first and what you have not started last", () => {
    expect(TODAY_BUCKET_ORDER).toEqual(["waiting", "in-flight", "overdue", "due", "later"]);
  });
});
