import { beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { MockAgentRunner } from "../agent/MockAgentRunner";
import { PrismaBoardStore } from "../board/BoardStore";
import { MockGit, MockGitHubClient } from "../github/MockGitHubClient";
import { createHandlerRegistry } from "../handlers/index";
import { PrismaRunStore } from "../store";
import { createWorkspace, type Workspace } from "../workspace/index";
import { createBoardReconciler } from "./board";
import { runNextQueued } from "./runner";

/**
 * 🎯 The golden loop, end to end.
 *
 * A card enters the automated column, agents work it in a clone, a PR is
 * opened, and the card moves itself to Review with the PR attached and a
 * complete timeline. Everything external is mocked; the queue, the graph walk,
 * interpolation, the board reconciler and the store are all real.
 */

const prisma = new PrismaClient();
const store = new PrismaRunStore(prisma);
const board = new PrismaBoardStore(prisma);

let workspace: Workspace;
let client: MockGitHubClient;
let git: MockGit;
let agent: MockAgentRunner;
let columns: Record<string, string>;
let boardId: string;
let pipelineId: string;

function deps() {
  return {
    store,
    reconciler: createBoardReconciler(board),
    workspaceDir: () => workspace.dir,
    handlers: createHandlerRegistry({
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
      board: {
        board,
        getApproval: async (runId, nodeId) => {
          const row = await prisma.runApproval.findUnique({
            where: { runId_nodeId: { runId, nodeId } },
            select: { state: true, comment: true },
          });
          return row
            ? { state: row.state as "pending" | "approved" | "rejected", comment: row.comment }
            : null;
        },
        openApproval: async (runId, nodeId) => {
          await prisma.runApproval.upsert({
            where: { runId_nodeId: { runId, nodeId } },
            create: { runId, nodeId, state: "pending" },
            update: {},
          });
        },
        log: async (runId, entry) => {
          await store.appendLog(runId, entry);
        },
      },
    }),
  };
}

/** The seed the web app's `seedGoldenLoop` writes, built here against Prisma. */
async function seedGoldenLoop() {
  const created = await prisma.board.create({
    data: {
      name: "My work",
      columns: {
        create: [
          { name: "Todo", kind: "ready", order: 100 },
          { name: "In progress", kind: "working", order: 200 },
          { name: "Review", kind: "waiting", order: 300 },
        ],
      },
    },
    include: { columns: true },
  });

  boardId = created.id;
  columns = Object.fromEntries(created.columns.map((column) => [column.kind, column.id]));

  const pipeline = await prisma.pipeline.create({
    data: {
      name: "Card → PR",
      variables: { create: [{ key: "repo", value: "jigabarda/Agentflow" }] },
      nodes: {
        create: [
          { id: "trigger", type: "task-trigger", label: "Card enters", config: {}, x: 0, y: 0 },
          {
            id: "clone",
            type: "clone-repo",
            label: "Clone",
            config: { repo: "{{ pipeline.vars.repo }}" },
            x: 1,
            y: 0,
          },
          {
            id: "branch",
            type: "create-branch",
            label: "Branch",
            config: {
              repo: "{{ pipeline.vars.repo }}",
              branchName: "agentflow/{{ trigger.task.id }}",
            },
            x: 2,
            y: 0,
          },
          {
            id: "implementer",
            type: "agent",
            label: "Implementer",
            config: {
              provider: "mock",
              model: "mock-1",
              prompt: "Implement: {{ trigger.task.title }}",
              allowedTools: ["Read", "Write", "Edit"],
            },
            x: 3,
            y: 0,
          },
          {
            id: "commit",
            type: "commit-changes",
            label: "Commit",
            config: {
              repo: "{{ pipeline.vars.repo }}",
              branch: "{{ nodes.branch.output.branch }}",
              message: "{{ trigger.task.title }}",
            },
            x: 4,
            y: 0,
          },
          {
            id: "pr",
            type: "open-pr",
            label: "Open PR",
            config: {
              repo: "{{ pipeline.vars.repo }}",
              head: "{{ nodes.branch.output.branch }}",
              title: "{{ trigger.task.title }}",
              body: "{{ nodes.implementer.output.result }}",
            },
            x: 5,
            y: 0,
          },
          {
            id: "handback",
            type: "update-task",
            label: "Back to you",
            config: {
              columnId: columns.waiting,
              prNumber: "{{ nodes.pr.output.prNumber }}",
              prUrl: "{{ nodes.pr.output.prUrl }}",
              comment: "Ready for review: {{ nodes.pr.output.prUrl }}",
            },
            x: 6,
            y: 0,
          },
        ],
      },
      edges: {
        create: [
          { id: "e1", source: "trigger", target: "clone" },
          { id: "e2", source: "clone", target: "branch" },
          { id: "e3", source: "branch", target: "implementer" },
          { id: "e4", source: "implementer", target: "commit" },
          { id: "e5", source: "commit", target: "pr" },
          { id: "e6", source: "pr", target: "handback" },
        ],
      },
    },
  });

  pipelineId = pipeline.id;

  await prisma.boardColumn.update({
    where: { id: columns.working! },
    data: {
      pipelineId,
      autoAdvance: { onRunSucceeded: columns.waiting, onRunFailed: columns.ready },
    },
  });
}

/** Exactly what the move API writes when a card is dropped into the column. */
async function dropCardIntoWorkingColumn(title = "Fix login redirect") {
  const task = await prisma.task.create({
    data: {
      boardId,
      columnId: columns.working!,
      title,
      body: "It redirects twice on sign-in.",
      order: 1000,
      labels: [],
      blockedBy: [],
    },
  });

  await prisma.run.create({
    data: {
      pipelineId,
      taskId: task.id,
      status: "queued",
      trigger: { task: { id: task.id, title: task.title, body: task.body } },
    },
  });

  return task;
}

beforeEach(async () => {
  await prisma.$transaction([
    prisma.logEntry.deleteMany(),
    prisma.runStep.deleteMany(),
    prisma.runApproval.deleteMany(),
    prisma.run.deleteMany(),
    prisma.taskEvent.deleteMany(),
    prisma.task.deleteMany(),
    prisma.boardColumn.deleteMany(),
    prisma.board.deleteMany(),
    prisma.variable.deleteMany(),
    prisma.pipelineNode.deleteMany(),
    prisma.pipelineEdge.deleteMany(),
    prisma.pipeline.deleteMany(),
  ]);

  workspace = createWorkspace("golden-loop");
  client = new MockGitHubClient({
    defaultBranch: "main",
    pullRequest: { number: 204, url: "https://github.com/jigabarda/Agentflow/pull/204" },
  });
  git = new MockGit({ headSha: "base1234", commitSha: "c0mm1t99" });
  agent = new MockAgentRunner({
    result: "Fixed the double redirect in the sign-in handler.",
    filesChanged: ["src/login.ts"],
  });

  await seedGoldenLoop();
  return () => workspace.cleanup();
});

describe("drag a card in, get a pull request back", () => {
  it("runs every step and succeeds", async () => {
    const task = await dropCardIntoWorkingColumn();

    const outcome = await runNextQueued(deps());

    expect(outcome?.status).toBe("succeeded");

    const steps = await prisma.runStep.findMany({
      where: { run: { taskId: task.id } },
      orderBy: { startedAt: "asc" },
    });
    expect(steps.map((step) => step.nodeId)).toEqual([
      "trigger",
      "clone",
      "branch",
      "implementer",
      "commit",
      "pr",
      "handback",
    ]);
    expect(steps.every((step) => step.status === "succeeded")).toBe(true);
  });

  it("moves the card itself to Review, with the PR attached", async () => {
    const task = await dropCardIntoWorkingColumn();

    await runNextQueued(deps());

    const after = await prisma.task.findUnique({ where: { id: task.id } });
    expect(after?.columnId).toBe(columns.waiting);
    expect(after?.prNumber).toBe(204);
    expect(after?.prUrl).toBe("https://github.com/jigabarda/Agentflow/pull/204");
  });

  it("leaves a timeline that tells the whole story", async () => {
    const task = await dropCardIntoWorkingColumn();
    await runNextQueued(deps());

    const events = await prisma.taskEvent.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: "asc" },
    });
    const kinds = events.map((event) => event.kind);

    expect(kinds).toContain("run_started");
    expect(kinds).toContain("run_step");
    expect(kinds).toContain("pr_opened");
    expect(kinds).toContain("moved");
    expect(kinds).toContain("run_succeeded");

    expect(events.some((event) => /Ready for review/.test(event.message))).toBe(true);
    // Every agent step is attributed to the node that did it.
    expect(events.some((event) => event.actor === "agent:implementer")).toBe(true);
  });

  it("gives the agent the card as its brief, in the run's own workspace", async () => {
    await dropCardIntoWorkingColumn();
    await runNextQueued(deps());

    expect(agent.lastRequest?.prompt).toBe("Implement: Fix login redirect");
    expect(agent.lastRequest?.workspaceDir).toBe(workspace.dir);
  });

  it("opens the PR from the branch it created, titled from the card", async () => {
    const task = await dropCardIntoWorkingColumn();
    await runNextQueued(deps());

    expect(git.firstCallTo("createBranch").args[1]).toBe(`agentflow/${task.id}`);
    expect(client.firstCallTo("openPullRequest").args[1]).toMatchObject({
      head: `agentflow/${task.id}`,
      base: "main",
      title: "Fix login redirect",
      body: "Fixed the double redirect in the sign-in handler.",
    });
  });
});

describe("when a step fails", () => {
  it("sends the card back to Todo and says where it broke", async () => {
    // The agent changed nothing, so there is nothing to commit.
    git = new MockGit({ headSha: "base1234", hasChanges: false });
    const task = await dropCardIntoWorkingColumn();

    const outcome = await runNextQueued(deps());

    expect(outcome?.status).toBe("failed");

    const after = await prisma.task.findUnique({ where: { id: task.id } });
    expect(after?.columnId).toBe(columns.ready);

    const failure = await prisma.taskEvent.findFirst({
      where: { taskId: task.id, kind: "run_failed" },
    });
    expect(failure?.message).toMatch(/Failed at commit/);
  });

  it("never opens a PR or touches the card's PR fields", async () => {
    git = new MockGit({ headSha: "base1234", hasChanges: false });
    const task = await dropCardIntoWorkingColumn();

    await runNextQueued(deps());

    expect(client.callsTo("openPullRequest")).toHaveLength(0);
    const after = await prisma.task.findUnique({ where: { id: task.id } });
    expect(after?.prUrl).toBeNull();
  });

  it("stops the run at the failing step", async () => {
    git = new MockGit({ headSha: "base1234", hasChanges: false });
    const task = await dropCardIntoWorkingColumn();

    await runNextQueued(deps());

    const steps = await prisma.runStep.findMany({ where: { run: { taskId: task.id } } });
    expect(steps.find((step) => step.nodeId === "commit")?.status).toBe("failed");
    expect(steps.find((step) => step.nodeId === "pr")).toBeUndefined();
  });
});

describe("the queue", () => {
  it("takes one card at a time, in the order they were dropped", async () => {
    const first = await dropCardIntoWorkingColumn("First card");
    const second = await dropCardIntoWorkingColumn("Second card");

    await runNextQueued(deps());
    expect((await prisma.task.findUnique({ where: { id: first.id } }))?.columnId).toBe(
      columns.waiting,
    );
    // The second is still queued and untouched.
    expect((await prisma.task.findUnique({ where: { id: second.id } }))?.columnId).toBe(
      columns.working,
    );

    await runNextQueued(deps());
    expect((await prisma.task.findUnique({ where: { id: second.id } }))?.columnId).toBe(
      columns.waiting,
    );
  });

  it("goes idle when there is nothing queued", async () => {
    expect(await runNextQueued(deps())).toBeNull();
  });
});
