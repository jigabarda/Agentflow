import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "@agentflow/core";
import { createWorkspace, type Workspace } from "../../workspace/index";
import { MockGit, MockGitHubClient } from "../../github/MockGitHubClient";
import { GitError } from "../../github/git";
import { NodeFailure, type NodeInfo } from "../types";
import type { GitHubHandlerDeps } from "./deps";
import {
  createCloneRepoHandler,
  createCommitChangesHandler,
  createCreateBranchHandler,
  createOpenPrHandler,
  createReadIssueHandler,
  createWaitForChecksHandler,
} from "./nodes";

/**
 * Every GitHub node, driven end-to-end against mocks.
 * No token, no network, no clone — but a real workspace on disk, so the
 * path-containment checks are exercised for real.
 */

let workspace: Workspace;
let logs: { level: string; message: string }[];

function deps(overrides: Partial<GitHubHandlerDeps> = {}): GitHubHandlerDeps {
  return {
    client: new MockGitHubClient(),
    git: new MockGit(),
    identity: { name: "AgentFlow", email: "agentflow@localhost" },
    log: async (_runId, entry) => {
      logs.push({ level: entry.level, message: entry.message });
    },
    ...overrides,
  };
}

function context(): RunContext {
  return {
    pipeline: { vars: {} },
    trigger: {},
    nodes: {},
    runId: "run_1",
    pipelineId: "pipe_1",
    workspaceDir: workspace.dir,
  };
}

const node: NodeInfo = { id: "gh", type: "github", label: "GitHub" };

beforeEach(() => {
  workspace = createWorkspace("github-tests");
  logs = [];
  return () => workspace.cleanup();
});

describe("read-issue", () => {
  const issue = {
    number: 204,
    title: "Fix login",
    body: "It redirects twice",
    labels: ["bug"],
    author: "jigabarda",
    state: "open" as const,
    url: "https://github.com/o/r/issues/204",
  };

  it("fetches the issue and returns it as context", async () => {
    const client = new MockGitHubClient({ issues: { "204": issue } });
    const handler = createReadIssueHandler(deps({ client }));

    const output = await handler.run(context(), { repo: "o/r", issueNumber: 204 }, node);

    expect(output.issue).toEqual(issue);
    expect(client.firstCallTo("getIssue").args).toEqual(["o/r", 204]);
  });

  it("accepts an issue number that arrived as an interpolated string", async () => {
    // `{{ trigger.task.issueNumber }}` renders to text, always.
    const client = new MockGitHubClient({ issues: { "204": issue } });
    const handler = createReadIssueHandler(deps({ client }));

    await handler.run(context(), { repo: "o/r", issueNumber: "204" }, node);

    expect(client.firstCallTo("getIssue").args[1]).toBe(204);
  });

  it("names the node when the issue number is unusable", async () => {
    const handler = createReadIssueHandler(deps());
    await expect(
      handler.run(context(), { repo: "o/r", issueNumber: "not a number" }, node),
    ).rejects.toThrow(/Node "gh": issueNumber must be a positive whole number/);
  });

  it("surfaces a GitHub error rather than swallowing it", async () => {
    const handler = createReadIssueHandler(deps({ client: new MockGitHubClient({ issues: {} }) }));
    await expect(handler.run(context(), { repo: "o/r", issueNumber: 9 }, node)).rejects.toThrow(
      /No scripted issue/,
    );
  });
});

describe("clone-repo", () => {
  it("clones into the workspace root, so the agent's directory IS the checkout", async () => {
    // The bug this pins: with the repo in a subdirectory, an agent told it
    // works in the workspace wrote its changes BESIDE the repo, and the commit
    // found nothing to commit. Found by the first live run.
    const git = new MockGit({ headSha: "abc1234def" });
    const handler = createCloneRepoHandler(deps({ git }));

    const output = await handler.run(context(), { repo: "o/r" }, node);

    expect(output.path).toBe(workspace.dir);
    expect(output.headSha).toBe("abc1234def");
    expect(git.firstCallTo("clone").args[0]).toEqual({ repo: "o/r", dir: workspace.dir });
  });

  it("clones into a named subdirectory when one is configured", async () => {
    const git = new MockGit();
    const handler = createCloneRepoHandler(deps({ git }));

    const output = await handler.run(context(), { repo: "o/r", dir: "second-repo" }, node);

    expect(output.path).toBe(path.resolve(workspace.dir, "second-repo"));
  });

  it("passes a configured ref through", async () => {
    const git = new MockGit();
    const handler = createCloneRepoHandler(deps({ git }));

    await handler.run(context(), { repo: "o/r", ref: "develop" }, node);

    expect(git.firstCallTo("clone").args[0]).toMatchObject({ ref: "develop" });
  });

  it("ignores a blank ref instead of cloning branch ''", async () => {
    const git = new MockGit();
    const handler = createCloneRepoHandler(deps({ git }));

    await handler.run(context(), { repo: "o/r", ref: "   " }, node);

    expect(git.firstCallTo("clone").args[0]).not.toHaveProperty("ref");
  });

  it("refuses a directory that would escape the workspace", async () => {
    const handler = createCloneRepoHandler(deps());
    await expect(
      handler.run(context(), { repo: "o/r", dir: "../../elsewhere" }, node),
    ).rejects.toThrow(NodeFailure);
  });

  it("rejects a malformed repo before touching git", async () => {
    const git = new MockGit();
    const handler = createCloneRepoHandler(deps({ git }));

    await expect(handler.run(context(), { repo: "not-a-repo" }, node)).rejects.toThrow(
      /is not a repository/,
    );
    expect(git.calls).toHaveLength(0);
  });
});

describe("create-branch", () => {
  it("creates the branch in the cloned working tree", async () => {
    const git = new MockGit();
    const handler = createCreateBranchHandler(deps({ git }));

    const output = await handler.run(
      context(),
      { repo: "o/r", branchName: "task/fix-login" },
      node,
    );

    expect(output).toEqual({ branch: "task/fix-login" });
    expect(git.firstCallTo("createBranch").args).toEqual([workspace.dir, "task/fix-login"]);
  });

  it("requires a branch name", async () => {
    const handler = createCreateBranchHandler(deps());
    await expect(handler.run(context(), { repo: "o/r", branchName: "" }, node)).rejects.toThrow(
      /branchName is required/,
    );
  });
});

describe("commit-changes", () => {
  it("commits, then pushes the branch", async () => {
    const git = new MockGit({ commitSha: "c0ffee1234" });
    const handler = createCommitChangesHandler(deps({ git }));

    const output = await handler.run(
      context(),
      { repo: "o/r", branch: "task/1", message: "Implement it" },
      node,
    );

    expect(output).toEqual({ commitSha: "c0ffee1234", pushed: true });

    expect(git.firstCallTo("commitAll").args).toEqual([
      workspace.dir,
      "Implement it",
      { name: "AgentFlow", email: "agentflow@localhost" },
    ]);
    expect(git.firstCallTo("push").args).toEqual([workspace.dir, "task/1"]);
  });

  it("fails rather than pushing an empty branch when the agent changed nothing", async () => {
    const git = new MockGit({ hasChanges: false });
    const handler = createCommitChangesHandler(deps({ git }));

    await expect(
      handler.run(context(), { repo: "o/r", branch: "task/1", message: "m" }, node),
    ).rejects.toThrow(/nothing to commit/);

    expect(git.callsTo("push")).toHaveLength(0);
  });

  it("does not push when the commit itself failed", async () => {
    const git = new MockGit({ failures: { commitAll: new GitError("commit failed") } });
    const handler = createCommitChangesHandler(deps({ git }));

    await expect(
      handler.run(context(), { repo: "o/r", branch: "task/1", message: "m" }, node),
    ).rejects.toThrow(/commit failed/);

    expect(git.callsTo("push")).toHaveLength(0);
  });
});

describe("open-pr", () => {
  it("opens the PR and returns its number and url", async () => {
    const client = new MockGitHubClient({
      pullRequest: { number: 204, url: "https://github.com/o/r/pull/204" },
    });
    const handler = createOpenPrHandler(deps({ client }));

    const output = await handler.run(
      context(),
      { repo: "o/r", head: "task/1", base: "main", title: "Fix login", body: "Closes #1" },
      node,
    );

    expect(output).toEqual({ prNumber: 204, prUrl: "https://github.com/o/r/pull/204" });
    expect(client.firstCallTo("openPullRequest").args[1]).toEqual({
      head: "task/1",
      base: "main",
      title: "Fix login",
      body: "Closes #1",
    });
  });

  it("falls back to the repo's real default branch, not to 'main'", async () => {
    const client = new MockGitHubClient({ defaultBranch: "trunk" });
    const handler = createOpenPrHandler(deps({ client }));

    await handler.run(context(), { repo: "o/r", head: "task/1", title: "t" }, node);

    expect(client.firstCallTo("openPullRequest").args[1]).toMatchObject({ base: "trunk" });
  });

  it("does not call GitHub when head and base are the same branch", async () => {
    const client = new MockGitHubClient();
    const handler = createOpenPrHandler(deps({ client }));

    await expect(
      handler.run(context(), { repo: "o/r", head: "main", base: "main", title: "t" }, node),
    ).rejects.toThrow(/two different branches/);

    expect(client.callsTo("openPullRequest")).toHaveLength(0);
  });

  it("requires a title", async () => {
    const handler = createOpenPrHandler(deps());
    await expect(
      handler.run(context(), { repo: "o/r", head: "h", base: "main", title: "   " }, node),
    ).rejects.toThrow(/title is required/);
  });
});

describe("wait-for-checks", () => {
  /** A clock that only moves when the handler sleeps. */
  function fakeClock() {
    let time = 0;
    return {
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
      },
      get elapsed() {
        return time;
      },
    };
  }

  it("returns success once every check has concluded well", async () => {
    const client = new MockGitHubClient({
      checks: [
        [{ name: "test", status: "in_progress", conclusion: null }],
        [{ name: "test", status: "completed", conclusion: "success" }],
      ],
    });
    const clock = fakeClock();
    const handler = createWaitForChecksHandler(deps({ client, ...clock }));

    const output = await handler.run(context(), { repo: "o/r", ref: "sha" }, node);

    expect(output.conclusion).toBe("success");
    expect(client.callsTo("listChecks")).toHaveLength(2);
    expect(clock.elapsed).toBeGreaterThan(0);
  });

  it("returns failure as soon as one check fails", async () => {
    const client = new MockGitHubClient({
      checks: [
        [
          { name: "test", status: "completed", conclusion: "failure" },
          { name: "lint", status: "queued", conclusion: null },
        ],
      ],
    });
    const handler = createWaitForChecksHandler(deps({ client, ...fakeClock() }));

    const output = await handler.run(context(), { repo: "o/r", ref: "sha" }, node);

    expect(output.conclusion).toBe("failure");
    expect(client.callsTo("listChecks")).toHaveLength(1);
  });

  it("times out instead of polling forever", async () => {
    const client = new MockGitHubClient({
      checks: [[{ name: "test", status: "in_progress", conclusion: null }]],
    });
    const clock = fakeClock();
    const handler = createWaitForChecksHandler(deps({ client, ...clock }));

    const output = await handler.run(context(), { repo: "o/r", ref: "sha", timeoutSec: 60 }, node);

    expect(output.conclusion).toBe("timed_out");
    expect(clock.elapsed).toBeLessThanOrEqual(60_000);
  });

  it("reports no_checks — never success — when the repo has no CI", async () => {
    const client = new MockGitHubClient({ checks: [[]] });
    const handler = createWaitForChecksHandler(deps({ client, ...fakeClock() }));

    const output = await handler.run(context(), { repo: "o/r", ref: "sha" }, node);

    expect(output.conclusion).toBe("no_checks");
    expect(logs.some((entry) => entry.level === "warn" && /Nothing ran/.test(entry.message))).toBe(
      true,
    );
  });

  it("waits for a named required check that has not appeared yet", async () => {
    const client = new MockGitHubClient({
      checks: [
        [{ name: "lint", status: "completed", conclusion: "success" }],
        [
          { name: "lint", status: "completed", conclusion: "success" },
          { name: "e2e", status: "completed", conclusion: "success" },
        ],
      ],
    });
    const handler = createWaitForChecksHandler(deps({ client, ...fakeClock() }));

    const output = await handler.run(
      context(),
      { repo: "o/r", ref: "sha", requiredChecks: ["lint", "e2e"] },
      node,
    );

    expect(output.conclusion).toBe("success");
    expect(client.callsTo("listChecks")).toHaveLength(2);
  });
});
