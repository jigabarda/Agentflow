import { beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { MockAgentRunner } from "../agent/MockAgentRunner";
import { MockGit, MockGitHubClient } from "../github/MockGitHubClient";
import { createHandlerRegistry } from "../handlers/index";
import { createWorkspace, type Workspace } from "../workspace/index";
import { PrismaRunStore } from "../store";
import { runNextQueued } from "./runner";

/**
 * The issue → PR path, end to end through the real engine.
 *
 * Everything external is mocked — no token, no network, no clone — but the
 * queue, the graph walk, interpolation between nodes, the store and the
 * handlers are all the real ones. This is the shape Phase 7 drives from a card.
 */

const prisma = new PrismaClient();
const store = new PrismaRunStore(prisma);

let workspace: Workspace;
let client: MockGitHubClient;
let git: MockGit;
let agent: MockAgentRunner;

const ISSUE = {
  number: 204,
  title: "Fix login redirect",
  body: "It redirects twice on sign-in.",
  labels: ["bug"],
  author: "jigabarda",
  state: "open" as const,
  url: "https://github.com/o/r/issues/204",
};

function handlers() {
  return createHandlerRegistry({
    agent: {
      runners: new Map([
        ["mock", { provider: "mock", label: "Mock", keyless: false, runner: agent }],
      ]),
      loadProfiles: async () => new Map(),
      loadCredential: async () => ({ apiKey: "test-key" }),
      log: async (runId, entry) => {
        await store.appendLog(runId, entry);
      },
    },
    github: {
      client,
      git,
      identity: { name: "AgentFlow", email: "agentflow@localhost" },
      log: async (runId, entry) => {
        await store.appendLog(runId, entry);
      },
    },
  });
}

function deps() {
  return { store, handlers: handlers(), workspaceDir: () => workspace.dir };
}

beforeEach(async () => {
  await prisma.$transaction([
    prisma.logEntry.deleteMany(),
    prisma.runStep.deleteMany(),
    prisma.run.deleteMany(),
    prisma.variable.deleteMany(),
    prisma.pipelineNode.deleteMany(),
    prisma.pipelineEdge.deleteMany(),
    prisma.providerCredential.deleteMany(),
    prisma.pipeline.deleteMany(),
  ]);

  workspace = createWorkspace("github-integration");
  client = new MockGitHubClient({
    issues: { "204": ISSUE },
    defaultBranch: "main",
    pullRequest: { number: 77, url: "https://github.com/o/r/pull/77" },
  });
  git = new MockGit({ headSha: "base1234", commitSha: "c0mm1t99" });
  agent = new MockAgentRunner({ result: "Implemented the fix.", filesChanged: ["src/login.ts"] });

  return () => workspace.cleanup();
});

/** read-issue → clone → branch → agent → commit+push → open-pr. */
async function seedIssueToPrPipeline() {
  return prisma.pipeline.create({
    data: {
      name: "Issue to PR",
      variables: { create: [{ key: "repo", value: "o/r" }] },
      nodes: {
        create: [
          { id: "trigger", type: "manual-trigger", label: "Start", config: {}, x: 0, y: 0 },
          {
            id: "issue",
            type: "read-issue",
            label: "Read issue",
            config: { repo: "{{ pipeline.vars.repo }}", issueNumber: "{{ trigger.issueNumber }}" },
            x: 1,
            y: 0,
          },
          {
            id: "clone",
            type: "clone-repo",
            label: "Clone",
            config: { repo: "{{ pipeline.vars.repo }}" },
            x: 2,
            y: 0,
          },
          {
            id: "branch",
            type: "create-branch",
            label: "Branch",
            config: {
              repo: "{{ pipeline.vars.repo }}",
              branchName: "issue/{{ nodes.issue.output.issue.number }}",
            },
            x: 3,
            y: 0,
          },
          {
            id: "implementer",
            type: "agent",
            label: "Implement",
            config: {
              provider: "mock",
              model: "mock-1",
              prompt: "Fix: {{ nodes.issue.output.issue.title }}",
              allowedTools: ["Read", "Write", "Edit"],
            },
            x: 4,
            y: 0,
          },
          {
            id: "commit",
            type: "commit-changes",
            label: "Commit",
            config: {
              repo: "{{ pipeline.vars.repo }}",
              branch: "{{ nodes.branch.output.branch }}",
              message:
                "Fix #{{ nodes.issue.output.issue.number }}: {{ nodes.issue.output.issue.title }}",
            },
            x: 5,
            y: 0,
          },
          {
            id: "pr",
            type: "open-pr",
            label: "Open PR",
            config: {
              repo: "{{ pipeline.vars.repo }}",
              head: "{{ nodes.branch.output.branch }}",
              title:
                "Fix #{{ nodes.issue.output.issue.number }}: {{ nodes.issue.output.issue.title }}",
              body: "{{ nodes.implementer.output.result }}\n\nCloses #{{ nodes.issue.output.issue.number }}",
            },
            x: 6,
            y: 0,
          },
        ],
      },
      edges: {
        create: [
          { id: "e1", source: "trigger", target: "issue" },
          { id: "e2", source: "issue", target: "clone" },
          { id: "e3", source: "clone", target: "branch" },
          { id: "e4", source: "branch", target: "implementer" },
          { id: "e5", source: "implementer", target: "commit" },
          { id: "e6", source: "commit", target: "pr" },
        ],
      },
    },
  });
}

async function enqueue(pipelineId: string, trigger: unknown) {
  return prisma.run.create({
    data: { pipelineId, status: "queued", trigger: trigger as never },
    select: { id: true },
  });
}

describe("issue → PR, through the real engine", () => {
  it("runs every node in order and ends with a PR url", async () => {
    const pipeline = await seedIssueToPrPipeline();
    const queued = await enqueue(pipeline.id, { issueNumber: 204 });

    const outcome = await runNextQueued(deps());

    expect(outcome?.status).toBe("succeeded");

    const steps = await prisma.runStep.findMany({
      where: { runId: queued.id },
      orderBy: { startedAt: "asc" },
    });
    expect(steps.map((step) => step.nodeId)).toEqual([
      "trigger",
      "issue",
      "clone",
      "branch",
      "implementer",
      "commit",
      "pr",
    ]);
    expect(steps.every((step) => step.status === "succeeded")).toBe(true);

    const pr = steps.find((step) => step.nodeId === "pr");
    expect(pr?.output).toEqual({ prNumber: 77, prUrl: "https://github.com/o/r/pull/77" });
  });

  it("threads each node's output into the next one's config", async () => {
    const pipeline = await seedIssueToPrPipeline();
    await enqueue(pipeline.id, { issueNumber: 204 });

    await runNextQueued(deps());

    // The branch name came from the issue the first node fetched.
    expect(git.firstCallTo("createBranch").args[1]).toBe("issue/204");

    // The commit message and PR title came from the issue title.
    expect(git.firstCallTo("commitAll").args[1]).toBe("Fix #204: Fix login redirect");

    const prInput = client.firstCallTo("openPullRequest").args[1] as {
      head: string;
      base: string;
      title: string;
      body: string;
    };
    expect(prInput.head).toBe("issue/204");
    expect(prInput.base).toBe("main");
    expect(prInput.title).toBe("Fix #204: Fix login redirect");
    // The PR body is the agent's own summary.
    expect(prInput.body).toContain("Implemented the fix.");
    expect(prInput.body).toContain("Closes #204");
  });

  it("gives the agent the issue as its brief, in the run's workspace", async () => {
    const pipeline = await seedIssueToPrPipeline();
    await enqueue(pipeline.id, { issueNumber: 204 });

    await runNextQueued(deps());

    expect(agent.lastRequest?.prompt).toBe("Fix: Fix login redirect");
    expect(agent.lastRequest?.workspaceDir).toBe(workspace.dir);
    // The clone IS the workspace: the agent edits the checkout it was given.
    expect(git.firstCallTo("clone").args[0]).toMatchObject({ dir: workspace.dir });
  });

  it("stops at the failing node and never opens a PR when the agent changes nothing", async () => {
    git = new MockGit({ headSha: "base1234", hasChanges: false });

    const pipeline = await seedIssueToPrPipeline();
    const queued = await enqueue(pipeline.id, { issueNumber: 204 });

    const outcome = await runNextQueued(deps());

    expect(outcome?.status).toBe("failed");
    expect(outcome?.error).toMatch(/nothing to commit/);

    const steps = await prisma.runStep.findMany({ where: { runId: queued.id } });
    expect(steps.find((step) => step.nodeId === "commit")?.status).toBe("failed");
    // The PR node never ran.
    expect(steps.find((step) => step.nodeId === "pr")).toBeUndefined();
    expect(client.callsTo("openPullRequest")).toHaveLength(0);
  });

  it("fails the run when GitHub rejects the token, and says so", async () => {
    client = new MockGitHubClient({
      issues: { "204": ISSUE },
      failures: { getIssue: Object.assign(new Error("GitHub rejected the token (401)")) },
    });

    const pipeline = await seedIssueToPrPipeline();
    await enqueue(pipeline.id, { issueNumber: 204 });

    const outcome = await runNextQueued(deps());

    expect(outcome?.status).toBe("failed");
    expect(outcome?.error).toMatch(/rejected the token/);
    // Nothing was cloned: the run stopped at the first GitHub call.
    expect(git.calls).toHaveLength(0);
  });
});
