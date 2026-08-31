import { interpolate } from "@agentflow/core";
import type { RunContext } from "@agentflow/core";
import type { AgentCredential, AgentRunner } from "../agent/AgentRunner";
import type { AgentNodeConfig, AgentProfileRecord } from "../agent/config";
import { requireCredential, resolveEffectiveAgentConfig } from "../agent/config";
import { selectRunner, type ProviderRunner } from "../agent/registry";
import type { NodeHandler, NodeInfo } from "./types";

/**
 * `agent` — the node that actually calls an AI.
 *
 * The order here is deliberate, and every step can refuse before a single
 * token is spent:
 *   1. resolve the effective config — provider and model REQUIRED, no default;
 *   2. resolve the credential from THIS pipeline — no environment fallback;
 *   3. pick the runner for that provider — no fallback to Claude.
 */

export interface AgentHandlerDeps {
  runners: ReadonlyMap<string, ProviderRunner>;
  /** Saved Agent Profiles, for nodes that reference one. */
  loadProfiles: () => Promise<ReadonlyMap<string, AgentProfileRecord>>;
  /** This pipeline's credential for a provider. Decrypted at the moment of use. */
  loadCredential: (pipelineId: string, provider: string) => Promise<AgentCredential | null>;
  /** Where the handler sends its log lines. */
  log: (
    runId: string,
    entry: { level: "debug" | "info" | "warn" | "error"; message: string; nodeId: string },
  ) => Promise<void>;
}

export interface AgentNodeOutput {
  result: string;
  filesChanged: string[];
  usage: { tokens: number; costUsd?: number };
}

export function createAgentHandler(
  deps: AgentHandlerDeps,
): NodeHandler<AgentNodeConfig, AgentNodeOutput> {
  return {
    type: "agent",

    async run(
      context: RunContext,
      config: AgentNodeConfig,
      node: NodeInfo,
    ): Promise<AgentNodeOutput> {
      const nodeId = node.id;

      // 1. What model did the user choose for THIS node?
      const effective = resolveEffectiveAgentConfig(nodeId, config, await deps.loadProfiles());

      // 2. Does this pipeline hold a credential for that provider?
      const credential = requireCredential(
        nodeId,
        effective.provider,
        await deps.loadCredential(context.pipelineId, effective.provider),
      );

      // 3. Which runner speaks to that provider?
      const runner: AgentRunner = selectRunner(deps.runners, nodeId, effective.provider);

      const prompt = buildTaskPrompt(context, config);

      await deps.log(context.runId, {
        level: "info",
        nodeId,
        // The model is worth stating: it is the user's choice and it costs money.
        message: `Running ${effective.provider}/${effective.model} (effort ${effective.effort}).`,
      });

      const result = await runner.run(
        {
          provider: effective.provider,
          model: effective.model,
          effort: effective.effort,
          systemPrompt: effective.systemPrompt,
          prompt,
          allowedTools: effective.allowedTools,
          ...(effective.maxTokens ? { maxTokens: effective.maxTokens } : {}),
          workspaceDir: context.workspaceDir,
          credential,
        },
        {
          onLog: (level, message) => {
            // Fire-and-forget: a log write must never stall the agent — and a
            // failed one must never take down the worker as an unhandled
            // rejection. Losing a log line is the acceptable outcome here.
            void deps.log(context.runId, { level, message, nodeId }).catch((error: unknown) => {
              console.error(`could not write a log line for run ${context.runId}:`, error);
            });
          },
        },
      );

      // Every tool call is auditable, allowed or denied (docs/SECURITY.md).
      for (const call of result.toolCalls) {
        await deps.log(context.runId, {
          level: call.allowed ? "debug" : "warn",
          nodeId,
          message: call.allowed
            ? `tool ${call.name} allowed`
            : `tool ${call.name} denied — ${call.reason ?? "not permitted"}`,
        });
      }

      await deps.log(context.runId, {
        level: "info",
        nodeId,
        message: `Agent finished. ${result.usage.tokens} tokens, ${result.toolCalls.length} tool call(s).`,
      });

      return {
        result: result.result,
        filesChanged: result.filesChanged ?? [],
        usage: result.usage,
      };
    },
  };
}

/**
 * What the agent is being asked to do.
 *
 * A board-triggered run has no separate instruction: the card's body IS the
 * brief (docs/BOARD.md), which is why the drawer labels it that way.
 */
function buildTaskPrompt(context: RunContext, config: AgentNodeConfig): string {
  const explicit = typeof config.prompt === "string" ? config.prompt.trim() : "";
  if (explicit) return explicit;

  const trigger = context.trigger as
    { task?: { title?: string; body?: string | null } } | undefined;
  const task = trigger?.task;
  if (task?.title) {
    return [task.title, task.body ?? ""].filter(Boolean).join("\n\n");
  }

  return interpolate("{{ trigger }}", { ...context, trigger: context.trigger ?? {} });
}
