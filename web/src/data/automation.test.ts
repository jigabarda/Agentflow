// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { startColumnAutomation, startRunForTask, triggerPayloadFor } from "./automation";
import { createBoard, updateColumn } from "./boards";
import { prisma } from "./client";
import { seedGoldenLoop } from "./goldenLoop";
import { setProviderCredential } from "./secrets";
import { createTask, listTaskEvents } from "./tasks";
import { resetDatabase } from "./testing";

/**
 * Board-driven automation: a card entering a column starts that column's
 * pipeline. The web app still only ever writes a `queued` row — the worker is
 * what executes (CLAUDE.md guardrail 12).
 */

beforeEach(resetDatabase);

async function seed(options: { withKey?: boolean } = { withKey: true }) {
  const board = await createBoard("My work");
  const byKind = Object.fromEntries(board.columns.map((column) => [column.kind, column]));

  const loop = await seedGoldenLoop({
    boardId: board.id,
    repo: "jigabarda/Agentflow",
    provider: "ollama",
    model: "qwen2.5-coder",
  });

  if (options.withKey !== false) {
    // Ollama is keyless: a base URL is all it needs to be runnable.
    await setProviderCredential({
      pipelineId: loop.pipelineId,
      provider: "ollama",
      baseUrl: "http://localhost:11434/v1",
    });
  }

  const task = await createTask({
    boardId: board.id,
    columnId: byKind.ready!.id,
    title: "Fix login redirect",
    body: "It redirects twice.",
  });

  return { board, byKind, loop, task };
}

describe("triggerPayloadFor", () => {
  it("hands the agent the card as its brief", async () => {
    const { task } = await seed();
    const payload = triggerPayloadFor(task);

    expect(payload.task.title).toBe("Fix login redirect");
    expect(payload.task.body).toBe("It redirects twice.");
    // `{{ trigger.task.repo }}` has to exist even when it is empty.
    expect(payload.task).toHaveProperty("repo");
    expect(payload.task).toHaveProperty("issueNumber");
  });
});

describe("entering a column", () => {
  it("queues a run of that column's pipeline, with the card as the trigger", async () => {
    const { byKind, task, loop } = await seed();

    const outcome = await startColumnAutomation(task, byKind.working!.id);

    expect(outcome.started).toBe(true);

    const run = await prisma.run.findFirst({ where: { taskId: task.id } });
    expect(run?.status).toBe("queued");
    expect(run?.pipelineId).toBe(loop.pipelineId);
    expect((run?.trigger as { task: { title: string } }).task.title).toBe("Fix login redirect");
  });

  it("starts nothing for a column with no pipeline bound", async () => {
    const { byKind, task } = await seed();

    const outcome = await startColumnAutomation(task, byKind.backlog!.id);

    expect(outcome.started).toBe(false);
    expect(await prisma.run.count()).toBe(0);
  });

  it("records the queued run on the card's timeline", async () => {
    const { byKind, task } = await seed();
    await startColumnAutomation(task, byKind.working!.id);

    const events = await listTaskEvents(task.id);
    expect(events.some((event) => event.kind === "run_started")).toBe(true);
  });
});

describe("when the run cannot start", () => {
  it("refuses before spending anything if a provider has no credential", async () => {
    const { byKind, task } = await seed({ withKey: false });

    const outcome = await startColumnAutomation(task, byKind.working!.id);

    expect(outcome.started).toBe(false);
    expect(outcome).toMatchObject({ blocked: true });
    expect(await prisma.run.count()).toBe(0);
  });

  it("says why on the card, rather than silently doing nothing", async () => {
    const { byKind, task } = await seed({ withKey: false });
    await startColumnAutomation(task, byKind.working!.id);

    const events = await listTaskEvents(task.id);
    expect(events.at(-1)?.message).toMatch(/Could not start/);
  });

  it("stops automating, without losing cards, when the pipeline is deleted", async () => {
    // Invariant 4 of docs/BOARD.md: the binding goes null and the cards stay.
    const { byKind, task, loop } = await seed();
    await prisma.pipeline.delete({ where: { id: loop.pipelineId } });

    const outcome = await startColumnAutomation(task, byKind.working!.id);

    expect(outcome.started).toBe(false);
    expect(
      await prisma.boardColumn.findUnique({ where: { id: byKind.working!.id } }),
    ).toMatchObject({ pipelineId: null });
    expect(await prisma.task.count()).toBe(1);
  });

  it("reports a pipeline id that names nothing", async () => {
    const { task } = await seed();

    const outcome = await startRunForTask(task, "pipeline_that_never_existed");

    expect(outcome).toMatchObject({ started: false, blocked: true });
    expect(await prisma.run.count()).toBe(0);
  });
});

describe("the trigger's label filter", () => {
  it("skips a card that does not carry the required labels", async () => {
    const { task, loop } = await seed();
    await prisma.pipelineNode.update({
      where: { pipelineId_id: { pipelineId: loop.pipelineId, id: "trigger" } },
      data: { config: { requireLabels: ["bug"] } },
    });

    const outcome = await startRunForTask(task, loop.pipelineId);

    expect(outcome.started).toBe(false);
    // Not a failure — this column simply automates a different kind of card.
    expect(outcome).not.toMatchObject({ blocked: true });
    expect(await prisma.run.count()).toBe(0);
  });

  it("runs for a card that carries them", async () => {
    const { board, byKind, loop } = await seed();
    await prisma.pipelineNode.update({
      where: { pipelineId_id: { pipelineId: loop.pipelineId, id: "trigger" } },
      data: { config: { requireLabels: ["bug"] } },
    });

    const labelled = await createTask({
      boardId: board.id,
      columnId: byKind.ready!.id,
      title: "A bug",
      labels: ["bug", "ui"],
    });

    expect((await startRunForTask(labelled, loop.pipelineId)).started).toBe(true);
  });
});

describe("seedGoldenLoop", () => {
  it("binds the pipeline to the working column and sets both advance rules", async () => {
    const { byKind, loop } = await seed();

    const working = await prisma.boardColumn.findUnique({ where: { id: byKind.working!.id } });
    expect(working?.pipelineId).toBe(loop.pipelineId);
    expect(working?.autoAdvance).toMatchObject({
      onRunSucceeded: byKind.waiting!.id,
      onRunFailed: byKind.ready!.id,
    });
  });

  it("builds the whole card → PR chain in order", async () => {
    const { loop } = await seed();
    const nodes = await prisma.pipelineNode.findMany({ where: { pipelineId: loop.pipelineId } });

    expect(nodes.map((node) => node.type).sort()).toEqual(
      [
        "clone-repo",
        "commit-changes",
        "create-branch",
        "agent",
        "open-pr",
        "task-trigger",
        "update-task",
      ].sort(),
    );
  });

  it("hands the card back to Review with the PR attached", async () => {
    const { byKind, loop } = await seed();
    const handback = await prisma.pipelineNode.findUnique({
      where: { pipelineId_id: { pipelineId: loop.pipelineId, id: "handback" } },
    });

    expect(handback?.config).toMatchObject({
      columnId: byKind.waiting!.id,
      prUrl: "{{ nodes.pr.output.prUrl }}",
    });
  });

  it("refuses to seed a board with no working column", async () => {
    const board = await createBoard("Odd board", [{ name: "Only", kind: "backlog" }]);

    await expect(
      seedGoldenLoop({
        boardId: board.id,
        repo: "o/r",
        provider: "ollama",
        model: "qwen2.5-coder",
      }),
    ).rejects.toThrow(/needs a `working` column/);
  });

  it("picks up a column's pipeline binding that was set by hand", async () => {
    const { byKind, task, loop } = await seed();
    // Automating a *different* column should work exactly the same way.
    await updateColumn(byKind.backlog!.id, { pipelineId: loop.pipelineId });

    expect((await startColumnAutomation(task, byKind.backlog!.id)).started).toBe(true);
  });
});
