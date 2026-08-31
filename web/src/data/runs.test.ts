// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { containsSecret } from "@agentflow/core";
import { createBoard } from "./boards";
import { createPipeline } from "./pipelines";
import {
  appendLog,
  createRunStep,
  enqueueRun,
  getRun,
  listLogs,
  listRunsForTask,
  setRunStatus,
  setRunStepStatus,
} from "./runs";
import { createTask } from "./tasks";
import { resetDatabase } from "./testing";

beforeEach(resetDatabase);

async function seed() {
  const pipeline = await createPipeline({ name: "Implement a task" });
  const board = await createBoard("My work");
  const column = board.columns.find((c) => c.kind === "ready")!;
  const task = await createTask({
    boardId: board.id,
    columnId: column.id,
    title: "Fix login redirect",
  });
  return { pipeline, board, task };
}

describe("enqueueRun", () => {
  it("creates a run in the queued state — the web app never executes", async () => {
    const { pipeline, task } = await seed();
    const { id } = await enqueueRun({
      pipelineId: pipeline.id,
      taskId: task.id,
      trigger: { task: { id: task.id, title: task.title } },
    });

    const run = await getRun(id);
    expect(run?.status).toBe("queued");
    expect(run?.startedAt).toBeNull();
    expect(run?.taskId).toBe(task.id);
  });

  it("stores the trigger payload so the agent can read the card as its brief", async () => {
    const { pipeline, task } = await seed();
    const { id } = await enqueueRun({
      pipelineId: pipeline.id,
      taskId: task.id,
      trigger: { task: { title: "Fix login redirect", body: "## Steps" } },
    });

    const run = await getRun(id);
    expect(run?.trigger).toEqual({ task: { title: "Fix login redirect", body: "## Steps" } });
  });

  it("allows a canvas test-run with no card attached", async () => {
    const { pipeline } = await seed();
    const { id } = await enqueueRun({ pipelineId: pipeline.id, trigger: { input: {} } });
    expect((await getRun(id))?.taskId).toBeNull();
  });

  it("lists a card's runs newest first", async () => {
    const { pipeline, task } = await seed();
    const first = await enqueueRun({ pipelineId: pipeline.id, taskId: task.id, trigger: {} });
    const second = await enqueueRun({ pipelineId: pipeline.id, taskId: task.id, trigger: {} });

    const runs = await listRunsForTask(task.id);
    expect(runs.map((r) => r.id)).toEqual([second.id, first.id]);
  });
});

describe("run lifecycle", () => {
  it("moves a run through running to succeeded", async () => {
    const { pipeline, task } = await seed();
    const { id } = await enqueueRun({ pipelineId: pipeline.id, taskId: task.id, trigger: {} });

    await setRunStatus(id, { status: "running", startedAt: new Date("2026-08-19T09:00:00Z") });
    expect((await getRun(id))?.status).toBe("running");

    await setRunStatus(id, {
      status: "succeeded",
      endedAt: new Date("2026-08-19T09:05:00Z"),
      tokensUsed: 4212,
    });

    const run = await getRun(id);
    expect(run?.status).toBe("succeeded");
    expect(run?.tokensUsed).toBe(4212);
    expect(run?.endedAt).toEqual(new Date("2026-08-19T09:05:00Z"));
  });

  it("parks a run at awaiting_approval — the board's human gate", async () => {
    const { pipeline, task } = await seed();
    const { id } = await enqueueRun({ pipelineId: pipeline.id, taskId: task.id, trigger: {} });
    await setRunStatus(id, { status: "awaiting_approval" });
    expect((await getRun(id))?.status).toBe("awaiting_approval");
  });

  it("records a failure reason", async () => {
    const { pipeline, task } = await seed();
    const { id } = await enqueueRun({ pipelineId: pipeline.id, taskId: task.id, trigger: {} });
    await setRunStatus(id, { status: "failed", error: "open-pr: 422 validation failed" });

    const run = await getRun(id);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("open-pr");
  });

  it("tracks steps and their output", async () => {
    const { pipeline, task } = await seed();
    const { id } = await enqueueRun({ pipelineId: pipeline.id, taskId: task.id, trigger: {} });

    const step = await createRunStep(id, "impl");
    expect(step.status).toBe("pending");

    await setRunStepStatus(step.id, { status: "running", startedAt: new Date() });
    await setRunStepStatus(step.id, {
      status: "succeeded",
      output: { filesChanged: ["src/auth.ts"], prUrl: "https://github.com/acme/app/pull/204" },
      endedAt: new Date(),
    });

    const run = await getRun(id);
    expect(run?.steps).toHaveLength(1);
    expect(run?.steps[0]!.status).toBe("succeeded");
    expect(run?.steps[0]!.output).toMatchObject({ filesChanged: ["src/auth.ts"] });
  });

  it("cascades steps and logs away with the run's pipeline", async () => {
    const { pipeline, task } = await seed();
    const { id } = await enqueueRun({ pipelineId: pipeline.id, taskId: task.id, trigger: {} });
    await createRunStep(id, "impl");
    await appendLog(id, { level: "info", message: "started" });

    const { deletePipeline } = await import("./pipelines");
    await deletePipeline(pipeline.id);

    expect(await getRun(id)).toBeNull();
    expect(await listLogs(id)).toEqual([]);
  });
});

describe("appendLog redaction", () => {
  const TOKEN = "ghp_averyrealisticlookinggithubtoken000000";

  it("NEVER writes a secret to the log, even when the caller passes one in", async () => {
    const { pipeline, task } = await seed();
    const { id } = await enqueueRun({ pipelineId: pipeline.id, taskId: task.id, trigger: {} });

    await appendLog(id, {
      level: "info",
      message: `git push https://${TOKEN}@github.com/acme/app.git`,
      nodeId: "commit-changes",
      secrets: [TOKEN],
    });

    const logs = await listLogs(id);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.message).not.toContain(TOKEN);
    expect(logs[0]!.message).toContain("[redacted]");
    expect(containsSecret(logs[0]!.message, [TOKEN])).toBe(false);
  });

  it("scrubs a secret in its URL-encoded form too", async () => {
    const { pipeline, task } = await seed();
    const { id } = await enqueueRun({ pipelineId: pipeline.id, taskId: task.id, trigger: {} });
    const secret = "p@ss word/with+chars";

    await appendLog(id, {
      level: "error",
      message: `auth failed for ${encodeURIComponent(secret)}`,
      secrets: [secret],
    });

    const logs = await listLogs(id);
    expect(containsSecret(logs[0]!.message, [secret])).toBe(false);
  });

  it("leaves ordinary messages intact", async () => {
    const { pipeline, task } = await seed();
    const { id } = await enqueueRun({ pipelineId: pipeline.id, taskId: task.id, trigger: {} });

    await appendLog(id, { level: "info", message: "cloned acme/app at 3f2a19c", secrets: [TOKEN] });
    expect((await listLogs(id))[0]!.message).toBe("cloned acme/app at 3f2a19c");
  });

  it("returns logs in the order they were written", async () => {
    const { pipeline, task } = await seed();
    const { id } = await enqueueRun({ pipelineId: pipeline.id, taskId: task.id, trigger: {} });

    for (const message of ["one", "two", "three"]) {
      await appendLog(id, { level: "debug", message });
    }
    expect((await listLogs(id)).map((l) => l.message)).toEqual(["one", "two", "three"]);
  });
});
