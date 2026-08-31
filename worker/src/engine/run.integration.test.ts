import { beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createHandlerRegistry } from "../handlers/index";
import { PrismaRunStore } from "../store";
import { runNextQueued } from "./runner";

/**
 * The engine end-to-end, against a real database and no agents.
 *
 * A run is enqueued exactly as the web app enqueues one, the worker claims it
 * through the same queue, and the same runner executes it — so this proves the
 * whole path, not just the pieces.
 */

const prisma = new PrismaClient();
const store = new PrismaRunStore(prisma);
const deps = { store, handlers: createHandlerRegistry() };

beforeEach(async () => {
  await prisma.$transaction([
    prisma.logEntry.deleteMany(),
    prisma.runStep.deleteMany(),
    prisma.run.deleteMany(),
    prisma.variable.deleteMany(),
    prisma.pipelineNode.deleteMany(),
    prisma.pipelineEdge.deleteMany(),
    prisma.pipeline.deleteMany(),
  ]);
});

async function seedEchoPipeline() {
  const pipeline = await prisma.pipeline.create({
    data: {
      name: "Echo pipeline",
      variables: { create: [{ key: "greeting", value: "hello" }] },
      nodes: {
        create: [
          { id: "trigger", type: "manual-trigger", label: "Start", config: {}, x: 0, y: 0 },
          {
            id: "say",
            type: "echo",
            label: "Say it",
            config: { value: "{{ pipeline.vars.greeting }}, {{ trigger.who }}" },
            x: 200,
            y: 0,
          },
        ],
      },
      edges: { create: [{ id: "e1", source: "trigger", target: "say" }] },
    },
  });
  return pipeline;
}

/** Enqueue exactly as `POST /api/runs` does: a `queued` row and nothing more. */
async function enqueue(pipelineId: string, trigger: unknown) {
  return prisma.run.create({
    data: { pipelineId, status: "queued", trigger: trigger as never },
    select: { id: true },
  });
}

describe("an echo pipeline, end to end through the queue", () => {
  it("runs to completion and records every step and log", async () => {
    const pipeline = await seedEchoPipeline();
    const queued = await enqueue(pipeline.id, { who: "world" });

    const outcome = await runNextQueued(deps);

    expect(outcome?.status).toBe("succeeded");

    const run = await prisma.run.findUniqueOrThrow({
      where: { id: queued.id },
      include: { steps: true, logs: true },
    });

    expect(run.status).toBe("succeeded");
    expect(run.startedAt).not.toBeNull();
    expect(run.endedAt).not.toBeNull();
    expect(run.error).toBeNull();

    expect(run.steps).toHaveLength(2);
    expect(run.steps.every((step) => step.status === "succeeded")).toBe(true);

    // Interpolation ran against both the pipeline variables and the trigger.
    const say = run.steps.find((step) => step.nodeId === "say");
    expect(say?.output).toEqual({ value: "hello, world" });

    expect(run.logs.length).toBeGreaterThan(0);
    expect(run.logs.at(-1)?.message).toBe("Run succeeded.");
  });

  it("claims each queued run exactly once", async () => {
    const pipeline = await seedEchoPipeline();
    await enqueue(pipeline.id, { who: "first" });
    await enqueue(pipeline.id, { who: "second" });

    expect((await runNextQueued(deps))?.status).toBe("succeeded");
    expect((await runNextQueued(deps))?.status).toBe("succeeded");
    // Nothing left: the same run is never handed out twice.
    expect(await runNextQueued(deps)).toBeNull();

    const runs = await prisma.run.findMany();
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === "succeeded")).toBe(true);
  });

  it("leaves an already-claimed run alone", async () => {
    const pipeline = await seedEchoPipeline();
    const queued = await enqueue(pipeline.id, { who: "world" });
    // Simulate another worker having taken it.
    await prisma.run.update({ where: { id: queued.id }, data: { status: "running" } });

    expect(await runNextQueued(deps)).toBeNull();
  });

  it("records a failed run with the reason, and stops there", async () => {
    const pipeline = await prisma.pipeline.create({
      data: {
        name: "Broken pipeline",
        nodes: {
          create: [
            { id: "trigger", type: "manual-trigger", label: "Start", config: {}, x: 0, y: 0 },
            {
              id: "bad",
              type: "echo",
              label: "Bad template",
              config: { value: "{{ nodes.nothing.output.x }}" },
              x: 200,
              y: 0,
            },
            {
              id: "after",
              type: "echo",
              label: "Never runs",
              config: { value: "x" },
              x: 400,
              y: 0,
            },
          ],
        },
        edges: {
          create: [
            { id: "e1", source: "trigger", target: "bad" },
            { id: "e2", source: "bad", target: "after" },
          ],
        },
      },
    });

    const queued = await enqueue(pipeline.id, {});
    const outcome = await runNextQueued(deps);

    expect(outcome?.status).toBe("failed");

    const run = await prisma.run.findUniqueOrThrow({
      where: { id: queued.id },
      include: { steps: true, logs: true },
    });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("nothing");
    expect(run.endedAt).not.toBeNull();

    // The trigger succeeded, the bad node failed, and nothing ran after it.
    expect(run.steps.map((step) => `${step.nodeId}:${step.status}`).sort()).toEqual([
      "bad:failed",
      "trigger:succeeded",
    ]);
    expect(run.logs.some((entry) => entry.level === "error")).toBe(true);
  });

  it("keeps a run's trigger payload available to its nodes", async () => {
    const pipeline = await seedEchoPipeline();
    await enqueue(pipeline.id, { who: "card" });

    await runNextQueued(deps);

    const step = await prisma.runStep.findFirstOrThrow({ where: { nodeId: "say" } });
    expect(step.output).toEqual({ value: "hello, card" });
  });
});

describe("log redaction at the storage boundary", () => {
  it("never writes a secret the store was told about", async () => {
    const secret = "ghp_averyrealisticlookinggithubtoken000000";
    const guardedStore = new PrismaRunStore(prisma, [secret]);

    const pipeline = await seedEchoPipeline();
    const queued = await enqueue(pipeline.id, { who: "world" });

    await guardedStore.appendLog(queued.id, {
      level: "info",
      message: `pushing with ${secret}`,
    });

    const logs = await prisma.logEntry.findMany({ where: { runId: queued.id } });
    expect(logs[0]!.message).not.toContain(secret);
    expect(logs[0]!.message).toContain("[redacted]");
  });
});
