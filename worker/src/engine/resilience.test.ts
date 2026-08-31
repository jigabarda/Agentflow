import { beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { containsSecret } from "@agentflow/core";
import { createHandlerRegistry } from "../handlers/index";
import type { NodeHandler } from "../handlers/types";
import { NodeFailure } from "../handlers/types";
import { PrismaRunStore } from "../store";
import { recoverInterruptedRuns } from "./retry";
import { runNextQueued } from "./runner";

/**
 * Resilience against the real database: a worker that died mid-run, a run
 * retried from the step that broke, and a cost guard that stops a runaway.
 *
 * These use PrismaRunStore rather than the in-memory one on purpose — the
 * recovery and retry guarantees are about rows surviving a process, so an
 * in-memory double would be testing the wrong thing.
 */

const prisma = new PrismaClient();
const SECRET = "sk-live-thisisafaketokenfortestsonly";
const store = new PrismaRunStore(prisma, [SECRET]);

let executions: string[];
let pipelineId: string;

/** A node that reports token usage, so the cost guard has something to count. */
const spender: NodeHandler<{ tokens?: number }, { usage: { tokens: number } }> = {
  type: "spender",
  async run(_context, config, node) {
    executions.push(node.id);
    return { usage: { tokens: config.tokens ?? 100 } };
  },
};

/** Fails the first time it runs, succeeds after that. */
let brokenUntilRetry = true;
const flaky: NodeHandler<Record<string, unknown>, { ok: true }> = {
  type: "flaky",
  async run(_context, _config, node) {
    executions.push(node.id);
    if (brokenUntilRetry) throw new NodeFailure("the network was down");
    return { ok: true };
  },
};

/** Writes a secret into a log, to prove the store scrubs it. */
const leaky: NodeHandler<Record<string, unknown>, { ok: true }> = {
  type: "leaky",
  async run(context, _config, node) {
    executions.push(node.id);
    await store.appendLog(context.runId, {
      level: "info",
      nodeId: node.id,
      message: `calling the API with token ${SECRET}`,
    });
    return { ok: true };
  },
};

function handlers() {
  const registry = createHandlerRegistry();
  registry.set(spender.type, spender as NodeHandler);
  registry.set(flaky.type, flaky as NodeHandler);
  registry.set(leaky.type, leaky as NodeHandler);
  return registry;
}

async function seedPipeline(
  nodes: { id: string; type: string; config?: Record<string, unknown> }[],
  maxTokensPerRun: number | null = null,
) {
  const pipeline = await prisma.pipeline.create({
    data: {
      name: "Resilience",
      maxTokensPerRun,
      nodes: {
        create: [
          { id: "trigger", type: "manual-trigger", label: "Start", config: {}, x: 0, y: 0 },
          ...nodes.map((node, index) => ({
            id: node.id,
            type: node.type,
            label: node.id,
            // Prisma types JSON columns narrowly; the shape is checked by the
            // node's own schema, not here.
            config: (node.config ?? {}) as never,
            x: index + 1,
            y: 0,
          })),
        ],
      },
      edges: {
        create: nodes.map((node, index) => ({
          id: `e${index}`,
          source: index === 0 ? "trigger" : nodes[index - 1]!.id,
          target: node.id,
        })),
      },
    },
  });

  pipelineId = pipeline.id;
  return pipeline;
}

async function enqueue() {
  return prisma.run.create({
    data: { pipelineId, status: "queued", trigger: {} },
    select: { id: true },
  });
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

  executions = [];
  brokenUntilRetry = true;
});

describe("a worker that died mid-run", () => {
  it("puts the stranded run back in the queue", async () => {
    await seedPipeline([{ id: "a", type: "spender" }]);
    const run = await enqueue();
    // Simulate the crash: claimed, marked running, then the process vanished.
    await prisma.run.update({ where: { id: run.id }, data: { status: "running" } });

    const report = await recoverInterruptedRuns(store);

    expect(report.runIds).toEqual([run.id]);
    expect((await prisma.run.findUnique({ where: { id: run.id } }))?.status).toBe("queued");
  });

  it("resumes from the last completed step rather than starting over", async () => {
    await seedPipeline([
      { id: "first", type: "spender" },
      { id: "second", type: "spender" },
    ]);
    const run = await enqueue();

    // First step done, then the process died during the second.
    await prisma.runStep.create({
      data: {
        runId: run.id,
        nodeId: "trigger",
        status: "succeeded",
        output: {},
        startedAt: new Date(),
      },
    });
    await prisma.runStep.create({
      data: {
        runId: run.id,
        nodeId: "first",
        status: "succeeded",
        output: { usage: { tokens: 100 } },
        startedAt: new Date(),
      },
    });
    await prisma.run.update({ where: { id: run.id }, data: { status: "running" } });

    await recoverInterruptedRuns(store);
    const outcome = await runNextQueued({ store, handlers: handlers() });

    expect(outcome?.status).toBe("succeeded");
    // `first` was not run again; only what was left.
    expect(executions).toEqual(["second"]);
  });

  it("leaves finished runs alone", async () => {
    await seedPipeline([{ id: "a", type: "spender" }]);
    const run = await enqueue();
    await prisma.run.update({ where: { id: run.id }, data: { status: "succeeded" } });

    expect((await recoverInterruptedRuns(store)).runIds).toEqual([]);
    expect((await prisma.run.findUnique({ where: { id: run.id } }))?.status).toBe("succeeded");
  });

  it("says what it recovered rather than doing it quietly", async () => {
    await seedPipeline([{ id: "a", type: "spender" }]);
    const run = await enqueue();
    await prisma.run.update({ where: { id: run.id }, data: { status: "running" } });

    const messages: string[] = [];
    await recoverInterruptedRuns(store, (message) => messages.push(message));

    expect(messages[0]).toMatch(/Recovered 1 run that were interrupted|Recovered 1 run/);
    expect(messages[0]).toContain(run.id);
  });
});

describe("retrying a failed run", () => {
  it("re-runs only the step that failed", async () => {
    await seedPipeline([
      { id: "before", type: "spender" },
      { id: "boom", type: "flaky" },
      { id: "after", type: "spender" },
    ]);
    const run = await enqueue();

    expect((await runNextQueued({ store, handlers: handlers() }))?.status).toBe("failed");
    expect(executions).toEqual(["before", "boom"]);

    // Exactly what the retry API does.
    brokenUntilRetry = false;
    executions = [];
    const failed = await prisma.runStep.findFirst({ where: { runId: run.id, status: "failed" } });
    await prisma.runStep.update({
      where: { id: failed!.id },
      data: { status: "pending", error: null, endedAt: null },
    });
    await prisma.run.update({
      where: { id: run.id },
      data: { status: "queued", error: null, endedAt: null },
    });

    const outcome = await runNextQueued({ store, handlers: handlers() });

    expect(outcome?.status).toBe("succeeded");
    // `before` was not repeated — that is the point of retrying from the step.
    expect(executions).toEqual(["boom", "after"]);
  });

  it("keeps the tokens the first attempt already spent", async () => {
    await seedPipeline([
      { id: "before", type: "spender", config: { tokens: 500 } },
      { id: "boom", type: "flaky" },
    ]);
    const run = await enqueue();
    await runNextQueued({ store, handlers: handlers() });

    expect((await prisma.run.findUnique({ where: { id: run.id } }))?.tokensUsed).toBe(500);

    brokenUntilRetry = false;
    const failed = await prisma.runStep.findFirst({ where: { runId: run.id, status: "failed" } });
    await prisma.runStep.update({ where: { id: failed!.id }, data: { status: "pending" } });
    await prisma.run.update({ where: { id: run.id }, data: { status: "queued", error: null } });

    await runNextQueued({ store, handlers: handlers() });

    // Still 500: a retry does not get a fresh budget, and does not double-count.
    expect((await prisma.run.findUnique({ where: { id: run.id } }))?.tokensUsed).toBe(500);
  });
});

describe("the cost guard", () => {
  it("lets a run inside its budget finish", async () => {
    await seedPipeline(
      [
        { id: "a", type: "spender", config: { tokens: 300 } },
        { id: "b", type: "spender", config: { tokens: 300 } },
      ],
      1000,
    );
    await enqueue();

    expect((await runNextQueued({ store, handlers: handlers() }))?.status).toBe("succeeded");
  });

  it("stops a runaway the moment it passes the line", async () => {
    await seedPipeline(
      [
        { id: "a", type: "spender", config: { tokens: 600 } },
        { id: "b", type: "spender", config: { tokens: 600 } },
        { id: "c", type: "spender", config: { tokens: 600 } },
      ],
      1000,
    );
    const run = await enqueue();

    const outcome = await runNextQueued({ store, handlers: handlers() });

    expect(outcome?.status).toBe("failed");
    // `c` never ran: the guard fired after `b` crossed the cap.
    expect(executions).toEqual(["a", "b"]);
    expect((await prisma.run.findUnique({ where: { id: run.id } }))?.error).toMatch(
      /past its limit of 1,000/,
    );
  });

  it("records what it spent, so the bill is visible after the fact", async () => {
    await seedPipeline([{ id: "a", type: "spender", config: { tokens: 250 } }], 1000);
    const run = await enqueue();
    await runNextQueued({ store, handlers: handlers() });

    expect((await prisma.run.findUnique({ where: { id: run.id } }))?.tokensUsed).toBe(250);
  });

  it("runs without a cap when the pipeline has none", async () => {
    await seedPipeline([{ id: "a", type: "spender", config: { tokens: 999_999 } }], null);
    await enqueue();

    expect((await runNextQueued({ store, handlers: handlers() }))?.status).toBe("succeeded");
  });

  it("explains itself in the run log, not just in the status", async () => {
    await seedPipeline([{ id: "a", type: "spender", config: { tokens: 5000 } }], 100);
    const run = await enqueue();
    await runNextQueued({ store, handlers: handlers() });

    const logs = await prisma.logEntry.findMany({ where: { runId: run.id } });
    expect(logs.some((entry) => /past its limit/.test(entry.message))).toBe(true);
  });
});

describe("redaction on the way to the database", () => {
  it("scrubs a secret a handler put in a log line", async () => {
    await seedPipeline([{ id: "a", type: "leaky" }]);
    const run = await enqueue();
    await runNextQueued({ store, handlers: handlers() });

    const logs = await prisma.logEntry.findMany({ where: { runId: run.id } });
    const written = logs.map((entry) => entry.message).join("\n");

    expect(containsSecret(written, [SECRET])).toBe(false);
    expect(written).toContain("[redacted]");
  });

  it("scrubs it whichever path the line came in by", async () => {
    // The engine's own lines and a handler's go through the same writer.
    await seedPipeline([{ id: "a", type: "leaky" }]);
    const run = await enqueue();
    await runNextQueued({ store, handlers: handlers() });

    await store.appendLog(run.id, { level: "warn", message: `retrying with ${SECRET}` });

    const logs = await prisma.logEntry.findMany({ where: { runId: run.id } });
    expect(containsSecret(logs.map((entry) => entry.message).join("\n"), [SECRET])).toBe(false);
  });
});
