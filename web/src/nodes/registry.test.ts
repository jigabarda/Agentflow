import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AGENT_NODE_TYPE, TRIGGER_NODE_TYPES } from "@agentflow/core";
import { NODE_TYPES, defaultConfigFor, getNodeType, nodeTypesByCategory } from "./registry";
import { PROVIDERS, modelsFor } from "./models";

describe("the node registry", () => {
  it("has unique node-type ids", () => {
    const ids = NODE_TYPES.map((type) => type.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses kebab-case ids, matching the worker's handler registry keys", () => {
    for (const type of NODE_TYPES) {
      expect(type.id).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    }
  });

  it("gives every node type a Zod object config schema", () => {
    for (const type of NODE_TYPES) {
      expect(type.configSchema).toBeInstanceOf(z.ZodObject);
      expect(type.configSchema.safeParse({})).toBeDefined();
    }
  });

  it("gives every node type a label and a one-line description", () => {
    for (const type of NODE_TYPES) {
      expect(type.label.length).toBeGreaterThan(0);
      expect(type.description.length).toBeGreaterThan(0);
    }
  });

  it("declares every trigger type the graph validator knows about", () => {
    const registryTriggers = NODE_TYPES.filter((t) => t.category === "trigger").map((t) => t.id);
    expect(registryTriggers.sort()).toEqual([...TRIGGER_NODE_TYPES].sort());
  });

  it("includes the agent node type the validator's model rule keys off", () => {
    expect(getNodeType(AGENT_NODE_TYPE)).toBeDefined();
  });

  it("covers every MVP node in the docs' tier table", () => {
    const mvp = NODE_TYPES.filter((type) => type.phase === "mvp").map((type) => type.id);
    for (const required of [
      "task-trigger",
      "manual-trigger",
      "github-issue-trigger",
      "echo",
      "agent",
      "update-task",
      "create-task",
      "require-approval",
      "read-issue",
      "clone-repo",
      "create-branch",
      "commit-changes",
      "open-pr",
    ]) {
      expect(mvp).toContain(required);
    }
  });

  it("groups types into categories for the palette", () => {
    const grouped = nodeTypesByCategory();
    expect(grouped.get("trigger")?.length).toBeGreaterThan(0);
    expect(grouped.get("agent")?.length).toBeGreaterThan(0);
    expect([...grouped.values()].flat()).toHaveLength(NODE_TYPES.length);
  });

  it("returns undefined for an unknown id rather than throwing", () => {
    expect(getNodeType("no-such-node")).toBeUndefined();
  });
});

describe("defaultConfigFor", () => {
  it("applies the schema's defaults", () => {
    expect(defaultConfigFor("open-pr")).toMatchObject({ base: "main" });
    expect(defaultConfigFor("merge-pr")).toMatchObject({ method: "squash" });
  });

  it("NEVER invents a provider or model for an agent node", () => {
    const config = defaultConfigFor("agent");
    expect(config.provider).toBeUndefined();
    expect(config.model).toBeUndefined();
  });

  it("returns an empty config for an unknown node type", () => {
    expect(defaultConfigFor("no-such-node")).toEqual({});
  });
});

describe("the model catalogue", () => {
  it("offers no model until a provider is chosen", () => {
    expect(modelsFor("")).toEqual([]);
  });

  it("lists Claude models for the claude provider", () => {
    const ids = modelsFor("claude").map((model) => model.id);
    expect(ids).toContain("claude-opus-5");
    expect(ids).toContain("claude-haiku-4-5");
  });

  it("marks local providers as keyless so the UI asks for a URL, not a key", () => {
    expect(PROVIDERS.find((p) => p.id === "ollama")?.keyless).toBe(true);
    expect(PROVIDERS.find((p) => p.id === "claude")?.keyless).toBe(false);
  });

  it("allows a provider with no listed models — the user types the id", () => {
    expect(modelsFor("openai-compat")).toEqual([]);
  });
});
