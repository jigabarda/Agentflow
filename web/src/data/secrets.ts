import { decryptSecret, encryptSecret } from "@agentflow/core/crypto";
import type { CredentialState } from "@agentflow/core";
import { prisma } from "./client";

/**
 * Secrets and per-pipeline provider keys.
 *
 * Both are stored as ciphertext only (AES-256-GCM). Plaintext exists in memory
 * for the moment it is used and never enters a log, a prompt, or an agent
 * workspace. Reads that only need to know *whether* a key exists use the
 * `...State` functions, which never decrypt anything. See docs/SECURITY.md.
 */

function encryptionKey(): string {
  const key = process.env.SECRETS_ENC_KEY;
  if (!key) {
    throw new Error(
      "SECRETS_ENC_KEY is not set. AgentFlow will not store secrets without it — see .env.example.",
    );
  }
  return key;
}

// ──────────────────────── global integration tokens ─────────────────────────

/** Store (or replace) an integration token such as GITHUB_TOKEN. */
export async function setSecret(name: string, plaintext: string): Promise<void> {
  const ciphertext = encryptSecret(plaintext, encryptionKey());
  await prisma.secret.upsert({
    where: { name },
    create: { name, ciphertext },
    update: { ciphertext },
  });
}

/** Decrypt a stored token. Call this at the moment of use, never earlier. */
export async function getSecret(name: string): Promise<string | null> {
  const row = await prisma.secret.findUnique({ where: { name } });
  if (!row) return null;
  return decryptSecret(row.ciphertext, encryptionKey());
}

/** Names only — safe for any UI listing. */
export async function listSecretNames(): Promise<string[]> {
  const rows = await prisma.secret.findMany({ select: { name: true }, orderBy: { name: "asc" } });
  return rows.map((row) => row.name);
}

export async function deleteSecret(name: string): Promise<void> {
  await prisma.secret.deleteMany({ where: { name } });
}

// ─────────────────── per-pipeline AI provider credentials ───────────────────

export interface SetProviderCredentialInput {
  pipelineId: string;
  provider: string;
  label?: string | null;
  /** Omit for keyless local providers (Ollama), which need only a base URL. */
  apiKey?: string | null;
  baseUrl?: string | null;
}

export async function setProviderCredential(input: SetProviderCredentialInput): Promise<void> {
  const keyCipher = input.apiKey ? encryptSecret(input.apiKey, encryptionKey()) : null;

  await prisma.providerCredential.upsert({
    where: {
      pipelineId_provider: { pipelineId: input.pipelineId, provider: input.provider },
    },
    create: {
      pipelineId: input.pipelineId,
      provider: input.provider,
      label: input.label ?? null,
      keyCipher,
      baseUrl: input.baseUrl ?? null,
    },
    update: {
      label: input.label ?? null,
      // A submit with no key keeps the stored one — the UI masks it after save.
      ...(keyCipher ? { keyCipher } : {}),
      baseUrl: input.baseUrl ?? null,
    },
  });
}

/**
 * The API key for one provider on one pipeline, decrypted.
 * The agent handler calls this at run time and hands the result straight to the
 * runner — it is never logged, never stored, never put in a prompt.
 */
export async function getProviderApiKey(
  pipelineId: string,
  provider: string,
): Promise<string | null> {
  const row = await prisma.providerCredential.findUnique({
    where: { pipelineId_provider: { pipelineId, provider } },
    select: { keyCipher: true },
  });
  if (!row?.keyCipher) return null;
  return decryptSecret(row.keyCipher, encryptionKey());
}

/**
 * What the readiness check and the editor need: which providers are configured
 * and whether each has a key — with no plaintext anywhere in the result.
 */
export async function listCredentialStates(pipelineId: string): Promise<CredentialState[]> {
  const rows = await prisma.providerCredential.findMany({
    where: { pipelineId },
    select: { provider: true, keyCipher: true, baseUrl: true },
  });
  return rows.map((row) => ({
    provider: row.provider,
    hasKey: row.keyCipher !== null,
    baseUrl: row.baseUrl,
  }));
}

export async function deleteProviderCredential(
  pipelineId: string,
  provider: string,
): Promise<void> {
  await prisma.providerCredential.deleteMany({ where: { pipelineId, provider } });
}
