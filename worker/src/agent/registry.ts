import { NodeFailure } from "../handlers/types";
import type { AgentRunner } from "./AgentRunner";
import { ClaudeAgentRunner } from "./ClaudeAgentRunner";
import { OpenAICompatibleRunner } from "./OpenAICompatibleRunner";

/**
 * Which runner executes a given provider.
 *
 * ⚠️ There is deliberately NO fallback. An unknown provider fails with a list
 * of what is available — it never quietly runs on Claude. AgentFlow is meant to
 * work for someone who has no Anthropic account at all: point a node at a local
 * Ollama model or a free hosted tier and it runs on that, end of story
 * (docs/AGENTS.md).
 */

export interface ProviderRunner {
  /** Provider id, as stored on the node and on the pipeline's credential. */
  provider: string;
  label: string;
  /** True when the provider needs only a base URL, no API key. */
  keyless: boolean;
  runner: AgentRunner;
}

export function createRunnerRegistry(
  overrides: Partial<Record<string, AgentRunner>> = {},
): Map<string, ProviderRunner> {
  // One shared instance: every OpenAI-compatible provider speaks the same
  // protocol, and they differ only in base URL, key, and model id — all data.
  const openAiCompatible = overrides["openai-compat"] ?? new OpenAICompatibleRunner();

  const entries: ProviderRunner[] = [
    {
      provider: "claude",
      label: "Claude (Anthropic)",
      keyless: false,
      runner: overrides.claude ?? new ClaudeAgentRunner(),
    },
    {
      provider: "ollama",
      label: "Ollama (local, free)",
      keyless: true,
      runner: overrides.ollama ?? openAiCompatible,
    },
    {
      provider: "openai-compat",
      label: "OpenAI-compatible endpoint",
      keyless: false,
      runner: openAiCompatible,
    },
  ];

  return new Map(entries.map((entry) => [entry.provider, entry]));
}

export function selectRunner(
  registry: ReadonlyMap<string, ProviderRunner>,
  nodeId: string,
  provider: string,
): AgentRunner {
  const entry = registry.get(provider);
  if (!entry) {
    const known = [...registry.keys()].join(", ");
    throw new NodeFailure(
      `Agent node "${nodeId}" names provider "${provider}", which AgentFlow has no runner for. Available: ${known}.`,
    );
  }
  return entry.runner;
}
