// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { createBoard } from "./boards";
import { prisma } from "./client";
import { createPipeline } from "./pipelines";
import { retryRun } from "./retry";
import { listRuns, runTotals } from "./runHistory";
import { listSecretNames, setSecret, getSecret, deleteSecret } from "./secrets";
import { createTask, listTaskEvents } from "./tasks";
import { resetDatabase } from "./testing";

/**
 * Retrying, run history, and the secret store's write-only promise.
 */

beforeEach(resetDatabase);

async function seedFailedRun() {
  const board = await createBoard("My work");
  const byKind = Object.fromEntries(board.columns.map((column) => [column.kind, column]));

  const pipeline = await createPipeline({
    name: "Card → PR",
    nodes: [
      { id: "trigger", type: "manual-trigger", label: "Start", config: {}, x: 0, y: 0 },
      { id: "clone", type: "echo", label: "Clone", config: { value: "x" }, x: 1, y: 0 },
      { id: "pr", type: "echo", label: "PR", config: { value: "y" }, x: 2, y: 0 },
    ],
    edges: [
      { id: "e1", source: "trigger", target: "clone" },
      { id: "e2", source: "clone", target: "pr" },
    ],
  });

  const task = await createTask({
    boardId: board.id,
    columnId: byKind.working!.id,
    title: "Fix login",
  });

  const run = await prisma.run.create({
    data: {
      pipelineId: pipeline.id,
      taskId: task.id,
      status: "failed",
      error: "pr: the network was down",
      tokensUsed: 400,
      trigger: {},
    },
  });

  await prisma.runStep.create({
    data: {
      runId: run.id,
      nodeId: "clone",
      status: "succeeded",
      output: {},
      startedAt: new Date(),
    },
  });
  await prisma.runStep.create({
    data: {
      runId: run.id,
      nodeId: "pr",
      status: "failed",
      error: "the network was down",
      startedAt: new Date(),
    },
  });

  return { board, task, pipeline, run };
}

describe("retryRun", () => {
  it("puts the run back in the queue", async () => {
    const { run } = await seedFailedRun();

    const result = await retryRun(run.id);

    expect(result).toEqual({ ok: true, resumingFrom: "pr" });
    expect((await prisma.run.findUnique({ where: { id: run.id } }))?.status).toBe("queued");
  });

  it("clears the error, so the run is not still wearing its old failure", async () => {
    const { run } = await seedFailedRun();
    await retryRun(run.id);

    expect((await prisma.run.findUnique({ where: { id: run.id } }))?.error).toBeNull();
  });

  it("resets the failed step to pending and leaves the successful one alone", async () => {
    const { run } = await seedFailedRun();
    await retryRun(run.id);

    const steps = await prisma.runStep.findMany({ where: { runId: run.id } });
    expect(steps.find((step) => step.nodeId === "pr")?.status).toBe("pending");
    expect(steps.find((step) => step.nodeId === "pr")?.error).toBeNull();
    // The work that succeeded is kept — that is the whole point.
    expect(steps.find((step) => step.nodeId === "clone")?.status).toBe("succeeded");
  });

  it("keeps the tokens already spent", async () => {
    const { run } = await seedFailedRun();
    await retryRun(run.id);

    expect((await prisma.run.findUnique({ where: { id: run.id } }))?.tokensUsed).toBe(400);
  });

  it("says on the card which step it is retrying from", async () => {
    const { run, task } = await seedFailedRun();
    await retryRun(run.id);

    expect((await listTaskEvents(task.id)).at(-1)?.message).toBe("Retrying from pr.");
  });

  it("makes a skipped branch runnable again", async () => {
    const { run } = await seedFailedRun();
    await prisma.runStep.create({
      data: { runId: run.id, nodeId: "trigger", status: "skipped", startedAt: new Date() },
    });

    await retryRun(run.id);

    const skipped = await prisma.runStep.findFirst({
      where: { runId: run.id, nodeId: "trigger" },
    });
    expect(skipped?.status).toBe("pending");
  });

  it("refuses a run that did not fail", async () => {
    const { run } = await seedFailedRun();
    await prisma.run.update({ where: { id: run.id }, data: { status: "succeeded" } });

    expect(await retryRun(run.id)).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses a run that does not exist", async () => {
    expect(await retryRun("run_nope")).toMatchObject({ ok: false, status: 404 });
  });
});

describe("run history", () => {
  it("lists the newest runs with what they cost", async () => {
    const { run } = await seedFailedRun();

    const runs = await listRuns();

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: run.id,
      status: "failed",
      taskTitle: "Fix login",
      tokensUsed: 400,
      stepsDone: 1,
      stepsTotal: 3,
    });
  });

  it("filters by status", async () => {
    await seedFailedRun();

    expect(await listRuns({ status: "failed" })).toHaveLength(1);
    expect(await listRuns({ status: "succeeded" })).toHaveLength(0);
  });

  it("counts runs by status and tokens spent today", async () => {
    await seedFailedRun();

    const totals = await runTotals();
    expect(totals.byStatus.failed).toBe(1);
    expect(totals.tokensToday).toBe(400);
  });

  it("shows a run with no card under its pipeline's name", async () => {
    const pipeline = await createPipeline({ name: "Nightly audit", nodes: [], edges: [] });
    await prisma.run.create({
      data: { pipelineId: pipeline.id, status: "succeeded", trigger: {} },
    });

    const cardless = (await listRuns()).find((run) => run.taskId === null);
    expect(cardless?.pipelineName).toBe("Nightly audit");
    expect(cardless?.taskTitle).toBeNull();
  });
});

describe("the secret store", () => {
  it("lists names, never values", async () => {
    await setSecret("GITHUB_TOKEN", "ghp_realvalue");

    const names = await listSecretNames();
    expect(names).toEqual(["GITHUB_TOKEN"]);
    expect(JSON.stringify(names)).not.toContain("ghp_realvalue");
  });

  it("stores ciphertext, not the token", async () => {
    await setSecret("GITHUB_TOKEN", "ghp_realvalue");

    const row = await prisma.secret.findUnique({ where: { name: "GITHUB_TOKEN" } });
    expect(row?.ciphertext).not.toContain("ghp_realvalue");
    // …and it still round-trips for the one caller that needs it.
    expect(await getSecret("GITHUB_TOKEN")).toBe("ghp_realvalue");
  });

  it("replaces a token in place when it is rotated", async () => {
    await setSecret("GITHUB_TOKEN", "ghp_old");
    await setSecret("GITHUB_TOKEN", "ghp_new");

    expect(await listSecretNames()).toEqual(["GITHUB_TOKEN"]);
    expect(await getSecret("GITHUB_TOKEN")).toBe("ghp_new");
  });

  it("re-encrypts on rotation rather than reusing the ciphertext", async () => {
    await setSecret("GITHUB_TOKEN", "ghp_same");
    const first = await prisma.secret.findUnique({ where: { name: "GITHUB_TOKEN" } });

    await setSecret("GITHUB_TOKEN", "ghp_same");
    const second = await prisma.secret.findUnique({ where: { name: "GITHUB_TOKEN" } });

    expect(second?.ciphertext).not.toBe(first?.ciphertext);
  });

  it("forgets a removed token completely", async () => {
    await setSecret("GITHUB_TOKEN", "ghp_realvalue");
    await deleteSecret("GITHUB_TOKEN");

    expect(await listSecretNames()).toEqual([]);
    expect(await getSecret("GITHUB_TOKEN")).toBeNull();
  });
});
