import { agentProfileSchema } from "@agentflow/core";
import type { AgentModelChoice } from "@agentflow/core";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./client";
import { toStringArray } from "./json";

/**
 * Agent Profiles — reusable agent definitions ("Senior implementer", "Cheap
 * triager") the user builds once and drops onto nodes.
 *
 * `provider` and `model` are required with no default, here as everywhere:
 * an agent that has not been given a model must not run. See docs/AGENTS.md.
 */

export type AgentProfile = z.infer<typeof agentProfileSchema>;

const createInputSchema = agentProfileSchema.omit({ id: true, version: true });
export type CreateAgentProfileInput = z.input<typeof createInputSchema>;

type ProfileRow = {
  id: string;
  name: string;
  provider: string;
  model: string;
  effort: string;
  systemPrompt: string;
  allowedTools: Prisma.JsonValue;
  maxTokens: number | null;
  version: number;
};

function toProfile(row: ProfileRow): AgentProfile {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    model: row.model,
    effort: row.effort as AgentProfile["effort"],
    systemPrompt: row.systemPrompt,
    allowedTools: toStringArray(row.allowedTools),
    maxTokens: row.maxTokens,
    version: row.version,
  };
}

export async function listAgentProfiles(): Promise<AgentProfile[]> {
  const rows = await prisma.agentProfile.findMany({ orderBy: { name: "asc" } });
  return rows.map(toProfile);
}

export async function getAgentProfile(id: string): Promise<AgentProfile | null> {
  const row = await prisma.agentProfile.findUnique({ where: { id } });
  return row ? toProfile(row) : null;
}

export async function createAgentProfile(input: CreateAgentProfileInput): Promise<AgentProfile> {
  const data = createInputSchema.parse(input);
  const row = await prisma.agentProfile.create({
    data: {
      name: data.name,
      provider: data.provider,
      model: data.model,
      effort: data.effort,
      systemPrompt: data.systemPrompt,
      allowedTools: data.allowedTools,
      maxTokens: data.maxTokens ?? null,
    },
  });
  return toProfile(row);
}

export async function updateAgentProfile(
  id: string,
  patch: Partial<CreateAgentProfileInput>,
): Promise<AgentProfile> {
  const data = createInputSchema.partial().parse(patch);

  const row = await prisma.agentProfile.update({
    where: { id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.provider !== undefined ? { provider: data.provider } : {}),
      ...(data.model !== undefined ? { model: data.model } : {}),
      ...(data.effort !== undefined ? { effort: data.effort } : {}),
      ...(data.systemPrompt !== undefined ? { systemPrompt: data.systemPrompt } : {}),
      ...(data.allowedTools !== undefined ? { allowedTools: data.allowedTools } : {}),
      ...(data.maxTokens !== undefined ? { maxTokens: data.maxTokens } : {}),
      // Bump on every edit so a node can pin the version it was built against
      // and an in-flight run is never changed underneath it.
      version: { increment: 1 },
    },
  });
  return toProfile(row);
}

export async function deleteAgentProfile(id: string): Promise<void> {
  await prisma.agentProfile.delete({ where: { id } });
}

/** What `validateGraph` needs to resolve an agent node's effective model. */
export async function agentProfileChoices(): Promise<Map<string, AgentModelChoice>> {
  const rows = await prisma.agentProfile.findMany({
    select: { id: true, provider: true, model: true },
  });
  return new Map(rows.map((row) => [row.id, { provider: row.provider, model: row.model }]));
}
