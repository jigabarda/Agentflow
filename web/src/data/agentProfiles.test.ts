// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { resolveAgentModel } from "@agentflow/core";
import {
  agentProfileChoices,
  createAgentProfile,
  deleteAgentProfile,
  getAgentProfile,
  listAgentProfiles,
  updateAgentProfile,
} from "./agentProfiles";
import { resetDatabase } from "./testing";

beforeEach(resetDatabase);

const base = {
  name: "Senior implementer",
  provider: "claude",
  model: "claude-opus-5",
  systemPrompt: "You are a senior engineer.",
};

describe("agent profile CRUD", () => {
  it("creates a profile and reads it back", async () => {
    const created = await createAgentProfile({ ...base, effort: "xhigh", allowedTools: ["Read"] });

    const loaded = await getAgentProfile(created.id);
    expect(loaded?.name).toBe("Senior implementer");
    expect(loaded?.model).toBe("claude-opus-5");
    expect(loaded?.effort).toBe("xhigh");
    expect(loaded?.allowedTools).toEqual(["Read"]);
    expect(loaded?.version).toBe(1);
  });

  it("defaults effort to high but never defaults the model", async () => {
    const created = await createAgentProfile(base);
    expect(created.effort).toBe("high");

    await expect(createAgentProfile({ ...base, model: "" })).rejects.toThrow();
    await expect(
      createAgentProfile({ name: "No model", provider: "claude", systemPrompt: "" } as never),
    ).rejects.toThrow();
  });

  it("bumps the version on every edit so in-flight runs stay stable", async () => {
    const created = await createAgentProfile(base);

    const once = await updateAgentProfile(created.id, { model: "claude-haiku-4-5" });
    expect(once.version).toBe(2);
    expect(once.model).toBe("claude-haiku-4-5");

    const twice = await updateAgentProfile(created.id, { effort: "low" });
    expect(twice.version).toBe(3);
    // The earlier edit is still in place.
    expect(twice.model).toBe("claude-haiku-4-5");
  });

  it("lists profiles by name", async () => {
    await createAgentProfile({ ...base, name: "Zeta" });
    await createAgentProfile({ ...base, name: "Alpha" });
    expect((await listAgentProfiles()).map((p) => p.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("deletes a profile", async () => {
    const created = await createAgentProfile(base);
    await deleteAgentProfile(created.id);
    expect(await getAgentProfile(created.id)).toBeNull();
  });
});

describe("resolving a node's effective model from a profile", () => {
  it("gives the graph validator what it needs to resolve a profile reference", async () => {
    const created = await createAgentProfile(base);
    const choices = await agentProfileChoices();

    expect(choices.get(created.id)).toEqual({ provider: "claude", model: "claude-opus-5" });
    expect(resolveAgentModel({ config: { agentProfileId: created.id } }, choices)).toEqual({
      provider: "claude",
      model: "claude-opus-5",
    });
  });

  it("lets a per-node choice override the profile's model", async () => {
    const created = await createAgentProfile(base);
    const choices = await agentProfileChoices();

    // This is exactly what the editor writes when you change the model on one node.
    const effective = resolveAgentModel(
      { config: { agentProfileId: created.id, model: "claude-haiku-4-5" } },
      choices,
    );
    expect(effective).toEqual({ provider: "claude", model: "claude-haiku-4-5" });
  });

  it("resolves nothing for a profile that was deleted", async () => {
    const created = await createAgentProfile(base);
    await deleteAgentProfile(created.id);

    const choices = await agentProfileChoices();
    expect(resolveAgentModel({ config: { agentProfileId: created.id } }, choices)).toBeNull();
  });
});
