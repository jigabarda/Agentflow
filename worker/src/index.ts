/**
 * AgentFlow worker — the execution engine.
 *
 * The worker is the ONLY thing that runs pipelines and the only thing that
 * auto-moves cards (CLAUDE.md guardrail 12). It polls the database for queued
 * runs, claims one at a time, and executes it.
 */
import { decryptSecret } from "@agentflow/core/crypto";
import { PrismaClient } from "@prisma/client";
import { createRunnerRegistry } from "./agent/registry";
import type { AgentCredential } from "./agent/AgentRunner";
import type { AgentProfileRecord } from "./agent/config";
import { PrismaBoardStore } from "./board/BoardStore";
import { createBoardReconciler } from "./engine/board";
import { runNextQueued } from "./engine/runner";
import { createLazyGitHub } from "./github/lazy";
import { FetchHttpClient } from "./http/HttpClient";
import { createHandlerRegistry } from "./handlers/index";
import { PrismaSchedulerStore } from "./scheduler/PrismaSchedulerStore";
import { DEFAULT_TICK_MS, tick as schedulerTick } from "./scheduler/index";
import { PrismaRunStore } from "./store";
import { openRunWorkspace } from "./workspace/index";

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_MS ?? 1000);
const SCHEDULER_TICK_MS = Number(process.env.SCHEDULER_TICK_MS ?? DEFAULT_TICK_MS);

const prisma = new PrismaClient();
const store = new PrismaRunStore(prisma);
const board = new PrismaBoardStore(prisma);
const scheduler = new PrismaSchedulerStore(prisma);

/** Saved Agent Profiles, for nodes that reference one instead of inline config. */
async function loadProfiles(): Promise<ReadonlyMap<string, AgentProfileRecord>> {
  const rows = await prisma.agentProfile.findMany();
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        name: row.name,
        provider: row.provider,
        model: row.model,
        effort: row.effort,
        systemPrompt: row.systemPrompt,
        allowedTools: Array.isArray(row.allowedTools) ? (row.allowedTools as string[]) : [],
        maxTokens: row.maxTokens,
        version: row.version,
      },
    ]),
  );
}

/**
 * The credential THIS pipeline holds for a provider.
 *
 * Decrypted at the moment of use and handed straight to the runner: it is never
 * logged, never stored, and never read from our own environment.
 */
async function loadCredential(
  pipelineId: string,
  provider: string,
): Promise<AgentCredential | null> {
  const row = await prisma.providerCredential.findUnique({
    where: { pipelineId_provider: { pipelineId, provider } },
    select: { keyCipher: true, baseUrl: true },
  });
  if (!row) return null;

  const key = process.env.SECRETS_ENC_KEY;
  return {
    ...(row.keyCipher && key ? { apiKey: decryptSecret(row.keyCipher, key) } : {}),
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
  };
}

/**
 * The GitHub token, decrypted at the moment of use.
 *
 * Unlike the AI provider keys — which are per-pipeline and have no environment
 * fallback — GITHUB_TOKEN is a global integration secret, and `.env` is a
 * documented place to put it on a self-hosted box (docs/INTEGRATIONS.md).
 * The encrypted store wins when both are set.
 */
async function loadGitHubToken(): Promise<string | null> {
  return loadSecret("GITHUB_TOKEN");
}

const httpClient = new FetchHttpClient();

/**
 * A stored integration secret, decrypted at the moment of use.
 *
 * Same rule as the GitHub token: the encrypted store wins, and `.env` is a
 * documented fallback for a self-hosted box (docs/INTEGRATIONS.md).
 */
async function loadSecret(name: string): Promise<string | null> {
  const row = await prisma.secret.findUnique({ where: { name } });
  const key = process.env.SECRETS_ENC_KEY;

  if (row && key) return decryptSecret(row.ciphertext, key);
  return process.env[name] ?? null;
}

const github = createLazyGitHub({
  loadToken: loadGitHubToken,
  log: (message) => console.log(message),
});

const handlers = createHandlerRegistry({
  agent: {
    runners: createRunnerRegistry(),
    loadProfiles,
    loadCredential,
    log: async (runId, entry) => {
      await store.appendLog(runId, {
        level: entry.level,
        message: entry.message,
        nodeId: entry.nodeId,
      });
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
    // Opening a gate is idempotent: a resumed run re-enters the same node.
    openApproval: async (runId, nodeId) => {
      await prisma.runApproval.upsert({
        where: { runId_nodeId: { runId, nodeId } },
        create: { runId, nodeId, state: "pending" },
        update: {},
      });
    },
    log: async (runId, entry) => {
      await store.appendLog(runId, {
        level: entry.level,
        message: entry.message,
        nodeId: entry.nodeId,
      });
    },
  },
  http: {
    http: httpClient,
    loadSecret,
    log: async (runId, entry) => {
      await store.appendLog(runId, {
        level: entry.level,
        message: entry.message,
        nodeId: entry.nodeId,
      });
    },
  },
  deploy: {
    http: httpClient,
    loadSecret,
    log: async (runId, entry) => {
      await store.appendLog(runId, {
        level: entry.level,
        message: entry.message,
        nodeId: entry.nodeId,
      });
    },
  },
  condition: {
    log: async (runId, entry) => {
      await store.appendLog(runId, {
        level: entry.level,
        message: entry.message,
        nodeId: entry.nodeId,
      });
    },
  },
  github: {
    client: github.client,
    git: github.git,
    identity: {
      name: process.env.GIT_COMMIT_NAME ?? "AgentFlow",
      email: process.env.GIT_COMMIT_EMAIL ?? "agentflow@localhost",
    },
    log: async (runId, entry) => {
      await store.appendLog(runId, {
        level: entry.level,
        message: entry.message,
        nodeId: entry.nodeId,
      });
    },
  },
});

let stopping = false;
let nextSchedulerTick = 0;

/**
 * The scheduler shares the worker's loop rather than running its own timer.
 *
 * One process, one clock, and a tick that cannot overlap itself — which is what
 * keeps "exactly once per slot" true even when a tick runs long.
 */
async function runSchedulerIfDue(): Promise<void> {
  const now = Date.now();
  if (now < nextSchedulerTick) return;
  nextSchedulerTick = now + SCHEDULER_TICK_MS;

  try {
    const result = await schedulerTick(
      { store: scheduler, log: (level, message) => console.log(`[scheduler:${level}] ${message}`) },
      new Date(now),
    );

    for (const problem of result.problems) {
      console.warn(`[scheduler] ${problem.id}: ${problem.message}`);
    }
  } catch (error) {
    // A scheduler failure must not stop the queue from draining.
    console.error("scheduler tick failed:", error);
  }
}

async function loop(): Promise<void> {
  while (!stopping) {
    try {
      await runSchedulerIfDue();

      // Drain the queue, then wait. One run at a time keeps ordering obvious
      // and the single-user machine responsive.
      const outcome = await runNextQueued({
        store,
        handlers,
        reconciler: createBoardReconciler(board),
        // A run parked at a gate keeps its workspace; only a finished run's is
        // removed, and the path is derived from the run id so a resume finds it.
        workspaceDir: (runId) => openRunWorkspace(runId).dir,
        cleanupWorkspace: (runId) => openRunWorkspace(runId).cleanup(),
      });
      if (outcome) {
        console.log(`run ${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}`);
        continue;
      }
    } catch (error) {
      // A failure in the loop itself must not kill the worker.
      console.error("worker loop error:", error);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function main(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
  console.log("worker ready");

  const shutdown = (signal: NodeJS.Signals) => {
    console.log(`worker stopping (${signal})`);
    stopping = true;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await loop();
}

main()
  .catch((error: unknown) => {
    console.error("worker failed to start:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
