import { readFileSync, readdirSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isInsideWorkspace } from "../workspace/index";
import type {
  AgentEvents,
  AgentRunRequest,
  AgentRunResult,
  AgentRunner,
  AgentToolCall,
} from "./AgentRunner";
import { AgentRunFailure } from "./AgentRunner";

/**
 * The runner for every provider that speaks the OpenAI-compatible chat API.
 *
 * This is what makes AgentFlow genuinely model-agnostic: Ollama and LM Studio
 * running locally for free, plus the many hosted free tiers (Groq, OpenRouter,
 * Together, DeepSeek, Mistral …) all expose `POST {baseUrl}/chat/completions`.
 * Point a node at one and it works — no Claude account required.
 *
 * A plain chat endpoint has no built-in tools, so the agent loop and the file
 * tools live HERE, confined to the run workspace exactly as the Claude runner's
 * are. Every tool call is audited and every path is checked.
 */

/** How many model→tool→model round trips before we stop. */
const DEFAULT_MAX_TURNS = 12;
const MAX_FILE_BYTES = 256 * 1024;

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatResponse {
  choices?: { message?: ChatMessage; finish_reason?: string }[];
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/** Our tool vocabulary, mapped from the node's allowlist. */
const TOOL_DEFINITIONS = {
  read_file: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file inside the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path relative to the workspace" } },
        required: ["path"],
      },
    },
  },
  write_file: {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a text file inside the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the workspace" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  list_files: {
    type: "function",
    function: {
      name: "list_files",
      description: "List files in a directory inside the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Defaults to the workspace root" } },
      },
    },
  },
} as const;

type ToolName = keyof typeof TOOL_DEFINITIONS;

/**
 * Translate the node's tool allowlist (written in the Claude vocabulary the
 * editor offers) into the tools this runner actually implements.
 */
export function toolsForAllowlist(allowedTools: readonly string[]): {
  tools: ToolName[];
  unsupported: string[];
} {
  const tools = new Set<ToolName>();
  const unsupported: string[] = [];

  for (const tool of allowedTools) {
    switch (tool) {
      case "Read":
        tools.add("read_file");
        break;
      case "Write":
      case "Edit":
        tools.add("write_file");
        break;
      case "Glob":
      case "Grep":
        tools.add("list_files");
        break;
      default:
        // Bash in particular: this runner has no sandbox to run it in, and
        // silently ignoring it would be worse than saying so.
        unsupported.push(tool);
    }
  }

  return { tools: [...tools], unsupported };
}

export class OpenAICompatibleRunner implements AgentRunner {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async run(request: AgentRunRequest, events: AgentEvents): Promise<AgentRunResult> {
    const baseUrl = request.credential.baseUrl?.replace(/\/+$/, "");
    if (!baseUrl) {
      throw new AgentRunFailure(
        `"${request.provider}" needs a base URL (for example http://localhost:11434/v1). Add it in Connections.`,
      );
    }

    const { tools, unsupported } = toolsForAllowlist(request.allowedTools);
    for (const tool of unsupported) {
      events.onLog(
        "warn",
        `tool ${tool} is not available on "${request.provider}" — this runner offers file tools only.`,
      );
    }

    const toolCalls: AgentToolCall[] = [];
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          request.systemPrompt,
          `You are working inside the directory ${request.workspaceDir}.`,
          "Use paths relative to it. You cannot read or write anything outside it.",
          "When the task is complete, reply with a short summary and no tool call.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      { role: "user", content: request.prompt },
    ];

    let tokens = 0;
    let finalText = "";

    for (let turn = 0; turn < DEFAULT_MAX_TURNS; turn++) {
      const response = await this.chat(baseUrl, request, messages, tools);
      tokens += response.usage?.total_tokens ?? 0;

      const message = response.choices?.[0]?.message;
      if (!message) {
        throw new AgentRunFailure(`"${request.provider}" returned no message.`);
      }

      messages.push(message);

      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        finalText = message.content ?? "";
        return {
          result: finalText,
          filesChanged: filesWritten(toolCalls),
          usage: { tokens },
          toolCalls,
        };
      }

      for (const call of calls) {
        const outcome = this.executeTool(request.workspaceDir, call, tools, events);
        toolCalls.push(outcome.audit);
        messages.push({ role: "tool", tool_call_id: call.id, content: outcome.content });
      }
    }

    throw new AgentRunFailure(
      `The agent did not finish within ${DEFAULT_MAX_TURNS} turns. Narrow the task, or raise the limit.`,
    );
  }

  private async chat(
    baseUrl: string,
    request: AgentRunRequest,
    messages: ChatMessage[],
    tools: ToolName[],
  ): Promise<ChatResponse> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // Local providers such as Ollama need no key at all.
    if (request.credential.apiKey) {
      headers.Authorization = `Bearer ${request.credential.apiKey}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: request.model,
          messages,
          ...(tools.length > 0
            ? { tools: tools.map((name) => TOOL_DEFINITIONS[name]), tool_choice: "auto" }
            : {}),
          ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        }),
      });
    } catch (error) {
      throw new AgentRunFailure(
        `Could not reach "${request.provider}" at ${baseUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new AgentRunFailure(
        `"${request.provider}" returned ${response.status}. ${detail.slice(0, 200)}`,
      );
    }

    const body = (await response.json()) as ChatResponse;
    if (body.error) throw new AgentRunFailure(`"${request.provider}": ${body.error.message}`);
    return body;
  }

  /** Run one tool call, confined to the workspace and audited either way. */
  private executeTool(
    workspaceDir: string,
    call: ToolCall,
    allowed: ToolName[],
    events: AgentEvents,
  ): { audit: AgentToolCall; content: string } {
    const name = call.function.name as ToolName;

    if (!allowed.includes(name)) {
      const reason = "not in this agent's tool allowlist";
      events.onLog("warn", `tool ${name} DENIED — ${reason}`);
      return { audit: { name, allowed: false, reason }, content: `Denied: ${reason}.` };
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    } catch {
      return {
        audit: { name, allowed: false, reason: "unparsable arguments" },
        content: "Denied: your tool arguments were not valid JSON.",
      };
    }

    const requested = typeof args.path === "string" ? args.path : ".";
    if (!isInsideWorkspace(workspaceDir, requested)) {
      const reason = `path outside the run workspace (${requested})`;
      events.onLog("warn", `tool ${name} DENIED — ${reason}`);
      return {
        audit: { name, allowed: false, reason },
        content: "Denied: that path is outside the workspace.",
      };
    }

    const target = path.resolve(workspaceDir, requested);
    events.onLog("debug", `tool ${name} ${requested}`);

    try {
      switch (name) {
        case "read_file": {
          const content = readFileSync(target, "utf8").slice(0, MAX_FILE_BYTES);
          return { audit: { name, allowed: true }, content };
        }
        case "write_file": {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, String(args.content ?? ""), "utf8");
          return {
            audit: { name, allowed: true, path: requested },
            content: `Wrote ${requested}.`,
          };
        }
        case "list_files": {
          const entries = readdirSync(
            statSync(target).isDirectory() ? target : path.dirname(target),
          );
          return { audit: { name, allowed: true }, content: entries.join("\n") || "(empty)" };
        }
      }
    } catch (error) {
      // A tool failing is information for the model, not a run failure.
      return {
        audit: { name, allowed: true },
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    return { audit: { name, allowed: false, reason: "unknown tool" }, content: "Unknown tool." };
  }
}

function filesWritten(calls: AgentToolCall[]): string[] {
  return [
    ...new Set(
      calls
        .filter((call) => call.allowed && call.name === "write_file" && call.path)
        .map((call) => call.path!),
    ),
  ];
}
