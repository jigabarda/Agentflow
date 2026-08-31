import type {
  AgentEvents,
  AgentRunRequest,
  AgentRunResult,
  AgentRunner,
  AgentToolCall,
} from "./AgentRunner";
import { AgentRunFailure } from "./AgentRunner";

/**
 * The mock agent runner.
 *
 * Records every request so a test can assert what the user's configuration
 * actually produced — above all, that the model chosen on THIS node is the one
 * that would have been called. Spends nothing and touches nothing.
 */
export interface MockScript {
  result?: string;
  filesChanged?: string[];
  tokens?: number;
  /** Tool calls to pretend the agent attempted, including denied ones. */
  toolCalls?: AgentToolCall[];
  /** Make the run fail, as a real agent failure would. */
  failWith?: string;
}

export class MockAgentRunner implements AgentRunner {
  readonly requests: AgentRunRequest[] = [];

  constructor(private script: MockScript = {}) {}

  setScript(script: MockScript): void {
    this.script = script;
  }

  /** The request most recently received — the common assertion target. */
  get lastRequest(): AgentRunRequest | undefined {
    return this.requests.at(-1);
  }

  async run(request: AgentRunRequest, events: AgentEvents): Promise<AgentRunResult> {
    this.requests.push(request);

    events.onLog("info", `agent: ${request.provider}/${request.model} in ${request.workspaceDir}`);

    for (const call of this.script.toolCalls ?? []) {
      events.onLog(
        call.allowed ? "debug" : "warn",
        call.allowed
          ? `tool ${call.name} allowed`
          : `tool ${call.name} DENIED — ${call.reason ?? "not permitted"}`,
      );
    }

    if (this.script.failWith) throw new AgentRunFailure(this.script.failWith);

    return {
      result: this.script.result ?? "done",
      filesChanged: this.script.filesChanged ?? [],
      usage: { tokens: this.script.tokens ?? 0 },
      toolCalls: this.script.toolCalls ?? [],
    };
  }
}
