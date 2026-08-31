/**
 * The model picker's catalogue.
 *
 * ⚠️ This is a list of SUGGESTIONS, never a default. Every agent node starts
 * with no provider and no model, and the pipeline is invalid until the user
 * picks both — see docs/AGENTS.md. Nothing here is pre-selected.
 *
 * Model ids are data, not logic: the engine stays provider-neutral, and a
 * provider whose models are not listed here can still be used by typing the
 * model id by hand.
 */

export interface ProviderDef {
  id: string;
  label: string;
  /** Local providers need only a base URL; hosted ones need an API key. */
  keyless: boolean;
  /** Known model ids. Empty means "type the model id yourself". */
  models: { id: string; label: string; note?: string }[];
  hint?: string;
}

export const PROVIDERS: readonly ProviderDef[] = [
  {
    id: "claude",
    label: "Claude (Anthropic)",
    keyless: false,
    hint: "Paste this pipeline's Anthropic API key in Connections.",
    models: [
      { id: "claude-opus-5", label: "Claude Opus 5", note: "Strongest for implementing" },
      { id: "claude-fable-5", label: "Claude Fable 5", note: "Most capable; costs more" },
      { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
      { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5", note: "Cheaper, still strong" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", note: "Cheapest; good for triage" },
    ],
  },
  {
    id: "ollama",
    label: "Ollama (local, free)",
    keyless: true,
    hint: "No key needed — just the address Ollama is listening on.",
    models: [
      { id: "qwen2.5-coder", label: "qwen2.5-coder" },
      { id: "llama3.1", label: "llama3.1" },
      { id: "deepseek-coder-v2", label: "deepseek-coder-v2" },
    ],
  },
  {
    id: "openai-compat",
    label: "OpenAI-compatible endpoint",
    keyless: false,
    hint: "Any provider exposing an OpenAI-compatible API. Type the model id.",
    models: [],
  },
];

export interface EffortLevel {
  id: string;
  label: string;
  note?: string;
}

/** Effort levels, cheapest first. Higher effort = deeper reasoning, more tokens. */
export const EFFORT_LEVELS: readonly EffortLevel[] = [
  { id: "low", label: "low", note: "Triage and classification" },
  { id: "medium", label: "medium" },
  { id: "high", label: "high", note: "Default" },
  { id: "xhigh", label: "xhigh", note: "Best for hard coding work" },
  { id: "max", label: "max", note: "When correctness beats cost" },
];

/** The built-in tools an agent may be granted. Read-only roles get none of the writers. */
export const AGENT_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "Bash"];

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

export function modelsFor(providerId: string): { id: string; label: string; note?: string }[] {
  return getProvider(providerId)?.models ?? [];
}
