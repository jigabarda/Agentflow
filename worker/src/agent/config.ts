import { KEYLESS_PROVIDERS } from "@agentflow/core";
import { NodeFailure } from "../handlers/types";
import type { AgentCredential } from "./AgentRunner";

/**
 * Resolving an agent node's EFFECTIVE configuration — pure.
 *
 * A node either references a saved Agent Profile (optionally pinning a version
 * and overriding fields) or configures everything inline. Whatever the route,
 * `provider` and `model` must both come out of it: there is no default, and a
 * node without them must fail before anything is spent (docs/AGENTS.md).
 */

export interface AgentProfileRecord {
  id: string;
  name: string;
  provider: string;
  model: string;
  effort: string;
  systemPrompt: string;
  allowedTools: string[];
  maxTokens?: number | null;
  version: number;
}

export interface AgentNodeConfig {
  agentProfileId?: string;
  /** Pin the profile version so a later edit cannot change an in-flight run. */
  profileVersion?: number;
  overrides?: Partial<InlineAgentConfig>;
  [key: string]: unknown;
}

export interface InlineAgentConfig {
  provider?: string;
  model?: string;
  effort?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  maxTokens?: number;
}

export interface EffectiveAgentConfig {
  provider: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  systemPrompt: string;
  allowedTools: string[];
  maxTokens?: number;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

/** Effort MAY default; provider and model may not. */
const DEFAULT_EFFORT: Effort = "high";

function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return undefined;
}

export function resolveEffectiveAgentConfig(
  nodeId: string,
  config: AgentNodeConfig,
  profiles: ReadonlyMap<string, AgentProfileRecord>,
): EffectiveAgentConfig {
  const inline = config as InlineAgentConfig;
  const overrides = config.overrides ?? {};

  let profile: AgentProfileRecord | undefined;
  if (config.agentProfileId) {
    profile = profiles.get(config.agentProfileId);
    if (!profile) {
      throw new NodeFailure(
        `Agent node "${nodeId}" references an agent profile that no longer exists.`,
      );
    }
    // A pinned version that no longer matches means the profile was edited
    // after this node was configured. Refuse rather than silently run a
    // different agent than the one the user set up.
    if (config.profileVersion !== undefined && config.profileVersion !== profile.version) {
      throw new NodeFailure(
        `Agent node "${nodeId}" pins "${profile.name}" version ${config.profileVersion}, but the saved profile is now version ${profile.version}. Re-assign it to accept the change.`,
      );
    }
  }

  // Precedence: per-node override → inline config → the profile.
  const provider = firstString(overrides.provider, inline.provider, profile?.provider);
  const model = firstString(overrides.model, inline.model, profile?.model);

  if (!provider || !model) {
    throw new NodeFailure(
      `Agent node "${nodeId}" has no model set. Pick a provider and model before running — AgentFlow never chooses one for you.`,
    );
  }

  const effortValue = firstString(overrides.effort, inline.effort, profile?.effort);
  const effort = (EFFORTS as readonly string[]).includes(effortValue ?? "")
    ? (effortValue as Effort)
    : DEFAULT_EFFORT;

  const allowedTools = overrides.allowedTools ?? inline.allowedTools ?? profile?.allowedTools ?? [];

  const maxTokens = overrides.maxTokens ?? inline.maxTokens ?? profile?.maxTokens ?? undefined;

  return {
    provider,
    model,
    effort,
    systemPrompt:
      firstString(overrides.systemPrompt, inline.systemPrompt, profile?.systemPrompt) ?? "",
    allowedTools: [...allowedTools],
    ...(typeof maxTokens === "number" ? { maxTokens } : {}),
  };
}

/**
 * Check the credential this pipeline holds for the provider.
 *
 * Fails fast and says exactly what is missing. There is deliberately no
 * fallback to a global or environment key — a run must use the key the user
 * put on THIS pipeline, or not run at all (docs/SECURITY.md).
 */
export function requireCredential(
  nodeId: string,
  provider: string,
  credential: AgentCredential | null,
): AgentCredential {
  const keyless = KEYLESS_PROVIDERS.includes(provider);

  if (keyless) {
    if (!credential?.baseUrl) {
      throw new NodeFailure(
        `Agent node "${nodeId}" uses "${provider}", which needs a base URL on this pipeline. Add it in Connections.`,
      );
    }
    return { baseUrl: credential.baseUrl };
  }

  if (!credential?.apiKey) {
    throw new NodeFailure(
      `Agent node "${nodeId}" uses "${provider}", which has no API key on this pipeline. Add it in Connections — AgentFlow will not fall back to an environment key.`,
    );
  }

  return {
    apiKey: credential.apiKey,
    ...(credential.baseUrl ? { baseUrl: credential.baseUrl } : {}),
  };
}
