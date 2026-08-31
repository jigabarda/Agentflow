/**
 * Pre-run readiness — pure.
 *
 * A pipeline cannot run until every provider its agent nodes name has a
 * credential ON THAT PIPELINE: an API key for hosted providers, or just a base
 * URL for keyless local ones (Ollama). Keys are never global env vars.
 * See docs/AGENTS.md and docs/SECURITY.md.
 */
import { AGENT_NODE_TYPE, resolveAgentModel, validateGraph } from "./graph";
import type { AgentModelChoice, Pipeline } from "./types";

/** Providers that run locally and need only an address, never a key. */
export const KEYLESS_PROVIDERS: readonly string[] = ["ollama"];

export interface CredentialState {
  provider: string;
  /** True when an encrypted key is stored for this provider on this pipeline. */
  hasKey: boolean;
  baseUrl?: string | null;
}

export type ReadinessProblemCode =
  "invalid-graph" | "missing-provider-key" | "missing-provider-base-url";

export interface ReadinessProblem {
  code: ReadinessProblemCode;
  message: string;
  provider?: string;
}

export interface RunReadiness {
  ready: boolean;
  problems: ReadinessProblem[];
  /** Every distinct provider this pipeline's agent nodes would call. */
  providersUsed: string[];
}

export function providersUsedBy(
  pipeline: Pick<Pipeline, "nodes">,
  profiles: ReadonlyMap<string, AgentModelChoice> = new Map(),
): string[] {
  const providers = new Set<string>();
  for (const node of pipeline.nodes) {
    if (node.type !== AGENT_NODE_TYPE) continue;
    const choice = resolveAgentModel(node, profiles);
    if (choice) providers.add(choice.provider);
  }
  return [...providers];
}

export function checkRunReadiness(
  pipeline: Pick<Pipeline, "nodes" | "edges">,
  credentials: readonly CredentialState[],
  profiles: ReadonlyMap<string, AgentModelChoice> = new Map(),
): RunReadiness {
  const problems: ReadinessProblem[] = [];

  const graph = validateGraph(pipeline, profiles);
  if (!graph.valid) {
    problems.push({
      code: "invalid-graph",
      message: `The pipeline is invalid: ${graph.issues[0]!.message}`,
    });
  }

  const providersUsed = providersUsedBy(pipeline, profiles);
  const byProvider = new Map(credentials.map((c) => [c.provider, c]));

  for (const provider of providersUsed) {
    const credential = byProvider.get(provider);
    const keyless = KEYLESS_PROVIDERS.includes(provider);

    if (keyless) {
      if (!credential?.baseUrl) {
        problems.push({
          code: "missing-provider-base-url",
          message: `Set a base URL for "${provider}" on this pipeline before running.`,
          provider,
        });
      }
      continue;
    }

    if (!credential?.hasKey) {
      problems.push({
        code: "missing-provider-key",
        message: `Add an API key for "${provider}" on this pipeline before running.`,
        provider,
      });
    }
  }

  return { ready: problems.length === 0, problems, providersUsed };
}
