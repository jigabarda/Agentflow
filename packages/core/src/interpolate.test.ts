import { describe, expect, it } from "vitest";
import {
  InterpolationError,
  interpolate,
  interpolateConfig,
  resolveTemplate,
  stringifyValue,
  templatePaths,
} from "./interpolate";
import type { RunContext } from "./types";

const context: RunContext = {
  pipeline: { vars: { repoUrl: "acme/app", baseBranch: "main" } },
  trigger: {
    task: { title: "Fix login redirect", body: "SSO sends users home", issueNumber: 12 },
    issue: { number: 12, title: "Login bug", labels: ["bug", "auth"] },
  },
  nodes: {
    planner: { output: { tasks: ["one", "two"], count: 2, done: true } },
    cloner: { output: { path: "/tmp/run/repo", headSha: "3f2a19c" } },
    empty: { output: { value: null } },
  },
  runId: "run_1",
  pipelineId: "pipe_1",
  workspaceDir: "/tmp/run",
};

describe("resolving documented paths", () => {
  it("resolves a pipeline variable", () => {
    expect(interpolate("{{ pipeline.vars.repoUrl }}", context)).toBe("acme/app");
  });

  it("resolves a trigger path", () => {
    expect(interpolate("{{ trigger.issue.title }}", context)).toBe("Login bug");
    expect(interpolate("{{ trigger.task.title }}", context)).toBe("Fix login redirect");
  });

  it("resolves another node's output", () => {
    expect(interpolate("{{ nodes.cloner.output.headSha }}", context)).toBe("3f2a19c");
  });

  it("tolerates any spacing inside the braces", () => {
    expect(interpolate("{{pipeline.vars.repoUrl}}", context)).toBe("acme/app");
    expect(interpolate("{{   pipeline.vars.repoUrl   }}", context)).toBe("acme/app");
  });
});

describe("stringification", () => {
  it("renders numbers and booleans", () => {
    expect(interpolate("{{ nodes.planner.output.count }}", context)).toBe("2");
    expect(interpolate("{{ nodes.planner.output.done }}", context)).toBe("true");
  });

  it("renders arrays and objects as JSON, predictably", () => {
    expect(interpolate("{{ nodes.planner.output.tasks }}", context)).toBe('["one","two"]');
    expect(interpolate("{{ trigger.issue.labels }}", context)).toBe('["bug","auth"]');
  });

  it("renders an existing-but-null value as empty, not as the word null", () => {
    expect(interpolate("[{{ nodes.empty.output.value }}]", context)).toBe("[]");
  });

  it("renders dates as ISO strings", () => {
    expect(stringifyValue(new Date("2026-08-19T09:00:00.000Z"))).toBe("2026-08-19T09:00:00.000Z");
  });
});

describe("missing paths fail loudly", () => {
  it("throws a catchable, friendly error", () => {
    expect(() => interpolate("{{ pipeline.vars.nope }}", context)).toThrow(InterpolationError);
    expect(() => interpolate("{{ pipeline.vars.nope }}", context)).toThrow(/Unknown value/);
  });

  it("never silently produces 'undefined'", () => {
    let message = "";
    try {
      interpolate("branch-{{ trigger.task.missing }}", context);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("undefined");
    expect(message).toContain("trigger.task.missing");
  });

  it("says what WAS available, to make the typo obvious", () => {
    const error = (() => {
      try {
        interpolate("{{ nodes.cloner.output.pathh }}", context);
        return null;
      } catch (e) {
        return e as InterpolationError;
      }
    })();

    expect(error?.message).toContain("path");
    expect(error?.path).toBe("nodes.cloner.output.pathh");
  });

  it("reports walking into a non-object rather than crashing", () => {
    expect(() => interpolate("{{ pipeline.vars.repoUrl.deeper }}", context)).toThrow(
      InterpolationError,
    );
  });

  it("rejects an empty template", () => {
    expect(() => interpolate("{{ }}", context)).toThrow(InterpolationError);
    expect(() => interpolate("{{}}", context)).toThrow(InterpolationError);
  });

  it("throws for a missing node, naming it", () => {
    expect(() => interpolate("{{ nodes.ghost.output.x }}", context)).toThrow(/ghost/);
  });
});

describe("escaping and edge cases", () => {
  it("renders an escaped template literally, without the backslash", () => {
    expect(interpolate("\\{{ not a template }}", context)).toBe("{{ not a template }}");
  });

  it("leaves text with no templates untouched", () => {
    expect(interpolate("just a plain string", context)).toBe("just a plain string");
    expect(interpolate("", context)).toBe("");
  });

  it("resolves adjacent templates in one string", () => {
    expect(
      interpolate("{{ pipeline.vars.repoUrl }}@{{ nodes.cloner.output.headSha }}", context),
    ).toBe("acme/app@3f2a19c");
  });

  it("resolves templates embedded in surrounding text", () => {
    expect(interpolate("task/{{ trigger.issue.number }}-fix", context)).toBe("task/12-fix");
  });

  it("leaves a lone brace alone", () => {
    expect(interpolate("{ not a template }", context)).toBe("{ not a template }");
  });
});

describe("resolveTemplate keeps raw values", () => {
  it("returns the underlying array when the whole string is one template", () => {
    expect(resolveTemplate("{{ nodes.planner.output.tasks }}", context)).toEqual(["one", "two"]);
  });

  it("returns a number as a number, not as text", () => {
    expect(resolveTemplate("{{ nodes.planner.output.count }}", context)).toBe(2);
  });

  it("returns a string when the template is only part of the value", () => {
    expect(resolveTemplate("count: {{ nodes.planner.output.count }}", context)).toBe("count: 2");
  });
});

describe("interpolateConfig", () => {
  it("resolves every string in a nested config", () => {
    const config = {
      repo: "{{ pipeline.vars.repoUrl }}",
      branch: "task/{{ trigger.issue.number }}",
      nested: { title: "{{ trigger.issue.title }}" },
      list: ["{{ pipeline.vars.baseBranch }}", "literal"],
    };

    expect(interpolateConfig(config, context)).toEqual({
      repo: "acme/app",
      branch: "task/12",
      nested: { title: "Login bug" },
      list: ["main", "literal"],
    });
  });

  it("preserves non-string values untouched", () => {
    const config = { count: 3, enabled: true, missing: null, when: undefined };
    expect(interpolateConfig(config, context)).toEqual(config);
  });

  it("keeps an array-valued template as an array", () => {
    const config = { tasks: "{{ nodes.planner.output.tasks }}" };
    expect(interpolateConfig(config, context)).toEqual({ tasks: ["one", "two"] });
  });

  it("propagates a bad path so the run fails on the offending node", () => {
    expect(() => interpolateConfig({ x: "{{ nope.at.all }}" }, context)).toThrow(
      InterpolationError,
    );
  });
});

describe("templatePaths", () => {
  it("lists the paths a template refers to, ignoring escaped ones", () => {
    expect(templatePaths("{{ a.b }} and {{ c.d }} but not \\{{ e.f }}")).toEqual(["a.b", "c.d"]);
    expect(templatePaths("no templates")).toEqual([]);
  });
});
