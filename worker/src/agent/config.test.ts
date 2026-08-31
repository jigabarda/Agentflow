import { describe, expect, it } from "vitest";
import { NodeFailure } from "../handlers/types";
import { requireCredential, resolveEffectiveAgentConfig } from "./config";
import type { AgentProfileRecord } from "./config";

const profile: AgentProfileRecord = {
  id: "prof_1",
  name: "Senior implementer",
  provider: "claude",
  model: "claude-opus-5",
  effort: "xhigh",
  systemPrompt: "You are a senior engineer.",
  allowedTools: ["Read", "Write", "Edit"],
  maxTokens: 40000,
  version: 3,
};

const profiles = new Map([[profile.id, profile]]);

describe("resolving a node's effective agent config", () => {
  it("reads an inline configuration", () => {
    const effective = resolveEffectiveAgentConfig(
      "impl",
      { provider: "ollama", model: "qwen2.5-coder", effort: "low", allowedTools: ["Read"] },
      new Map(),
    );

    expect(effective).toMatchObject({
      provider: "ollama",
      model: "qwen2.5-coder",
      effort: "low",
      allowedTools: ["Read"],
    });
  });

  it("reads a referenced profile", () => {
    const effective = resolveEffectiveAgentConfig("impl", { agentProfileId: "prof_1" }, profiles);

    expect(effective.provider).toBe("claude");
    expect(effective.model).toBe("claude-opus-5");
    expect(effective.effort).toBe("xhigh");
    expect(effective.allowedTools).toEqual(["Read", "Write", "Edit"]);
    expect(effective.maxTokens).toBe(40000);
  });

  it("lets a per-node override beat the profile", () => {
    const effective = resolveEffectiveAgentConfig(
      "impl",
      { agentProfileId: "prof_1", overrides: { model: "claude-haiku-4-5", effort: "low" } },
      profiles,
    );

    expect(effective.model).toBe("claude-haiku-4-5");
    expect(effective.effort).toBe("low");
    // Everything not overridden still comes from the profile.
    expect(effective.systemPrompt).toBe("You are a senior engineer.");
  });

  it("lets a node switch provider entirely, away from the profile's", () => {
    const effective = resolveEffectiveAgentConfig(
      "impl",
      { agentProfileId: "prof_1", overrides: { provider: "ollama", model: "llama3.1" } },
      profiles,
    );

    expect(effective.provider).toBe("ollama");
    expect(effective.model).toBe("llama3.1");
  });

  it("honours a pinned profile version", () => {
    const effective = resolveEffectiveAgentConfig(
      "impl",
      { agentProfileId: "prof_1", profileVersion: 3 },
      profiles,
    );
    expect(effective.model).toBe("claude-opus-5");
  });

  it("refuses when the pinned version no longer matches the saved profile", () => {
    expect(() =>
      resolveEffectiveAgentConfig(
        "impl",
        { agentProfileId: "prof_1", profileVersion: 1 },
        profiles,
      ),
    ).toThrow(/version 1.*now version 3/s);
  });

  it("refuses when the referenced profile is gone", () => {
    expect(() =>
      resolveEffectiveAgentConfig("impl", { agentProfileId: "missing" }, profiles),
    ).toThrow(NodeFailure);
  });

  it("defaults effort to high, but never the model", () => {
    const effective = resolveEffectiveAgentConfig(
      "impl",
      { provider: "openai-compat", model: "gpt-oss-20b" },
      new Map(),
    );
    expect(effective.effort).toBe("high");
  });

  it("ignores an unrecognised effort rather than passing it on", () => {
    const effective = resolveEffectiveAgentConfig(
      "impl",
      { provider: "ollama", model: "llama3.1", effort: "turbo" },
      new Map(),
    );
    expect(effective.effort).toBe("high");
  });
});

describe("no model means no run — there is never a default", () => {
  it("fails when neither provider nor model is set", () => {
    expect(() => resolveEffectiveAgentConfig("impl", {}, new Map())).toThrow(/no model set/);
  });

  it("fails when only the provider is set", () => {
    expect(() => resolveEffectiveAgentConfig("impl", { provider: "claude" }, new Map())).toThrow(
      NodeFailure,
    );
  });

  it("fails when only the model is set", () => {
    expect(() => resolveEffectiveAgentConfig("impl", { model: "llama3.1" }, new Map())).toThrow(
      NodeFailure,
    );
  });

  it("treats a blank string as unset", () => {
    expect(() =>
      resolveEffectiveAgentConfig("impl", { provider: "ollama", model: "   " }, new Map()),
    ).toThrow(NodeFailure);
  });

  it("names the node so the user knows which one to fix", () => {
    expect(() => resolveEffectiveAgentConfig("triager", {}, new Map())).toThrow(/"triager"/);
  });
});

describe("credentials come from the pipeline, never the environment", () => {
  it("accepts a stored API key for a hosted provider", () => {
    expect(requireCredential("impl", "claude", { apiKey: "sk-ant-x" })).toEqual({
      apiKey: "sk-ant-x",
    });
  });

  it("fails when a hosted provider has no key on this pipeline", () => {
    expect(() => requireCredential("impl", "claude", null)).toThrow(/no API key on this pipeline/);
    expect(() => requireCredential("impl", "claude", { baseUrl: "http://x" })).toThrow(NodeFailure);
  });

  it("says plainly that it will not fall back to an environment key", () => {
    expect(() => requireCredential("impl", "openai-compat", null)).toThrow(/environment key/);
  });

  it("accepts a keyless local provider with only a base URL", () => {
    expect(requireCredential("impl", "ollama", { baseUrl: "http://localhost:11434/v1" })).toEqual({
      baseUrl: "http://localhost:11434/v1",
    });
  });

  it("fails a keyless provider that has no address", () => {
    expect(() => requireCredential("impl", "ollama", null)).toThrow(/needs a base URL/);
  });

  it("passes a base URL alongside a key when both are set", () => {
    expect(
      requireCredential("impl", "openai-compat", {
        apiKey: "k",
        baseUrl: "https://api.groq.com/openai/v1",
      }),
    ).toEqual({ apiKey: "k", baseUrl: "https://api.groq.com/openai/v1" });
  });
});
