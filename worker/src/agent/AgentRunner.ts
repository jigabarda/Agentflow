/**
 * The boundary between AgentFlow and whatever actually runs an agent.
 *
 * Everything the model needs arrives as DATA — provider, model, effort, tools,
 * and the credential — so the engine stays provider-neutral and tests can inject
 * a mock that spends no tokens and touches no network (docs/TESTING.md).
 */

export interface AgentCredential {
  /** Hosted providers. Decrypted in memory at call time; never logged. */
  apiKey?: string;
  /** Local providers (Ollama) need only an address. */
  baseUrl?: string;
}

export interface AgentRunRequest {
  /** REQUIRED. There is no default — see docs/AGENTS.md. */
  provider: string;
  /** REQUIRED. There is no default. */
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  systemPrompt?: string;
  /** The task the agent is being asked to do, already interpolated. */
  prompt: string;
  /** Tools this agent may use. Anything not listed is denied. */
  allowedTools: string[];
  /** Per-node cost guard. */
  maxTokens?: number;
  /** The agent may read and write only inside this directory. */
  workspaceDir: string;
  credential: AgentCredential;
}

export interface AgentToolCall {
  name: string;
  allowed: boolean;
  /** Why it was denied, when it was. */
  reason?: string;
  /** The workspace-relative path a file tool touched, when it touched one. */
  path?: string;
}

export interface AgentRunResult {
  result: string;
  filesChanged?: string[];
  usage: { tokens: number; costUsd?: number };
  /** Every tool call the agent attempted, allowed or not — for the audit log. */
  toolCalls: AgentToolCall[];
}

/** How the runner reports progress while it works. */
export interface AgentEvents {
  onLog: (level: "debug" | "info" | "warn" | "error", message: string) => void;
}

export interface AgentRunner {
  run(request: AgentRunRequest, events: AgentEvents): Promise<AgentRunResult>;
}

/** A failure from the agent itself, worth showing the user verbatim. */
export class AgentRunFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRunFailure";
  }
}
