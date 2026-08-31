import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { isInsideWorkspace, pathsInToolInput } from "../workspace/index";
import type {
  AgentEvents,
  AgentRunRequest,
  AgentRunResult,
  AgentRunner,
  AgentToolCall,
} from "./AgentRunner";
import { AgentRunFailure } from "./AgentRunner";

/**
 * The real runner: the Claude Agent SDK.
 *
 * API verified against code.claude.com/docs/en/agent-sdk (Aug 2026):
 *   · `query({ prompt, options })` returns an async generator of SDK messages;
 *   · Options carry `model`, `effort`, `systemPrompt`, `allowedTools`,
 *     `disallowedTools`, `permissionMode`, `cwd`, `hooks`, `env`, `maxTurns`;
 *   · there is NO `apiKey` option — a key is supplied through `env`, which is
 *     exactly what we want: this pipeline's key, injected per call, never read
 *     from our own environment;
 *   · a `PreToolUse` hook runs before every other permission step and its deny
 *     applies in every mode — so it is the only correct place to both audit and
 *     gate every tool call.
 */

/** Tools the agent may never use, whatever the node's allowlist says. */
const ALWAYS_DENIED = [
  // Rewriting history or forcing a push is destructive and outward-facing;
  // outward actions belong to nodes, not to the agent (docs/SECURITY.md).
  "Bash(git push*)",
  "Bash(rm -rf /*)",
  "Bash(sudo *)",
  "Bash(curl *)",
  "Bash(wget *)",
];

export class ClaudeAgentRunner implements AgentRunner {
  async run(request: AgentRunRequest, events: AgentEvents): Promise<AgentRunResult> {
    const toolCalls: AgentToolCall[] = [];

    /**
     * Audit and confine every tool call.
     *
     * Runs before deny/ask/mode/allow evaluation, so nothing slips past it —
     * including tools the node's allowlist auto-approves.
     */
    const gate: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const pre = input as PreToolUseHookInput;

      const escaping = pathsInToolInput(pre.tool_input).filter(
        (candidate) => !isInsideWorkspace(request.workspaceDir, candidate),
      );

      if (escaping.length > 0) {
        const reason = `writes outside the run workspace (${escaping[0]})`;
        toolCalls.push({ name: pre.tool_name, allowed: false, reason });
        events.onLog("warn", `tool ${pre.tool_name} DENIED — ${reason}`);
        return {
          hookSpecificOutput: {
            hookEventName: pre.hook_event_name,
            permissionDecision: "deny",
            permissionDecisionReason: `AgentFlow confines agents to the run workspace.`,
          },
        };
      }

      toolCalls.push({ name: pre.tool_name, allowed: true });
      events.onLog("debug", `tool ${pre.tool_name}`);
      return {};
    };

    let result = "";
    let tokens = 0;
    let costUsd: number | undefined;

    try {
      for await (const message of query({
        prompt: buildPrompt(request),
        options: {
          model: request.model,
          effort: request.effort,
          systemPrompt: request.systemPrompt || undefined,
          // Listed tools are approved; `dontAsk` denies everything else outright
          // rather than prompting, which is what a headless agent needs.
          allowedTools: request.allowedTools,
          disallowedTools: ALWAYS_DENIED,
          permissionMode: "dontAsk",
          cwd: request.workspaceDir,
          hooks: { PreToolUse: [{ hooks: [gate] }] },
          // The key travels per call, from THIS pipeline's stored credential —
          // never from our own environment. The SDK exposes no `apiKey` option,
          // so `env` is the documented way to supply one.
          env: {
            ...process.env,
            ...(request.credential.apiKey ? { ANTHROPIC_API_KEY: request.credential.apiKey } : {}),
          },
        },
      })) {
        if (message.type === "assistant") {
          events.onLog("debug", "agent produced a message");
          continue;
        }

        if (message.type === "result") {
          const final = message as unknown as {
            subtype?: string;
            result?: string;
            is_error?: boolean;
            total_cost_usd?: number;
            usage?: { input_tokens?: number; output_tokens?: number };
          };

          result = final.result ?? "";
          costUsd = final.total_cost_usd;
          tokens = (final.usage?.input_tokens ?? 0) + (final.usage?.output_tokens ?? 0);

          if (final.is_error) {
            throw new AgentRunFailure(result || `agent stopped: ${final.subtype ?? "error"}`);
          }
        }
      }
    } catch (error) {
      if (error instanceof AgentRunFailure) throw error;
      // Never let a raw SDK error escape — it can carry environment detail.
      throw new AgentRunFailure(
        `The agent could not complete: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      result,
      usage: { tokens, ...(costUsd !== undefined ? { costUsd } : {}) },
      toolCalls,
    };
  }
}

/**
 * The task, with the workspace stated plainly.
 *
 * Untrusted content (a card body synced from an issue) is kept clearly separate
 * from the instruction, per docs/SECURITY.md principle 6.
 */
function buildPrompt(request: AgentRunRequest): string {
  return [
    request.prompt,
    "",
    `You are working inside ${request.workspaceDir}. Do not read or write outside it.`,
  ].join("\n");
}
