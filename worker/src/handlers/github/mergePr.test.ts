import { beforeEach, describe, expect, it } from "vitest";
import type { CheckRun, RunContext } from "@agentflow/core";
import { MockGit, MockGitHubClient } from "../../github/MockGitHubClient";
import type { NodeInfo } from "../types";
import type { GitHubHandlerDeps } from "./deps";
import { createMergePrHandler } from "./mergePr";

/**
 * The merge gate.
 *
 * This is the most outward thing AgentFlow does, so the tests are mostly about
 * what it REFUSES: a failing check, a check still running, and — the one people
 * get wrong — a repo with no checks at all.
 */

let client: MockGitHubClient;
let logs: { level: string; message: string }[];

const node: NodeInfo = { id: "merge", type: "merge-pr", label: "Merge" };

function deps(checks: CheckRun[][]): GitHubHandlerDeps {
  client = new MockGitHubClient({
    checks,
    refs: { "refs/pull/204/head": "headsha1" },
    merge: { merged: true, sha: "mergesha1" },
  });

  return {
    client,
    git: new MockGit(),
    identity: { name: "AgentFlow", email: "agentflow@localhost" },
    log: async (_runId, entry) => {
      logs.push({ level: entry.level, message: entry.message });
    },
  };
}

function context(): RunContext {
  return {
    pipeline: { vars: {} },
    trigger: {},
    nodes: {},
    runId: "run_1",
    pipelineId: "pipe_1",
    workspaceDir: "/ws",
  };
}

const green: CheckRun[] = [
  { name: "tests", status: "completed", conclusion: "success" },
  { name: "lint", status: "completed", conclusion: "success" },
];

beforeEach(() => {
  logs = [];
});

describe("merging with green checks", () => {
  it("merges and returns the sha", async () => {
    const output = await createMergePrHandler(deps([green])).run(
      context(),
      { repo: "o/r", prNumber: 204 },
      node,
    );

    expect(output).toEqual({ merged: true, mergeSha: "mergesha1" });
  });

  it("reads the checks on the PR's head commit, not its branch name", async () => {
    await createMergePrHandler(deps([green])).run(context(), { repo: "o/r", prNumber: 204 }, node);

    expect(client.firstCallTo("getRef").args[1]).toBe("refs/pull/204/head");
    expect(client.firstCallTo("listChecks").args[1]).toBe("headsha1");
  });

  it("squashes by default", async () => {
    await createMergePrHandler(deps([green])).run(context(), { repo: "o/r", prNumber: 204 }, node);
    expect(client.firstCallTo("mergePullRequest").args[2]).toBe("squash");
  });

  it("honours a chosen merge method", async () => {
    await createMergePrHandler(deps([green])).run(
      context(),
      { repo: "o/r", prNumber: 204, method: "rebase" },
      node,
    );
    expect(client.firstCallTo("mergePullRequest").args[2]).toBe("rebase");
  });

  it("accepts a PR number that arrived as an interpolated string", async () => {
    await createMergePrHandler(deps([green])).run(
      context(),
      { repo: "o/r", prNumber: "204" },
      node,
    );
    expect(client.firstCallTo("mergePullRequest").args[1]).toBe(204);
  });
});

describe("what it refuses", () => {
  it("refuses when a check failed, naming it", async () => {
    const handler = createMergePrHandler(
      deps([[{ name: "tests", status: "completed", conclusion: "failure" }]]),
    );

    await expect(handler.run(context(), { repo: "o/r", prNumber: 204 }, node)).rejects.toThrow(
      /tests did not pass.*Refusing to merge/s,
    );
    expect(client.callsTo("mergePullRequest")).toHaveLength(0);
  });

  it("refuses while a check is still running, and says what to do", async () => {
    const handler = createMergePrHandler(
      deps([
        [
          { name: "tests", status: "completed", conclusion: "success" },
          { name: "e2e", status: "in_progress", conclusion: null },
        ],
      ]),
    );

    await expect(handler.run(context(), { repo: "o/r", prNumber: 204 }, node)).rejects.toThrow(
      /still waiting on e2e.*wait-for-checks/s,
    );
    expect(client.callsTo("mergePullRequest")).toHaveLength(0);
  });

  it("refuses a repo that reports no checks at all", async () => {
    // The trap: no CI means nothing was verified, not that everything passed.
    const handler = createMergePrHandler(deps([[]]));

    await expect(handler.run(context(), { repo: "o/r", prNumber: 204 }, node)).rejects.toThrow(
      /reported no checks.*nothing has been verified/s,
    );
    expect(client.callsTo("mergePullRequest")).toHaveLength(0);
  });

  it("refuses while a named required check has not appeared", async () => {
    const handler = createMergePrHandler(
      deps([[{ name: "tests", status: "completed", conclusion: "success" }]]),
    );

    await expect(
      handler.run(
        context(),
        { repo: "o/r", prNumber: 204, requiredChecks: ["tests", "e2e"] },
        node,
      ),
    ).rejects.toThrow(/still waiting on e2e/);
  });

  it("says so when GitHub itself declines the merge", async () => {
    client = new MockGitHubClient({
      checks: [green],
      refs: { "refs/pull/204/head": "headsha1" },
      merge: { merged: false, sha: "" },
    });

    const handler = createMergePrHandler({
      client,
      git: new MockGit(),
      identity: { name: "A", email: "a@b.c" },
      log: async () => {},
    });

    await expect(handler.run(context(), { repo: "o/r", prNumber: 204 }, node)).rejects.toThrow(
      /GitHub declined to merge.*conflicts/s,
    );
  });

  it("refuses a PR number that is not a number", async () => {
    const handler = createMergePrHandler(deps([green]));
    await expect(
      handler.run(context(), { repo: "o/r", prNumber: "not a number" }, node),
    ).rejects.toThrow(/prNumber must be a positive whole number/);
  });
});

describe("merging a repo with no CI on purpose", () => {
  it("merges when explicitly allowed", async () => {
    const handler = createMergePrHandler(deps([[]]));

    const output = await handler.run(
      context(),
      { repo: "o/r", prNumber: 204, allowNoChecks: true },
      node,
    );

    expect(output.merged).toBe(true);
  });

  it("warns loudly that nothing was verified", async () => {
    const handler = createMergePrHandler(deps([[]]));
    await handler.run(context(), { repo: "o/r", prNumber: 204, allowNoChecks: true }, node);

    const warning = logs.find((entry) => entry.level === "warn");
    expect(warning?.message).toMatch(/no checks at all — nothing was verified/);
  });

  it("only counts the checks that were named as required", async () => {
    const handler = createMergePrHandler(
      deps([
        [
          { name: "tests", status: "completed", conclusion: "success" },
          { name: "flaky", status: "completed", conclusion: "failure" },
        ],
      ]),
    );

    const output = await handler.run(
      context(),
      { repo: "o/r", prNumber: 204, requiredChecks: ["tests"] },
      node,
    );

    expect(output.merged).toBe(true);
  });
});
