import { describe, expect, it } from "vitest";
import type { Task } from "@agentflow/core";
import {
  EMPTY_FILTERS,
  filtersFromQuery,
  filtersToQuery,
  isFiltering,
  matchesFilters,
} from "./filters";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    boardId: "b1",
    columnId: "c1",
    title: "Fix login redirect",
    body: "SSO sends users to /home instead of the deep link",
    order: 1000,
    priority: "normal",
    labels: ["bug", "auth"],
    blockedBy: [],
    repo: "acme/app",
    ...overrides,
  };
}

describe("matchesFilters", () => {
  it("matches everything when nothing is filtered", () => {
    expect(matchesFilters(task(), EMPTY_FILTERS)).toBe(true);
  });

  it("matches text against the title and the body", () => {
    expect(matchesFilters(task(), { ...EMPTY_FILTERS, text: "login" })).toBe(true);
    expect(matchesFilters(task(), { ...EMPTY_FILTERS, text: "deep link" })).toBe(true);
    expect(matchesFilters(task(), { ...EMPTY_FILTERS, text: "database" })).toBe(false);
  });

  it("ignores case and surrounding whitespace in the text filter", () => {
    expect(matchesFilters(task(), { ...EMPTY_FILTERS, text: "  LOGIN " })).toBe(true);
  });

  it("requires EVERY selected label, so a second label narrows the view", () => {
    expect(matchesFilters(task(), { ...EMPTY_FILTERS, labels: ["bug"] })).toBe(true);
    expect(matchesFilters(task(), { ...EMPTY_FILTERS, labels: ["bug", "auth"] })).toBe(true);
    expect(matchesFilters(task(), { ...EMPTY_FILTERS, labels: ["bug", "perf"] })).toBe(false);
  });

  it("filters by priority and repo", () => {
    expect(matchesFilters(task(), { ...EMPTY_FILTERS, priorities: ["normal"] })).toBe(true);
    expect(matchesFilters(task(), { ...EMPTY_FILTERS, priorities: ["urgent"] })).toBe(false);
    expect(matchesFilters(task(), { ...EMPTY_FILTERS, repo: "acme/app" })).toBe(true);
    expect(matchesFilters(task(), { ...EMPTY_FILTERS, repo: "other/repo" })).toBe(false);
  });

  it("filters on run state the card row does not carry", () => {
    const filters = { ...EMPTY_FILTERS, waitingOnMe: true };
    expect(matchesFilters(task(), filters, { waitingOnMe: true })).toBe(true);
    expect(matchesFilters(task(), filters, {})).toBe(false);

    const failedOnly = { ...EMPTY_FILTERS, failed: true };
    expect(matchesFilters(task(), failedOnly, { failed: true })).toBe(true);
    expect(matchesFilters(task(), failedOnly, {})).toBe(false);
  });

  it("combines filters as AND", () => {
    const filters = {
      ...EMPTY_FILTERS,
      text: "login",
      labels: ["auth"],
      priorities: ["normal" as const],
    };
    expect(matchesFilters(task(), filters)).toBe(true);
    expect(matchesFilters(task({ priority: "high" }), filters)).toBe(false);
  });

  it("copes with a card that has no body", () => {
    expect(matchesFilters(task({ body: null }), { ...EMPTY_FILTERS, text: "login" })).toBe(true);
    expect(matchesFilters(task({ body: null }), { ...EMPTY_FILTERS, text: "sso" })).toBe(false);
  });
});

describe("isFiltering", () => {
  it("is false for empty filters and true for any active one", () => {
    expect(isFiltering(EMPTY_FILTERS)).toBe(false);
    expect(isFiltering({ ...EMPTY_FILTERS, text: "  " })).toBe(false);
    expect(isFiltering({ ...EMPTY_FILTERS, text: "x" })).toBe(true);
    expect(isFiltering({ ...EMPTY_FILTERS, labels: ["bug"] })).toBe(true);
    expect(isFiltering({ ...EMPTY_FILTERS, waitingOnMe: true })).toBe(true);
  });
});

describe("filters ↔ URL", () => {
  it("round-trips a full set of filters", () => {
    const filters = {
      text: "login",
      labels: ["bug", "auth"],
      priorities: ["high" as const, "urgent" as const],
      repo: "acme/app",
      waitingOnMe: true,
      failed: true,
    };
    expect(filtersFromQuery(filtersToQuery(filters))).toEqual(filters);
  });

  it("produces an empty query for empty filters", () => {
    expect(filtersToQuery(EMPTY_FILTERS)).toBe("");
    expect(filtersFromQuery("")).toEqual(EMPTY_FILTERS);
  });

  it("drops an unknown priority rather than filtering everything away", () => {
    expect(filtersFromQuery("priority=urgent,bogus").priorities).toEqual(["urgent"]);
  });

  it("survives a hand-edited query string", () => {
    expect(filtersFromQuery("label=,,bug,").labels).toEqual(["bug"]);
    expect(filtersFromQuery("waiting=yes").waitingOnMe).toBe(false);
  });
});

describe("filtersToQuery preserves unrelated params", () => {
  it("keeps a param it does not own, such as ?board=", () => {
    const query = filtersToQuery({ ...EMPTY_FILTERS, text: "login" }, "board=b1");
    const params = new URLSearchParams(query);
    expect(params.get("board")).toBe("b1");
    expect(params.get("q")).toBe("login");
  });

  it("clears its own stale params without touching the others", () => {
    const query = filtersToQuery(EMPTY_FILTERS, "board=b1&q=old&label=bug");
    const params = new URLSearchParams(query);
    expect(params.get("board")).toBe("b1");
    expect(params.get("q")).toBeNull();
    expect(params.get("label")).toBeNull();
  });
});
