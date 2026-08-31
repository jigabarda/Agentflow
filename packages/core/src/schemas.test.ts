import { describe, expect, it } from "vitest";
import {
  agentProfileSchema,
  createTaskInputSchema,
  nodeTypeIdSchema,
  pipelineSchema,
  providerCredentialInputSchema,
  repoSlugSchema,
  taskEventActorSchema,
  taskSchema,
} from "./schemas";

describe("pipeline schemas", () => {
  it("parses a minimal valid pipeline", () => {
    const parsed = pipelineSchema.parse({ id: "p1", name: "First pipeline" });
    expect(parsed.nodes).toEqual([]);
    expect(parsed.edges).toEqual([]);
  });

  it("rejects a pipeline with no name", () => {
    expect(pipelineSchema.safeParse({ id: "p1", name: "" }).success).toBe(false);
  });

  it("rejects a malformed node", () => {
    const result = pipelineSchema.safeParse({
      id: "p1",
      name: "p",
      nodes: [{ id: "n1", type: "agent", label: "a", x: "left", y: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts kebab-case node-type ids and rejects the rest", () => {
    expect(nodeTypeIdSchema.parse("task-trigger")).toBe("task-trigger");
    expect(nodeTypeIdSchema.safeParse("TaskTrigger").success).toBe(false);
    expect(nodeTypeIdSchema.safeParse("open_pr").success).toBe(false);
    expect(nodeTypeIdSchema.safeParse("").success).toBe(false);
  });
});

describe("task schemas", () => {
  it("fills in the defaults a quick-add card relies on", () => {
    const task = taskSchema.parse({
      id: "t1",
      boardId: "b1",
      columnId: "c1",
      title: "Fix login redirect",
      order: 1000,
    });
    expect(task.priority).toBe("normal");
    expect(task.labels).toEqual([]);
    expect(task.blockedBy).toEqual([]);
  });

  it("requires a title — a card with no title is not a card", () => {
    const result = taskSchema.safeParse({
      id: "t1",
      boardId: "b1",
      columnId: "c1",
      title: "",
      order: 1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a title-only quick-add", () => {
    const parsed = createTaskInputSchema.parse({
      boardId: "b1",
      columnId: "c1",
      title: "Ship it",
    });
    expect(parsed.title).toBe("Ship it");
  });

  it('accepts "owner/name" repos and rejects URLs', () => {
    expect(repoSlugSchema.parse("acme/app")).toBe("acme/app");
    expect(repoSlugSchema.safeParse("https://github.com/acme/app").success).toBe(false);
    expect(repoSlugSchema.safeParse("acme").success).toBe(false);
  });

  it("accepts the four actor forms and rejects anything else", () => {
    for (const actor of ["user", "system", "github", "agent:impl"]) {
      expect(taskEventActorSchema.safeParse(actor).success).toBe(true);
    }
    expect(taskEventActorSchema.safeParse("robot").success).toBe(false);
  });
});

describe("agent + credential schemas", () => {
  it("refuses an agent profile with no model", () => {
    const base = { id: "a1", name: "Implementer", provider: "claude", systemPrompt: "" };
    expect(agentProfileSchema.safeParse({ ...base, model: "" }).success).toBe(false);
    expect(agentProfileSchema.safeParse(base).success).toBe(false);
  });

  it("defaults effort to high but never defaults the model", () => {
    const profile = agentProfileSchema.parse({
      id: "a1",
      name: "Implementer",
      provider: "claude",
      model: "claude-opus-4-8",
      systemPrompt: "",
    });
    expect(profile.effort).toBe("high");
  });

  it("accepts a credential with a key, or a base URL, but not neither", () => {
    const base = { pipelineId: "p1", provider: "claude" };
    expect(providerCredentialInputSchema.safeParse({ ...base, apiKey: "sk-x" }).success).toBe(true);
    expect(
      providerCredentialInputSchema.safeParse({
        pipelineId: "p1",
        provider: "ollama",
        baseUrl: "http://localhost:11434",
      }).success,
    ).toBe(true);
    expect(providerCredentialInputSchema.safeParse(base).success).toBe(false);
  });
});
