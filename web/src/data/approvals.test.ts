// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { decideApproval, listPendingApprovals, pendingApprovalForTask } from "./approvals";
import { createBoard } from "./boards";
import { prisma } from "./client";
import { createPipeline } from "./pipelines";
import { fingerprint, runSummariesForBoard } from "./runSummaries";
import { createTask, listTaskEvents } from "./tasks";
import { resetDatabase } from "./testing";

/**
 * Human gates from the board's side.
 *
 * Approving and rejecting both re-queue the run: a rejection is not a special
 * path, it is the run resuming and failing at the gate with your words as the
 * reason, so the column's failure rule still applies (docs/BOARD.md).
 */

beforeEach(resetDatabase);

async function seedParkedRun() {
  const board = await createBoard("My work");
  const byKind = Object.fromEntries(board.columns.map((column) => [column.kind, column]));

  const pipeline = await createPipeline({
    name: "Gated",
    nodes: [
      { id: "trigger", type: "task-trigger", label: "Start", config: {}, x: 0, y: 0 },
      { id: "gate", type: "require-approval", label: "Approve?", config: {}, x: 1, y: 0 },
    ],
    edges: [{ id: "e1", source: "trigger", target: "gate" }],
  });

  const task = await createTask({
    boardId: board.id,
    columnId: byKind.waiting!.id,
    title: "Ship it",
  });

  const run = await prisma.run.create({
    data: {
      pipelineId: pipeline.id,
      taskId: task.id,
      status: "awaiting_approval",
      trigger: { task: { id: task.id, title: task.title } },
    },
  });

  await prisma.runApproval.create({
    data: { runId: run.id, nodeId: "gate", state: "pending" },
  });

  return { board, byKind, task, run, pipeline };
}

describe("approving", () => {
  it("puts the run back in the queue for the worker to resume", async () => {
    const { run } = await seedParkedRun();

    const result = await decideApproval(run.id, "approve", "Looks right");

    expect(result).toEqual({ ok: true, state: "approved" });
    expect((await prisma.run.findUnique({ where: { id: run.id } }))?.status).toBe("queued");
  });

  it("records the verdict and the comment on the gate", async () => {
    const { run } = await seedParkedRun();
    await decideApproval(run.id, "approve", "Looks right");

    const gate = await prisma.runApproval.findFirst({ where: { runId: run.id } });
    expect(gate?.state).toBe("approved");
    expect(gate?.comment).toBe("Looks right");
    expect(gate?.decidedAt).not.toBeNull();
  });

  it("puts the decision on the card's timeline", async () => {
    const { run, task } = await seedParkedRun();
    await decideApproval(run.id, "approve", "Looks right");

    const events = await listTaskEvents(task.id);
    expect(events.at(-1)).toMatchObject({ kind: "approved", message: "Looks right" });
  });

  it("falls back to a plain word when no comment was given", async () => {
    const { run, task } = await seedParkedRun();
    await decideApproval(run.id, "approve", null);

    expect((await listTaskEvents(task.id)).at(-1)?.message).toBe("Approved.");
  });
});

describe("rejecting", () => {
  it("also re-queues, so the run fails through the normal path", async () => {
    const { run } = await seedParkedRun();

    const result = await decideApproval(run.id, "reject", "Wrong approach");

    expect(result).toEqual({ ok: true, state: "rejected" });
    expect((await prisma.run.findUnique({ where: { id: run.id } }))?.status).toBe("queued");
  });

  it("keeps the comment, which becomes the run's failure reason", async () => {
    const { run } = await seedParkedRun();
    await decideApproval(run.id, "reject", "Wrong approach");

    const gate = await prisma.runApproval.findFirst({ where: { runId: run.id } });
    expect(gate).toMatchObject({ state: "rejected", comment: "Wrong approach" });
  });
});

describe("decisions that do not apply", () => {
  it("refuses a run that is not waiting on anything", async () => {
    const { run } = await seedParkedRun();
    await prisma.run.update({ where: { id: run.id }, data: { status: "running" } });

    expect(await decideApproval(run.id, "approve", null)).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it("refuses a run that does not exist", async () => {
    expect(await decideApproval("run_nope", "approve", null)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("refuses a second decision on a gate already decided", async () => {
    const { run } = await seedParkedRun();
    await decideApproval(run.id, "approve", null);
    // The run is queued again now, so there is nothing left to approve.
    expect(await decideApproval(run.id, "approve", null)).toMatchObject({ ok: false });
  });
});

describe("finding what is waiting on you", () => {
  it("lists a parked gate with its pipeline and card", async () => {
    const { run, task } = await seedParkedRun();

    const pending = await listPendingApprovals();

    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ runId: run.id, taskId: task.id, pipelineName: "Gated" });
  });

  it("finds the gate a given card is parked at", async () => {
    const { task, run } = await seedParkedRun();
    expect(await pendingApprovalForTask(task.id)).toMatchObject({ runId: run.id, nodeId: "gate" });
  });

  it("lists nothing once the decision is made", async () => {
    const { run } = await seedParkedRun();
    await decideApproval(run.id, "approve", null);

    expect(await listPendingApprovals()).toEqual([]);
  });
});

describe("run summaries — what the card face shows", () => {
  it("reports the parked run as needing you", async () => {
    const { board, task } = await seedParkedRun();

    const summaries = await runSummariesForBoard(board.id);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ taskId: task.id, awaitingApproval: true, total: 2 });
  });

  it("counts finished steps against the pipeline's size", async () => {
    const { board, run } = await seedParkedRun();
    await prisma.runStep.create({
      data: { runId: run.id, nodeId: "trigger", status: "succeeded", startedAt: new Date() },
    });

    const [summary] = await runSummariesForBoard(board.id);
    expect(summary).toMatchObject({ done: 1, total: 2 });
  });

  it("names the failing step, so the card can say where it broke", async () => {
    const { board, run } = await seedParkedRun();
    await prisma.run.update({
      where: { id: run.id },
      data: { status: "failed", error: "nothing to commit" },
    });
    await prisma.runStep.create({
      data: { runId: run.id, nodeId: "gate", status: "failed", startedAt: new Date() },
    });

    const [summary] = await runSummariesForBoard(board.id);
    expect(summary).toMatchObject({ status: "failed", currentNodeId: "gate" });
    expect(summary?.error).toBe("nothing to commit");
  });

  it("shows only the newest run for a card", async () => {
    const { board, task, pipeline } = await seedParkedRun();
    await prisma.run.create({
      data: { pipelineId: pipeline.id, taskId: task.id, status: "queued", trigger: {} },
    });

    const summaries = await runSummariesForBoard(board.id);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.status).toBe("queued");
  });

  it("changes its fingerprint when a step finishes, and not otherwise", async () => {
    const { board, run } = await seedParkedRun();
    const before = fingerprint(await runSummariesForBoard(board.id));

    expect(fingerprint(await runSummariesForBoard(board.id))).toBe(before);

    await prisma.runStep.create({
      data: { runId: run.id, nodeId: "trigger", status: "succeeded", startedAt: new Date() },
    });
    expect(fingerprint(await runSummariesForBoard(board.id))).not.toBe(before);
  });
});
