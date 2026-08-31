// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { checkRunReadiness } from "@agentflow/core";
import type { PipelineNode } from "@agentflow/core";
import { prisma } from "./client";
import { createPipeline } from "./pipelines";
import {
  deleteProviderCredential,
  deleteSecret,
  getProviderApiKey,
  getSecret,
  listCredentialStates,
  listSecretNames,
  setProviderCredential,
  setSecret,
} from "./secrets";
import { resetDatabase } from "./testing";

beforeEach(resetDatabase);

const GITHUB_TOKEN = "ghp_averyrealisticlookinggithubtoken000000";
const ANTHROPIC_KEY = "sk-ant-api03-notarealkey-0000000000000000";

function node(id: string, type: string, config: Record<string, unknown> = {}): PipelineNode {
  return { id, type, label: id, config, x: 0, y: 0 };
}

describe("global secrets", () => {
  it("round-trips a token", async () => {
    await setSecret("GITHUB_TOKEN", GITHUB_TOKEN);
    expect(await getSecret("GITHUB_TOKEN")).toBe(GITHUB_TOKEN);
  });

  it("stores CIPHERTEXT — the plaintext is never in the row", async () => {
    await setSecret("GITHUB_TOKEN", GITHUB_TOKEN);

    const row = await prisma.secret.findUnique({ where: { name: "GITHUB_TOKEN" } });
    expect(row?.ciphertext).toBeTruthy();
    expect(row!.ciphertext).not.toContain(GITHUB_TOKEN);
    expect(JSON.stringify(row)).not.toContain(GITHUB_TOKEN);
  });

  it("re-encrypts on rotation and never reuses a ciphertext", async () => {
    await setSecret("GITHUB_TOKEN", GITHUB_TOKEN);
    const first = (await prisma.secret.findUnique({ where: { name: "GITHUB_TOKEN" } }))!.ciphertext;

    await setSecret("GITHUB_TOKEN", `${GITHUB_TOKEN}-rotated`);
    const second = (await prisma.secret.findUnique({ where: { name: "GITHUB_TOKEN" } }))!
      .ciphertext;

    expect(second).not.toBe(first);
    expect(await getSecret("GITHUB_TOKEN")).toBe(`${GITHUB_TOKEN}-rotated`);
  });

  it("lists names without exposing values", async () => {
    await setSecret("GITHUB_TOKEN", GITHUB_TOKEN);
    await setSecret("VERCEL_TOKEN", "vercel-xyz-123456");

    const names = await listSecretNames();
    expect(names).toEqual(["GITHUB_TOKEN", "VERCEL_TOKEN"]);
    expect(JSON.stringify(names)).not.toContain(GITHUB_TOKEN);
  });

  it("returns null for a secret that was never set", async () => {
    expect(await getSecret("NOPE")).toBeNull();
  });

  it("deletes a secret", async () => {
    await setSecret("GITHUB_TOKEN", GITHUB_TOKEN);
    await deleteSecret("GITHUB_TOKEN");
    expect(await getSecret("GITHUB_TOKEN")).toBeNull();
  });
});

describe("per-pipeline provider credentials", () => {
  it("stores an AI key as ciphertext, scoped to its pipeline", async () => {
    const pipeline = await createPipeline({ name: "P" });
    await setProviderCredential({
      pipelineId: pipeline.id,
      provider: "claude",
      apiKey: ANTHROPIC_KEY,
      label: "My Anthropic key",
    });

    const row = await prisma.providerCredential.findFirst({ where: { pipelineId: pipeline.id } });
    expect(row?.keyCipher).not.toContain(ANTHROPIC_KEY);
    expect(await getProviderApiKey(pipeline.id, "claude")).toBe(ANTHROPIC_KEY);
  });

  it("keeps each pipeline's key separate — one pipeline cannot read another's", async () => {
    const a = await createPipeline({ name: "A" });
    const b = await createPipeline({ name: "B" });

    await setProviderCredential({ pipelineId: a.id, provider: "claude", apiKey: ANTHROPIC_KEY });

    expect(await getProviderApiKey(a.id, "claude")).toBe(ANTHROPIC_KEY);
    expect(await getProviderApiKey(b.id, "claude")).toBeNull();
  });

  it("allows one credential per provider per pipeline, and updates in place", async () => {
    const pipeline = await createPipeline({ name: "P" });
    await setProviderCredential({ pipelineId: pipeline.id, provider: "claude", apiKey: "key-one" });
    await setProviderCredential({ pipelineId: pipeline.id, provider: "claude", apiKey: "key-two" });

    const rows = await prisma.providerCredential.findMany({ where: { pipelineId: pipeline.id } });
    expect(rows).toHaveLength(1);
    expect(await getProviderApiKey(pipeline.id, "claude")).toBe("key-two");
  });

  it("keeps the stored key when a re-save omits it (the UI masks it after save)", async () => {
    const pipeline = await createPipeline({ name: "P" });
    await setProviderCredential({
      pipelineId: pipeline.id,
      provider: "claude",
      apiKey: ANTHROPIC_KEY,
    });
    await setProviderCredential({ pipelineId: pipeline.id, provider: "claude", label: "Renamed" });

    expect(await getProviderApiKey(pipeline.id, "claude")).toBe(ANTHROPIC_KEY);
  });

  it("stores a keyless local provider with only a base URL", async () => {
    const pipeline = await createPipeline({ name: "P" });
    await setProviderCredential({
      pipelineId: pipeline.id,
      provider: "ollama",
      baseUrl: "http://localhost:11434",
    });

    expect(await getProviderApiKey(pipeline.id, "ollama")).toBeNull();
    expect(await listCredentialStates(pipeline.id)).toEqual([
      { provider: "ollama", hasKey: false, baseUrl: "http://localhost:11434" },
    ]);
  });

  it("reports credential state without decrypting anything", async () => {
    const pipeline = await createPipeline({ name: "P" });
    await setProviderCredential({
      pipelineId: pipeline.id,
      provider: "claude",
      apiKey: ANTHROPIC_KEY,
    });

    const states = await listCredentialStates(pipeline.id);
    expect(states).toEqual([{ provider: "claude", hasKey: true, baseUrl: null }]);
    expect(JSON.stringify(states)).not.toContain(ANTHROPIC_KEY);
  });

  it("deletes a credential", async () => {
    const pipeline = await createPipeline({ name: "P" });
    await setProviderCredential({
      pipelineId: pipeline.id,
      provider: "claude",
      apiKey: ANTHROPIC_KEY,
    });
    await deleteProviderCredential(pipeline.id, "claude");
    expect(await listCredentialStates(pipeline.id)).toEqual([]);
  });

  it("removes credentials along with the pipeline", async () => {
    const pipeline = await createPipeline({ name: "P" });
    await setProviderCredential({
      pipelineId: pipeline.id,
      provider: "claude",
      apiKey: ANTHROPIC_KEY,
    });

    const { deletePipeline } = await import("./pipelines");
    await deletePipeline(pipeline.id);

    expect(await prisma.providerCredential.count()).toBe(0);
  });
});

describe("pre-run readiness against real stored credentials", () => {
  const graph = {
    name: "Mixed models",
    nodes: [
      node("t", "task-trigger"),
      node("triage", "agent", { provider: "ollama", model: "qwen2.5-coder" }),
      node("impl", "agent", { provider: "claude", model: "claude-opus-4-8" }),
    ],
    edges: [
      { id: "e1", source: "t", target: "triage" },
      { id: "e2", source: "triage", target: "impl" },
    ],
  };

  it("flags a pipeline as un-runnable while a provider it uses has no key", async () => {
    const pipeline = await createPipeline(graph);
    await setProviderCredential({
      pipelineId: pipeline.id,
      provider: "ollama",
      baseUrl: "http://localhost:11434",
    });

    const readiness = checkRunReadiness(graph, await listCredentialStates(pipeline.id));
    expect(readiness.ready).toBe(false);
    expect(readiness.problems.map((p) => p.provider)).toContain("claude");
  });

  it("becomes runnable once every provider is configured", async () => {
    const pipeline = await createPipeline(graph);
    await setProviderCredential({
      pipelineId: pipeline.id,
      provider: "ollama",
      baseUrl: "http://localhost:11434",
    });
    await setProviderCredential({
      pipelineId: pipeline.id,
      provider: "claude",
      apiKey: ANTHROPIC_KEY,
    });

    const readiness = checkRunReadiness(graph, await listCredentialStates(pipeline.id));
    expect(readiness.ready).toBe(true);
  });
});
