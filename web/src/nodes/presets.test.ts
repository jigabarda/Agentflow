import { describe, expect, it } from "vitest";
import { AGENT_ROLE_PRESETS, REVIEW_BRANCHES, getRolePreset, presetConfig } from "./presets";

/**
 * Role presets are a starting point, not a decision. The one rule that matters:
 * they must never choose a model for the user.
 */

describe("the crew", () => {
  it("offers the four roles", () => {
    expect(AGENT_ROLE_PRESETS.map((preset) => preset.id)).toEqual([
      "triager",
      "planner",
      "implementer",
      "reviewer",
    ]);
  });

  it("never carries a provider or a model", () => {
    for (const preset of AGENT_ROLE_PRESETS) {
      const config = presetConfig(preset);
      expect(config).not.toHaveProperty("provider");
      expect(config).not.toHaveProperty("model");
      expect(config).not.toHaveProperty("agentProfileId");
    }
  });

  it("gives every role a prompt and a system prompt", () => {
    for (const preset of AGENT_ROLE_PRESETS) {
      expect(preset.prompt.trim().length).toBeGreaterThan(0);
      expect(preset.systemPrompt.trim().length).toBeGreaterThan(0);
    }
  });

  it("lets only the implementer write files", () => {
    const writers = AGENT_ROLE_PRESETS.filter((preset) =>
      preset.allowedTools.some((tool) => tool === "Write" || tool === "Edit"),
    );
    expect(writers.map((preset) => preset.id)).toEqual(["implementer"]);
  });

  it("keeps the reviewer read-only — a reviewer that can edit is not one", () => {
    expect(getRolePreset("reviewer")?.allowedTools).toEqual(["Read", "Glob", "Grep"]);
  });

  it("gives the triager no tools at all", () => {
    expect(getRolePreset("triager")?.allowedTools).toEqual([]);
  });

  it("spends effort where the work is", () => {
    expect(getRolePreset("triager")?.suggestedEffort).toBe("low");
    expect(getRolePreset("implementer")?.suggestedEffort).toBe("xhigh");
  });

  it("asks the reviewer for a first word the condition node can route on", () => {
    const reviewer = getRolePreset("reviewer")!;
    for (const branch of REVIEW_BRANCHES) {
      expect(reviewer.prompt).toContain(branch);
    }
  });

  it("lists CHANGES before APPROVED, because the first match wins", () => {
    expect(REVIEW_BRANCHES).toEqual(["CHANGES", "APPROVED"]);
  });

  it("returns nothing for a role that does not exist", () => {
    expect(getRolePreset("architect")).toBeUndefined();
  });
});
