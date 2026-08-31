import { describe, expect, it } from "vitest";
import type { GitHubIssue } from "@agentflow/core";
import { cardFromIssue, isNoop, planIssueSync, type SyncableCard } from "./sync";

/**
 * Issue sync. Two properties matter more than any individual case: running it
 * twice must change nothing the second time, and it must never delete a card.
 */

function issue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 1,
    title: "Fix login redirect",
    body: "It redirects twice.",
    labels: ["bug"],
    author: "jigabarda",
    state: "open",
    url: "https://github.com/o/r/issues/1",
    ...overrides,
  };
}

function card(overrides: Partial<SyncableCard> = {}): SyncableCard {
  return {
    id: "task_1",
    title: "Fix login redirect",
    issueNumber: 1,
    columnKind: "ready",
    archivedAt: null,
    ...overrides,
  };
}

describe("importing", () => {
  it("creates a card for an open issue nobody has yet", () => {
    const plan = planIssueSync([issue()], []);
    expect(plan.create.map((item) => item.number)).toEqual([1]);
  });

  it("does not import a closed issue nobody ever had a card for", () => {
    // That is history, not new work.
    expect(planIssueSync([issue({ state: "closed" })], []).create).toEqual([]);
  });

  it("does not import the same issue twice", () => {
    const plan = planIssueSync([issue()], [card()]);
    expect(plan.create).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it("maps an issue onto a card", () => {
    expect(cardFromIssue(issue())).toEqual({
      title: "Fix login redirect",
      body: "It redirects twice.",
      labels: ["bug"],
      issueNumber: 1,
    });
  });

  it("gives a titleless issue something readable", () => {
    expect(cardFromIssue(issue({ title: "" })).title).toBe("Issue #1");
  });
});

describe("running it twice", () => {
  it("changes nothing the second time", () => {
    const issues = [issue({ number: 1 }), issue({ number: 2, title: "Another" })];

    const first = planIssueSync(issues, []);
    expect(first.create).toHaveLength(2);

    // Apply the first plan, then re-plan against the result.
    const cards = first.create.map((imported, index) =>
      card({ id: `task_${index}`, title: imported.title, issueNumber: imported.number }),
    );
    const second = planIssueSync(issues, cards);

    expect(isNoop(second)).toBe(true);
    expect(second.unchanged).toBe(2);
  });

  it("is a no-op over an empty board and no issues", () => {
    expect(isNoop(planIssueSync([], []))).toBe(true);
  });
});

describe("never destructive", () => {
  it("archives a card whose issue was closed, rather than deleting it", () => {
    const plan = planIssueSync([issue({ state: "closed" })], [card()]);

    expect(plan.archive).toEqual([{ taskId: "task_1", issueNumber: 1 }]);
    // There is no "delete" in the plan at all — by construction.
    expect(Object.keys(plan)).not.toContain("delete");
  });

  it("leaves an already-archived card alone", () => {
    const plan = planIssueSync(
      [issue({ state: "closed" })],
      [card({ archivedAt: new Date("2026-01-01") })],
    );

    expect(plan.archive).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it("does not re-import an issue whose card was archived", () => {
    // Otherwise archiving a card would just make it come back.
    const plan = planIssueSync([issue()], [card({ archivedAt: new Date("2026-01-01") })]);
    expect(plan.create).toEqual([]);
  });

  it("leaves a card whose issue has vanished from the filter untouched", () => {
    const plan = planIssueSync([], [card()]);
    expect(isNoop(plan)).toBe(true);
  });

  it("keeps a card that has no issue at all out of it entirely", () => {
    const plan = planIssueSync([issue()], [card({ id: "local", issueNumber: null })]);
    expect(plan.create.map((item) => item.number)).toEqual([1]);
    expect(plan.archive).toEqual([]);
    expect(plan.close).toEqual([]);
  });
});

describe("mirroring back to GitHub", () => {
  it("closes the issue when its card reaches a done column", () => {
    const plan = planIssueSync([issue()], [card({ columnKind: "done" })]);
    expect(plan.close).toEqual([{ taskId: "task_1", issueNumber: 1 }]);
  });

  it("does not close an issue that is already closed", () => {
    const plan = planIssueSync([issue({ state: "closed" })], [card({ columnKind: "done" })]);
    expect(plan.close).toEqual([]);
  });

  it("does not close anything when that mirror is turned off", () => {
    const plan = planIssueSync([issue()], [card({ columnKind: "done" })], { closeOnDone: false });
    expect(plan.close).toEqual([]);
  });

  it("does not archive when that mirror is turned off", () => {
    const plan = planIssueSync([issue({ state: "closed" })], [card()], {
      archiveOnClosed: false,
    });
    expect(plan.archive).toEqual([]);
  });
});

describe("updates", () => {
  it("notices a renamed issue", () => {
    const plan = planIssueSync([issue({ title: "Renamed upstream" })], [card()]);

    expect(plan.update).toEqual([
      { taskId: "task_1", issue: issue({ title: "Renamed upstream" }), changes: ["title"] },
    ]);
  });

  it("settles after the rename is applied", () => {
    const renamed = issue({ title: "Renamed upstream" });
    const plan = planIssueSync([renamed], [card({ title: "Renamed upstream" })]);
    expect(isNoop(plan)).toBe(true);
  });

  it("ignores a body change — the card's brief is the user's to edit", () => {
    const plan = planIssueSync([issue({ body: "Rewritten on GitHub" })], [card()]);
    expect(isNoop(plan)).toBe(true);
  });
});

describe("duplicates", () => {
  it("treats only the first card claiming an issue as its card", () => {
    const plan = planIssueSync([issue()], [card({ id: "first" }), card({ id: "second" })]);

    expect(plan.create).toEqual([]);
    // The duplicate is left exactly as it is; nothing is removed.
    expect(plan.archive).toEqual([]);
  });
});
