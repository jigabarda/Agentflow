import { describe, expect, it } from "vitest";
import {
  branchNameFrom,
  formatRepo,
  GitHubMappingError,
  mapIssue,
  parseRepo,
  summarizeChecks,
  toPullRequestParams,
  type CheckRun,
} from "./mappers";

describe("parseRepo", () => {
  it("splits owner/name", () => {
    expect(parseRepo("jigabarda/Agentflow")).toEqual({ owner: "jigabarda", repo: "Agentflow" });
  });

  it("accepts the URLs people actually paste", () => {
    const expected = { owner: "jigabarda", repo: "Agentflow" };
    expect(parseRepo("https://github.com/jigabarda/Agentflow")).toEqual(expected);
    expect(parseRepo("https://github.com/jigabarda/Agentflow.git")).toEqual(expected);
    expect(parseRepo("github.com/jigabarda/Agentflow/")).toEqual(expected);
    expect(parseRepo("git@github.com:jigabarda/Agentflow.git")).toEqual(expected);
    expect(parseRepo("  jigabarda/Agentflow  ")).toEqual(expected);
  });

  it("rejects anything that is not one owner and one name", () => {
    for (const bad of ["", "   ", "Agentflow", "a/b/c", "owner/", "/name", "own er/name"]) {
      expect(() => parseRepo(bad)).toThrow(GitHubMappingError);
    }
  });

  it("names the offending input, so the user can see their typo", () => {
    expect(() => parseRepo("jigabarda")).toThrow(/"jigabarda" is not a repository/);
  });

  it("round-trips through formatRepo", () => {
    expect(formatRepo(parseRepo("owner/name"))).toBe("owner/name");
  });
});

describe("mapIssue", () => {
  it("maps a full issue", () => {
    expect(
      mapIssue({
        number: 204,
        title: "Fix login redirect",
        body: "Steps to reproduce",
        state: "open",
        html_url: "https://github.com/o/r/issues/204",
        user: { login: "jigabarda" },
        labels: [{ name: "bug" }, { name: "priority" }],
      }),
    ).toEqual({
      number: 204,
      title: "Fix login redirect",
      body: "Steps to reproduce",
      labels: ["bug", "priority"],
      author: "jigabarda",
      state: "open",
      url: "https://github.com/o/r/issues/204",
    });
  });

  it("turns every absent field into an empty value, never null", () => {
    // A template must never render the word "null" into a prompt.
    const issue = mapIssue({ number: 7 });
    expect(issue).toEqual({
      number: 7,
      title: "",
      body: "",
      labels: [],
      author: "",
      state: "open",
      url: "",
    });
  });

  it("handles a null body and a deleted author", () => {
    const issue = mapIssue({ number: 7, body: null, user: null, labels: null });
    expect(issue.body).toBe("");
    expect(issue.author).toBe("");
    expect(issue.labels).toEqual([]);
  });

  it("accepts labels as plain strings", () => {
    expect(mapIssue({ number: 1, labels: ["bug", "ui"] }).labels).toEqual(["bug", "ui"]);
  });

  it("drops nameless labels rather than emitting empty strings", () => {
    expect(mapIssue({ number: 1, labels: [{ name: null }, null, { name: "ok" }] }).labels).toEqual([
      "ok",
    ]);
  });

  it("preserves a unicode title", () => {
    const title = "Corrige el inicio de sesion — ñandú";
    expect(mapIssue({ number: 1, title }).title).toBe(title);
  });

  it("treats any non-closed state as open", () => {
    expect(mapIssue({ number: 1, state: "closed" }).state).toBe("closed");
    expect(mapIssue({ number: 1, state: "weird" }).state).toBe("open");
  });

  it("refuses an issue with no number", () => {
    expect(() => mapIssue({ title: "no number" })).toThrow(GitHubMappingError);
  });
});

describe("branchNameFrom", () => {
  it("slugifies a card title", () => {
    expect(branchNameFrom("Fix login redirect")).toBe("fix-login-redirect");
  });

  it("applies a prefix", () => {
    expect(branchNameFrom("Fix login", { prefix: "task" })).toBe("task/fix-login");
  });

  it("normalises the characters git refuses", () => {
    // ~ ^ : ? * [ and .. are all illegal in a ref name.
    expect(branchNameFrom("fix: the ~thing~ [again]")).toBe("fix-the-thing-again");
    expect(branchNameFrom("a..b")).toBe("a-b");
    expect(branchNameFrom("back\\slash")).toBe("back-slash");
    expect(branchNameFrom("@{weird}")).toBe("weird");
  });

  it("never starts or ends with a separator", () => {
    expect(branchNameFrom("  --hello--  ")).toBe("hello");
    expect(branchNameFrom("...")).toBe("work");
  });

  it("falls back to 'work' when nothing survives", () => {
    expect(branchNameFrom("!!!")).toBe("work");
    expect(branchNameFrom("")).toBe("work");
  });

  it("truncates without leaving a trailing dash", () => {
    const name = branchNameFrom("a".repeat(40) + " " + "b".repeat(40), { max: 41 });
    expect(name).toHaveLength(40);
    expect(name.endsWith("-")).toBe(false);
  });

  it("avoids the .lock suffix git rejects", () => {
    expect(branchNameFrom("hotfix.lock")).toBe("hotfix-lock");
  });
});

describe("toPullRequestParams", () => {
  it("builds Octokit params", () => {
    expect(
      toPullRequestParams("o/r", { head: "task/1", base: "main", title: "Fix", body: "why" }),
    ).toEqual({ owner: "o", repo: "r", head: "task/1", base: "main", title: "Fix", body: "why" });
  });

  it("defaults a missing body to an empty string", () => {
    expect(toPullRequestParams("o/r", { head: "h", base: "main", title: "t" }).body).toBe("");
  });

  it("refuses a PR from a branch to itself", () => {
    expect(() => toPullRequestParams("o/r", { head: "main", base: "main", title: "t" })).toThrow(
      /two different branches/,
    );
  });

  it("requires head, base and title", () => {
    expect(() => toPullRequestParams("o/r", { head: "", base: "main", title: "t" })).toThrow(
      /head branch/,
    );
    expect(() => toPullRequestParams("o/r", { head: "h", base: " ", title: "t" })).toThrow(
      /base branch/,
    );
    expect(() => toPullRequestParams("o/r", { head: "h", base: "main", title: "  " })).toThrow(
      /title/,
    );
  });
});

describe("summarizeChecks", () => {
  const check = (
    name: string,
    status: CheckRun["status"],
    conclusion: string | null,
  ): CheckRun => ({
    name,
    status,
    conclusion,
  });

  it("reports no_checks when the repo has no CI at all", () => {
    // Never imply tests ran when nothing ran (docs/INTEGRATIONS.md).
    expect(summarizeChecks([])).toEqual({ state: "no_checks", checks: [], missing: [] });
  });

  it("is pending while anything is still running", () => {
    const result = summarizeChecks([
      check("test", "completed", "success"),
      check("lint", "in_progress", null),
    ]);
    expect(result.state).toBe("pending");
  });

  it("is success once everything has concluded well", () => {
    expect(summarizeChecks([check("test", "completed", "success")]).state).toBe("success");
  });

  it("counts neutral and skipped as passing", () => {
    expect(
      summarizeChecks([check("a", "completed", "neutral"), check("b", "completed", "skipped")])
        .state,
    ).toBe("success");
  });

  it("fails fast on one failure even while others run", () => {
    expect(
      summarizeChecks([check("test", "completed", "failure"), check("lint", "queued", null)]).state,
    ).toBe("failure");
  });

  it("treats cancelled and timed_out as failures", () => {
    expect(summarizeChecks([check("a", "completed", "cancelled")]).state).toBe("failure");
    expect(summarizeChecks([check("a", "completed", "timed_out")]).state).toBe("failure");
  });

  it("only considers the required checks when they are named", () => {
    const checks = [check("test", "completed", "success"), check("flaky", "completed", "failure")];
    expect(summarizeChecks(checks, ["test"]).state).toBe("success");
    expect(summarizeChecks(checks, ["test"]).checks).toHaveLength(1);
  });

  it("stays pending when a required check has not appeared yet", () => {
    // "Not started" must never read as "passed".
    const result = summarizeChecks([check("test", "completed", "success")], ["test", "e2e"]);
    expect(result.state).toBe("pending");
    expect(result.missing).toEqual(["e2e"]);
  });

  it("stays pending, not no_checks, when required checks are named but nothing has run", () => {
    expect(summarizeChecks([], ["test"]).state).toBe("pending");
  });

  it("ignores blank entries in requiredChecks", () => {
    expect(summarizeChecks([check("test", "completed", "success")], ["", "  "]).state).toBe(
      "success",
    );
  });
});
