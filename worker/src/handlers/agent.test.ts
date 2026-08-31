import { beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "@agentflow/core";
import { MockAgentRunner } from "../agent/MockAgentRunner";
import { createRunnerRegistry } from "../agent/registry";
import type { AgentProfileRecord } from "../agent/config";
import { createAgentHandler, type AgentHandlerDeps } from "./agent";
import { NodeFailure, type NodeInfo } from "./types";

const node: NodeInfo = { id: "impl", type: "agent", label: "Implementer" };

const context: RunContext = {
  pipeline: { vars: {} },
  trigger: { task: { title: "Fix login redirect", body: "SSO sends users home" } },
  nodes: {},
  runId: "run_1",
  pipelineId: "pipe_1",
  workspaceDir: "/tmp/run_1",
};

const profile: AgentProfileRecord = {
  id: "prof_1",
  name: "Cheap triager",
  provider: "ollama",
  model: "qwen2.5-coder",
  effort: "low",
  systemPrompt: "Classify the task.",
  allowedTools: ["Read"],
  maxTokens: null,
  version: 1,
};

let mock: MockAgentRunner;
let logs: { level: string; message: string; nodeId: string }[];

function deps(overrides: Partial<AgentHandlerDeps> = {}): AgentHandlerDeps {
  return {
    runners: createRunnerRegistry({ claude: mock, ollama: mock, "openai-compat": mock }),
    loadProfiles: async () => new Map([[profile.id, profile]]),
    loadCredential: async () => ({
      apiKey: "sk-test-key-000",
      baseUrl: "http://localhost:11434/v1",
    }),
    log: async (_runId, entry) => {
      logs.push(entry);
    },
    ...overrides,
  };
}

beforeEach(() => {
  mock = new MockAgentRunner({ result: "done", tokens: 120 });
  logs = [];
});

describe("running an agent node", () => {
  it("returns the agent's result into the run context", async () => {
    const handler = createAgentHandler(deps());

    const output = await handler.run(context, { provider: "ollama", model: "llama3.1" }, node);

    expect(output.result).toBe("done");
    expect(output.usage.tokens).toBe(120);
  });

  it("passes the model chosen on THIS node through to the runner", async () => {
    const handler = createAgentHandler(deps());

    await handler.run(context, { provider: "claude", model: "claude-haiku-4-5" }, node);
    expect(mock.lastRequest?.model).toBe("claude-haiku-4-5");

    await handler.run(context, { provider: "claude", model: "claude-opus-5" }, node);
    expect(mock.lastRequest?.model).toBe("claude-opus-5");

    // Two nodes, two different models — per-node selection is real.
    expect(mock.requests.map((request) => request.model)).toEqual([
      "claude-haiku-4-5",
      "claude-opus-5",
    ]);
  });

  it("passes a free local model through just as readily as a hosted one", async () => {
    const handler = createAgentHandler(deps());

    await handler.run(context, { provider: "ollama", model: "qwen2.5-coder" }, node);

    expect(mock.lastRequest?.provider).toBe("ollama");
    expect(mock.lastRequest?.model).toBe("qwen2.5-coder");
    expect(mock.lastRequest?.credential.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("resolves a referenced profile, including its effort and tools", async () => {
    const handler = createAgentHandler(deps());

    await handler.run(context, { agentProfileId: "prof_1" }, node);

    expect(mock.lastRequest?.provider).toBe("ollama");
    expect(mock.lastRequest?.model).toBe("qwen2.5-coder");
    expect(mock.lastRequest?.effort).toBe("low");
    expect(mock.lastRequest?.allowedTools).toEqual(["Read"]);
  });

  it("uses the card as the brief when the node sets no prompt", async () => {
    const handler = createAgentHandler(deps());

    await handler.run(context, { provider: "ollama", model: "llama3.1" }, node);

    expect(mock.lastRequest?.prompt).toContain("Fix login redirect");
    expect(mock.lastRequest?.prompt).toContain("SSO sends users home");
  });

  it("prefers an explicit prompt on the node", async () => {
    const handler = createAgentHandler(deps());

    await handler.run(
      context,
      { provider: "ollama", model: "llama3.1", prompt: "Summarise the diff" },
      node,
    );

    expect(mock.lastRequest?.prompt).toBe("Summarise the diff");
  });

  it("runs the agent inside the run's workspace", async () => {
    const handler = createAgentHandler(deps());
    await handler.run(context, { provider: "ollama", model: "llama3.1" }, node);
    expect(mock.lastRequest?.workspaceDir).toBe("/tmp/run_1");
  });
});

describe("failing fast, before anything is spent", () => {
  it("refuses a node with no model, without calling any runner", async () => {
    const handler = createAgentHandler(deps());

    await expect(handler.run(context, {}, node)).rejects.toThrow(NodeFailure);
    expect(mock.requests).toHaveLength(0);
  });

  it("refuses when this pipeline has no credential for the provider", async () => {
    const handler = createAgentHandler(deps({ loadCredential: async () => null }));

    await expect(
      handler.run(context, { provider: "claude", model: "claude-opus-5" }, node),
    ).rejects.toThrow(/no API key on this pipeline/);
    expect(mock.requests).toHaveLength(0);
  });

  it("refuses an unknown provider rather than running it on Claude", async () => {
    const handler = createAgentHandler(deps());

    await expect(
      handler.run(context, { provider: "mystery-ai", model: "m" }, node),
    ).rejects.toThrow(/no runner for/);
    expect(mock.requests).toHaveLength(0);
  });

  it("surfaces an agent failure as the node's failure", async () => {
    mock.setScript({ failWith: "the model refused" });
    const handler = createAgentHandler(deps());

    await expect(
      handler.run(context, { provider: "ollama", model: "llama3.1" }, node),
    ).rejects.toThrow(/the model refused/);
  });
});

describe("auditing and secrecy", () => {
  it("logs every tool call, allowed and denied alike", async () => {
    mock.setScript({
      toolCalls: [
        { name: "read_file", allowed: true },
        { name: "write_file", allowed: false, reason: "path outside the run workspace" },
      ],
    });
    const handler = createAgentHandler(deps());

    await handler.run(context, { provider: "ollama", model: "llama3.1" }, node);

    const messages = logs.map((entry) => entry.message);
    expect(messages.some((message) => message.includes("tool read_file allowed"))).toBe(true);
    expect(messages.some((message) => message.includes("tool write_file denied"))).toBe(true);
    // A denial is a warning, not debug noise.
    expect(logs.find((entry) => entry.message.includes("denied"))?.level).toBe("warn");
  });

  it("handles a denied tool without failing the run", async () => {
    mock.setScript({
      result: "did what I could",
      toolCalls: [{ name: "write_file", allowed: false, reason: "outside the workspace" }],
    });
    const handler = createAgentHandler(deps());

    const output = await handler.run(context, { provider: "ollama", model: "llama3.1" }, node);
    expect(output.result).toBe("did what I could");
  });

  it("NEVER writes the API key into a log or the node's output", async () => {
    const secret = "sk-ant-super-secret-key-000000";
    const handler = createAgentHandler(deps({ loadCredential: async () => ({ apiKey: secret }) }));

    const output = await handler.run(context, { provider: "claude", model: "claude-opus-5" }, node);

    // The runner received it…
    expect(mock.lastRequest?.credential.apiKey).toBe(secret);
    // …and nothing else did.
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(JSON.stringify(output)).not.toContain(secret);
  });

  it("names the model in the log, since it is the user's choice and it costs", async () => {
    const handler = createAgentHandler(deps());
    await handler.run(context, { provider: "ollama", model: "qwen2.5-coder" }, node);

    expect(logs.some((entry) => entry.message.includes("ollama/qwen2.5-coder"))).toBe(true);
  });
});
