/**
 * `{{ variable }}` resolution — pure.
 *
 * Node configs and agent prompts are written with templates that are resolved
 * against the run context just before a handler runs:
 *
 *   {{ pipeline.vars.repoUrl }}
 *   {{ trigger.task.title }}
 *   {{ nodes.planner.output.tasks }}
 *
 * Rules that matter (docs/ARCHITECTURE.md):
 *   · a missing path throws a friendly, catchable error — never a crash, and
 *     never a silent `undefined` smuggled into a prompt or an API call;
 *   · values stringify predictably;
 *   · a literal `{{` can be escaped with a backslash.
 */
import type { RunContext } from "./types.js";

export class InterpolationError extends Error {
  constructor(
    readonly path: string,
    readonly template: string,
    message: string,
  ) {
    super(message);
    this.name = "InterpolationError";
  }
}

/** `{{ path }}`, optionally escaped by a preceding backslash. */
const TEMPLATE = /(\\?)\{\{([^{}]*)\}\}/g;

/** A template that is the entire string, e.g. `"{{ nodes.a.output.items }}"`. */
const WHOLE_TEMPLATE = /^\s*\{\{([^{}]*)\}\}\s*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Walk a dotted path. Throws if any segment is absent — a path that exists but
 * holds `null` is fine (it resolves to an empty string), a path that does not
 * exist is a mistake worth surfacing.
 */
function resolvePath(path: string, context: RunContext, template: string): unknown {
  const segments = path
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    throw new InterpolationError(path, template, `Empty template: "${template}".`);
  }

  let current: unknown = context;
  const walked: string[] = [];

  for (const segment of segments) {
    if (!isRecord(current)) {
      throw new InterpolationError(
        path,
        template,
        `Cannot read "${segment}" — "${walked.join(".") || "the run context"}" is not an object.`,
      );
    }

    if (!(segment in current)) {
      const available = Object.keys(current).slice(0, 8).join(", ");
      throw new InterpolationError(
        path,
        template,
        `Unknown value "${path}". "${segment}" is not available${
          available ? ` (${walked.join(".") || "context"} has: ${available})` : ""
        }.`,
      );
    }

    current = (current as Record<string, unknown>)[segment];
    walked.push(segment);
  }

  return current;
}

/** Predictable, readable stringification for template substitution. */
export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * Resolve every `{{ template }}` in a string.
 * Always returns a string; use `resolveTemplate` when a raw value is wanted.
 */
export function interpolate(template: string, context: RunContext): string {
  return template.replace(TEMPLATE, (match, escape: string, path: string) => {
    // `\{{ … }}` is a literal, with the backslash consumed.
    if (escape) return match.slice(1);
    return stringifyValue(resolvePath(path.trim(), context, match));
  });
}

/**
 * Resolve a config value.
 *
 * When the whole string is a single template, the RAW value is returned — so
 * `tasks: "{{ nodes.planner.output.tasks }}"` yields an array, not its JSON
 * text. Mixed strings interpolate normally.
 */
export function resolveTemplate(value: string, context: RunContext): unknown {
  const whole = WHOLE_TEMPLATE.exec(value);
  if (whole && !value.startsWith("\\")) {
    return resolvePath(whole[1]!.trim(), context, value);
  }
  return interpolate(value, context);
}

/** Deep-resolve every string in a node's config. Arrays and objects are walked. */
export function interpolateConfig<T>(config: T, context: RunContext): T {
  if (typeof config === "string") return resolveTemplate(config, context) as T;
  if (Array.isArray(config)) {
    return config.map((item) => interpolateConfig(item, context)) as T;
  }
  if (isRecord(config)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      out[key] = interpolateConfig(value, context);
    }
    return out as T;
  }
  return config;
}

/** Every `{{ path }}` a template refers to. Useful for editor hints and tests. */
export function templatePaths(template: string): string[] {
  const paths: string[] = [];
  for (const match of template.matchAll(TEMPLATE)) {
    if (match[1]) continue; // escaped
    const path = (match[2] ?? "").trim();
    if (path) paths.push(path);
  }
  return paths;
}
