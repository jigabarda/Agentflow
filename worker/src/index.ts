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
import { runNextQueued } from "./engine/runner";
import { createHandlerRegistry } from "./handlers/index";
import { PrismaRunStore } from "./store";

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_MS ?? 1000);

const prisma = new PrismaClient();
const store = new PrismaRunStore(prisma);

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
});

let stopping = false;

async function loop(): Promise<void> {
  while (!stopping) {
    try {
      // Drain the queue, then wait. One run at a time keeps ordering obvious
      // and the single-user machine responsive.
      const outcome = await runNextQueued({ store, handlers });
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
