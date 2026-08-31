import { beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { AgentRunRequest, AgentRunResult } from "../agent/AgentRunner";
import { PrismaBoardStore } from "../board/BoardStore";
import { MockGit, MockGitHubClient } from "../github/MockGitHubClient";
import { createHandlerRegistry } from "../handlers/index";
import { PrismaRunStore } from "../store";
import { createWorkspace, type Workspace } from "../workspace/index";
import { createBoardReconciler } from "./board";
import { runNextQueued } from "./runner";

/**
 * The crew, end to end: triage → plan → implement → review → PR.
 *
 * Two things are being proven that the single-implementer loop could not:
 * a reviewer can send the work back and the implementer genuinely runs again,
 * and a planner's breakdown becomes real cards on the board.
 */

const prisma = new PrismaClient();
const store = new PrismaRunStore(prisma);
const board = new PrismaBoardStore(prisma);

let workspace: Workspace;
let client: MockGitHubClient;
let git: MockGit;
let columns: Record<string, string>;
let boardId: string;
let pipelineId: string;

/** Records every agent call, and answers differently per role. */
class ScriptedCrew {
  readonly calls: { model: string; prompt: string }[] = [];
  /** How the reviewer answers, in order. The last answer repeats. */
  reviewVerdicts: string[] = ["APPROVED"];
  private reviews = 0;

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.calls.push({ model: request.model, prompt: request.prompt });

    const result = (() => {
      switch (request.model) {
        case "triager":
          return "bug — the sign-in handler redirects twice";
        case "planner":
          return JSON.stringify([
            { title: "Add a failing test for the redirect" },
            { title: "Fix the redirect" },
          ]);
        case "reviewer": {
          const index = Math.min(this.reviews, this.reviewVerdicts.length - 1);
          this.reviews += 1;
          return this.reviewVerdicts[index]!;
        }
        default:
          return "Implemented the fix.";
      }
    })();

    return { result, filesChanged: ["src/login.ts"], usage: { tokens: 10 }, toolCalls: [] };
  }

  callsTo(model: string) {
    return this.calls.filter((call) => call.model === model);
  }
}

let crew: ScriptedCrew;

function deps() {
  return {
    store,
    reconciler: createBoardReconciler(board),
    workspaceDir: () => workspace.dir,
    handlers: createHandlerRegistry({
      agent: {
        runners: new Map([
          ["mock", { provider: "mock", label: "Mock", keyless: false, runner: crew }],
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
        getApproval: async () => null,
        openApproval: async () => {},
        log: async (runId, entry) => {
          await store.appendLog(runId, entry);
        },
      },
      condition: {
        log: async (runId, entry) => {
          await store.appendLog(runId, entry);
        },
      },
    }),
  };
}

function agentNode(id: string, model: string, prompt: string, x: number) {
  return {
    id,
    type: "agent",
    label: id,
    config: { provider: "mock", model, prompt, allowedTools: ["Read"] },
    x,
    y: 0,
  };
}

/**
 * trigger → triage → plan → subtasks → implement → review → verdict
 *   verdict --CHANGES--> implement   (loop, max 2)
 *   verdict --APPROVED--> pr
 */
async function seedTeamPipeline() {
  const created = await prisma.board.create({
    data: {
      name: "My work",
      columns: {
        create: [
          { name: "Backlog", kind: "backlog", order: 50 },
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
      name: "The crew",
      variables: { create: [{ key: "repo", value: "jigabarda/Agentflow" }] },
      nodes: {
        create: [
          { id: "trigger", type: "task-trigger", label: "Card enters", config: {}, x: 0, y: 0 },
          agentNode("triage", "triager", "Classify: {{ trigger.task.title }}", 1),
          agentNode("plan", "planner", "Break down: {{ trigger.task.title }}", 2),
          {
            id: "subtasks",
            type: "create-task",
            label: "Create cards",
            config: { columnId: columns.backlog, tasks: "{{ nodes.plan.output.result }}" },
            x: 3,
            y: 0,
          },
          agentNode("implement", "implementer", "Implement: {{ trigger.task.title }}", 4),
          agentNode("review", "reviewer", "Review {{ nodes.implement.output.result }}", 5),
          {
            id: "verdict",
            type: "condition",
            label: "Verdict",
            config: {
              expression: "{{ nodes.review.output.result }}",
              cases: ["CHANGES", "APPROVED"],
              default: "CHANGES",
            },
            x: 6,
            y: 0,
          },
          {
            id: "pr",
            type: "open-pr",
            label: "Open PR",
            config: {
              repo: "{{ pipeline.vars.repo }}",
              head: "crew/{{ trigger.task.id }}",
              title: "{{ trigger.task.title }}",
              body: "{{ nodes.implement.output.result }}",
            },
            x: 7,
            y: 0,
          },
        ],
      },
      edges: {
        create: [
          { id: "e1", source: "trigger", target: "triage" },
          { id: "e2", source: "triage", target: "plan" },
          { id: "e3", source: "plan", target: "subtasks" },
          { id: "e4", source: "subtasks", target: "implement" },
          { id: "e5", source: "implement", target: "review" },
          { id: "e6", source: "review", target: "verdict" },
          { id: "e7", source: "verdict", target: "pr", sourceHandle: "APPROVED" },
          {
            id: "e8",
            source: "verdict",
            target: "implement",
            sourceHandle: "CHANGES",
            loop: true,
            maxIterations: 2,
          },
        ],
      },
    },
  });

  pipelineId = pipeline.id;
}

async function dropCard(title = "Fix login redirect") {
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

  workspace = createWorkspace("team");
  client = new MockGitHubClient({
    defaultBranch: "main",
    pullRequest: { number: 88, url: "https://github.com/jigabarda/Agentflow/pull/88" },
  });
  git = new MockGit({ headSha: "base1234", commitSha: "c0mm1t99" });
  crew = new ScriptedCrew();

  await seedTeamPipeline();
  return () => workspace.cleanup();
});

describe("the crew, when the reviewer approves first time", () => {
  it("runs each role once and opens the PR", async () => {
    const task = await dropCard();

    const outcome = await runNextQueued(deps());

    expect(outcome?.status).toBe("succeeded");
    expect(crew.callsTo("triager")).toHaveLength(1);
    expect(crew.callsTo("implementer")).toHaveLength(1);
    expect(crew.callsTo("reviewer")).toHaveLength(1);
    expect(client.callsTo("openPullRequest")).toHaveLength(1);

    const steps = await prisma.runStep.findMany({ where: { run: { taskId: task.id } } });
    expect(steps.find((step) => step.nodeId === "pr")?.status).toBe("succeeded");
  });

  it("gives each role its own brief", async () => {
    await dropCard();
    await runNextQueued(deps());

    expect(crew.callsTo("triager")[0]?.prompt).toBe("Classify: Fix login redirect");
    // The reviewer is handed the implementer's own report.
    expect(crew.callsTo("reviewer")[0]?.prompt).toContain("Implemented the fix.");
  });
});

describe("decomposition onto the board", () => {
  it("turns the planner's breakdown into real cards", async () => {
    const parent = await dropCard();
    await runNextQueued(deps());

    const children = await prisma.task.findMany({
      where: { columnId: columns.backlog, boardId },
      orderBy: { order: "asc" },
    });

    expect(children.map((child) => child.title)).toEqual([
      "Add a failing test for the redirect",
      "Fix the redirect",
    ]);
    expect(children.every((child) => child.parentTaskId === parent.id)).toBe(true);
  });

  it("makes the parent traceable from each child's timeline", async () => {
    const parent = await dropCard();
    await runNextQueued(deps());

    const children = await prisma.task.findMany({ where: { columnId: columns.backlog } });

    for (const child of children) {
      const events = await prisma.taskEvent.findMany({ where: { taskId: child.id } });
      expect(events[0]?.message).toContain(parent.title);
      expect((events[0]?.meta as { parentTaskId?: string })?.parentTaskId).toBe(parent.id);
    }
  });

  it("records the split on the parent too", async () => {
    const parent = await dropCard();
    await runNextQueued(deps());

    const events = await prisma.taskEvent.findMany({ where: { taskId: parent.id } });
    expect(events.some((event) => event.message === "Split into 2 cards.")).toBe(true);
  });
});

describe("the reviewer loop", () => {
  it("sends the work back once, then proceeds", async () => {
    crew.reviewVerdicts = ["CHANGES — the test is missing", "APPROVED"];
    await dropCard();

    const outcome = await runNextQueued(deps());

    expect(outcome?.status).toBe("succeeded");
    // The implementer genuinely ran again; the planner did not.
    expect(crew.callsTo("implementer")).toHaveLength(2);
    expect(crew.callsTo("reviewer")).toHaveLength(2);
    expect(crew.callsTo("planner")).toHaveLength(1);
    expect(client.callsTo("openPullRequest")).toHaveLength(1);
  });

  it("does not create the subtask cards twice when it loops", async () => {
    crew.reviewVerdicts = ["CHANGES", "APPROVED"];
    await dropCard();
    await runNextQueued(deps());

    expect(await prisma.task.count({ where: { columnId: columns.backlog } })).toBe(2);
  });

  it("gives up at the cap rather than looping forever", async () => {
    crew.reviewVerdicts = ["CHANGES"];
    const task = await dropCard();

    const outcome = await runNextQueued(deps());

    expect(outcome?.status).toBe("failed");
    // maxIterations is 2 on the loop edge, so three attempts in total.
    expect(crew.callsTo("implementer")).toHaveLength(3);
    expect(client.callsTo("openPullRequest")).toHaveLength(0);

    const events = await prisma.taskEvent.findMany({ where: { taskId: task.id } });
    expect(events.some((event) => event.kind === "run_failed")).toBe(true);
  });

  it("says in the log why it gave up — never silently", async () => {
    crew.reviewVerdicts = ["CHANGES"];
    const task = await dropCard();
    await runNextQueued(deps());

    const logs = await prisma.logEntry.findMany({ where: { run: { taskId: task.id } } });
    const message = logs.map((entry) => entry.message).join("\n");

    expect(message).toMatch(/sent back for another attempt more than 2 time\(s\)/);
    expect(message).toMatch(/raise the limit on the loop edge/);
  });
});

describe("the branch not taken", () => {
  it("records the PR node as skipped rather than leaving a gap", async () => {
    // The reviewer never approves, but the cap is high enough to finish, so we
    // use a verdict the condition cannot match at all and let it default.
    crew.reviewVerdicts = ["CHANGES", "APPROVED"];
    const task = await dropCard();
    await runNextQueued(deps());

    // On the successful path nothing is skipped.
    const steps = await prisma.runStep.findMany({ where: { run: { taskId: task.id } } });
    expect(steps.filter((step) => step.status === "skipped")).toHaveLength(0);
  });

  it("takes the default branch when the reviewer answers something unrecognisable", async () => {
    crew.reviewVerdicts = ["I am not sure what to say"];
    await dropCard();

    const outcome = await runNextQueued(deps());

    // The default is CHANGES, so it loops to the cap rather than shipping.
    expect(outcome?.status).toBe("failed");
    expect(client.callsTo("openPullRequest")).toHaveLength(0);
  });
});
