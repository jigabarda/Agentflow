import { describe, expect, it } from "vitest";
import { NodeFailure } from "../handlers/types";
import { MockAgentRunner } from "./MockAgentRunner";
import { OpenAICompatibleRunner } from "./OpenAICompatibleRunner";
import { ClaudeAgentRunner } from "./ClaudeAgentRunner";
import { createRunnerRegistry, selectRunner } from "./registry";

/**
 * AgentFlow must work for someone with no Anthropic account at all. These
 * tests are the guard on that promise.
 */
describe("choosing a runner by provider", () => {
  const registry = createRunnerRegistry();

  it("routes Claude to the Claude Agent SDK runner", () => {
    expect(selectRunner(registry, "impl", "claude")).toBeInstanceOf(ClaudeAgentRunner);
  });

  it("routes a local Ollama model to the OpenAI-compatible runner", () => {
    expect(selectRunner(registry, "impl", "ollama")).toBeInstanceOf(OpenAICompatibleRunner);
  });

  it("routes any OpenAI-compatible endpoint to that runner", () => {
    expect(selectRunner(registry, "impl", "openai-compat")).toBeInstanceOf(OpenAICompatibleRunner);
  });

  it("NEVER falls back to Claude for an unknown provider", () => {
    let caught: unknown;
    try {
      selectRunner(registry, "impl", "some-new-provider");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NodeFailure);
    // It says what IS available rather than quietly running on someone else's bill.
    expect((caught as Error).message).toContain("no runner for");
    expect((caught as Error).message).toContain("claude");
    expect((caught as Error).message).toContain("ollama");
  });

  it("marks local providers as keyless so no API key is demanded", () => {
    expect(registry.get("ollama")?.keyless).toBe(true);
    expect(registry.get("claude")?.keyless).toBe(false);
    expect(registry.get("openai-compat")?.keyless).toBe(false);
  });

  it("shares one OpenAI-compatible runner across the providers that speak it", () => {
    expect(registry.get("ollama")?.runner).toBe(registry.get("openai-compat")?.runner);
  });

  it("accepts an injected runner, so tests never touch a network", () => {
    const mock = new MockAgentRunner();
    const injected = createRunnerRegistry({ claude: mock, ollama: mock, "openai-compat": mock });
    expect(selectRunner(injected, "impl", "claude")).toBe(mock);
    expect(selectRunner(injected, "impl", "ollama")).toBe(mock);
  });
});
