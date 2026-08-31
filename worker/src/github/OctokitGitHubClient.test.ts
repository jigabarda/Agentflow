import { describe, expect, it } from "vitest";
import type { Octokit } from "@octokit/rest";
import { GitHubError } from "./GitHubClient";
import { OctokitGitHubClient } from "./OctokitGitHubClient";

/**
 * The real client, with Octokit itself replaced.
 *
 * What is worth testing here is the translation layer: that config reaches
 * Octokit as the right params, that responses are narrowed to our shapes, and
 * that GitHub's status codes become errors a user can act on.
 */

function fakeOctokit(overrides: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const record = (method: string, response: unknown) => async (params: unknown) => {
    calls.push({ method, params });
    if (response instanceof Error) throw response;
    return { data: response };
  };

  const octokit = {
    issues: { get: record("issues.get", overrides.issue ?? { number: 1, title: "t" }) },
    repos: {
      getCommit: record("repos.getCommit", overrides.commit ?? { sha: "abc" }),
      get: record("repos.get", overrides.repo ?? { default_branch: "main" }),
    },
    pulls: {
      create: record(
        "pulls.create",
        overrides.pr ?? { number: 5, html_url: "https://github.com/o/r/pull/5" },
      ),
      merge: record("pulls.merge", overrides.merge ?? { merged: true, sha: "m" }),
    },
    checks: { listForRef: record("checks.listForRef", overrides.checks ?? { check_runs: [] }) },
  };

  /** Indexed access that fails the test loudly instead of yielding undefined. */
  const at = (index: number) => {
    const call = calls[index];
    if (!call)
      throw new Error(`expected an Octokit call #${index}, but there were ${calls.length}`);
    return call;
  };

  return { octokit: octokit as unknown as Octokit, calls, at };
}

describe("OctokitGitHubClient", () => {
  it("splits owner/name into Octokit params", async () => {
    const { octokit, at } = fakeOctokit();
    await new OctokitGitHubClient("t", octokit).getIssue("jigabarda/Agentflow", 204);

    expect(at(0).params).toEqual({
      owner: "jigabarda",
      repo: "Agentflow",
      issue_number: 204,
    });
  });

  it("maps the issue through the pure mapper", async () => {
    const { octokit } = fakeOctokit({
      issue: { number: 204, title: "T", body: null, user: null, labels: [{ name: "bug" }] },
    });

    const issue = await new OctokitGitHubClient("t", octokit).getIssue("o/r", 204);

    expect(issue).toEqual({
      number: 204,
      title: "T",
      body: "",
      labels: ["bug"],
      author: "",
      state: "open",
      url: "",
    });
  });

  it("narrows check runs to name, status and conclusion", async () => {
    const { octokit } = fakeOctokit({
      checks: {
        check_runs: [
          { name: "test", status: "completed", conclusion: "success", id: 1, extra: "ignored" },
          { name: "lint", status: "in_progress", conclusion: null, id: 2 },
        ],
      },
    });

    const checks = await new OctokitGitHubClient("t", octokit).listChecks("o/r", "sha");

    expect(checks).toEqual([
      { name: "test", status: "completed", conclusion: "success" },
      { name: "lint", status: "in_progress", conclusion: null },
    ]);
  });

  it("returns the PR number and browser url", async () => {
    const { octokit, at } = fakeOctokit();
    const pr = await new OctokitGitHubClient("t", octokit).openPullRequest("o/r", {
      head: "task/1",
      base: "main",
      title: "Fix",
      body: null,
    });

    expect(pr).toEqual({ number: 5, url: "https://github.com/o/r/pull/5" });
    expect(at(0).params).toMatchObject({ head: "task/1", base: "main", body: "" });
  });

  it("reads the repo's default branch", async () => {
    const { octokit } = fakeOctokit({ repo: { default_branch: "trunk" } });
    expect(await new OctokitGitHubClient("t", octokit).getDefaultBranch("o/r")).toBe("trunk");
  });

  describe("errors a user can act on", () => {
    const failing = (status: number, message = "boom") =>
      fakeOctokit({ issue: Object.assign(new Error(message), { status }) }).octokit;

    it("explains a 401 as a token problem", async () => {
      await expect(new OctokitGitHubClient("t", failing(401)).getIssue("o/r", 1)).rejects.toThrow(
        /rejected the token \(401\)/,
      );
    });

    it("explains a 403 as a permission or rate limit", async () => {
      await expect(new OctokitGitHubClient("t", failing(403)).getIssue("o/r", 1)).rejects.toThrow(
        /missing a permission, or you are rate limited/,
      );
    });

    it("explains a 404 as not-there-or-not-visible", async () => {
      await expect(new OctokitGitHubClient("t", failing(404)).getIssue("o/r", 1)).rejects.toThrow(
        /does not exist, or the token cannot see it/,
      );
    });

    it("keeps the status on the error", async () => {
      const error = (await new OctokitGitHubClient("t", failing(422))
        .getIssue("o/r", 1)
        .catch((e: unknown) => e)) as GitHubError;

      expect(error).toBeInstanceOf(GitHubError);
      expect(error.status).toBe(422);
      expect(error.message).toContain("422");
    });

    it("rejects a malformed repo before calling GitHub at all", async () => {
      const { octokit, calls } = fakeOctokit();
      await expect(new OctokitGitHubClient("t", octokit).getIssue("not-a-repo", 1)).rejects.toThrow(
        /is not a repository/,
      );
      expect(calls).toHaveLength(0);
    });
  });
});
