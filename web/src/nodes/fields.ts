import { z } from "zod";

/**
 * Turn a node's Zod config schema into form fields.
 *
 * The config panel is generated, never hand-written per node — that is what
 * makes "adding a node type = registering it" true (docs/NODES.md).
 */

export type FieldKind = "text" | "textarea" | "number" | "boolean" | "select" | "string-list";

export interface FieldDescriptor {
  name: string;
  kind: FieldKind;
  /** Human label derived from the key: `branchName` → "Branch name". */
  label: string;
  required: boolean;
  /** From the schema's `.describe()` — shown as help text. */
  description?: string;
  /** For `select`. */
  options?: string[];
  defaultValue?: unknown;
}

/** Keys whose value is long-form text and deserves a textarea. */
const TEXTAREA_KEYS = new Set(["systemPrompt", "body", "message", "value", "comment", "tasks"]);

export function labelFor(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Peel optional/nullable/default wrappers to reach the underlying type. */
function unwrap(schema: z.ZodTypeAny): {
  inner: z.ZodTypeAny;
  required: boolean;
  defaultValue?: unknown;
} {
  let current = schema;
  let required = true;
  let defaultValue: unknown;

  // Loop rather than recurse: wrappers nest in any order.
  // Zod 4's `unwrap()` and `innerType` are typed against its internal base
  // type, so each step is re-asserted back to the public one.
  for (let guard = 0; guard < 10; guard++) {
    if (current instanceof z.ZodOptional) {
      required = false;
      current = current.unwrap() as z.ZodTypeAny;
    } else if (current instanceof z.ZodNullable) {
      required = false;
      current = current.unwrap() as z.ZodTypeAny;
    } else if (current instanceof z.ZodDefault) {
      required = false;
      // Zod 3 stored a thunk here; Zod 4 stores the value itself.
      const stored = (current._def as { defaultValue?: unknown }).defaultValue;
      defaultValue = typeof stored === "function" ? (stored as () => unknown)() : stored;
      current = current._def.innerType as z.ZodTypeAny;
    } else {
      break;
    }
  }

  return { inner: current, required, defaultValue };
}

function kindOf(schema: z.ZodTypeAny, key: string): FieldKind {
  if (schema instanceof z.ZodEnum) return "select";
  if (schema instanceof z.ZodNumber) return "number";
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodArray) return "string-list";
  return TEXTAREA_KEYS.has(key) ? "textarea" : "text";
}

export function fieldsFromSchema(schema: z.ZodObject<z.ZodRawShape>): FieldDescriptor[] {
  return Object.entries(schema.shape).map(([name, rawField]) => {
    const raw = rawField as z.ZodTypeAny;
    const { inner, required, defaultValue } = unwrap(raw);
    const kind = kindOf(inner, name);

    const field: FieldDescriptor = {
      name,
      kind,
      label: labelFor(name),
      required,
      ...(raw.description ? { description: raw.description } : {}),
      ...(defaultValue !== undefined ? { defaultValue } : {}),
    };

    if (kind === "select" && inner instanceof z.ZodEnum) {
      field.options = [...(inner.options as string[])];
    }

    return field;
  });
}

/**
 * Coerce a form value into the shape the schema expects.
 * HTML inputs only produce strings; a `number` field must not save `"3"`.
 */
export function coerceFieldValue(field: FieldDescriptor, raw: unknown): unknown {
  switch (field.kind) {
    case "number": {
      if (raw === "" || raw === null || raw === undefined) return undefined;
      const parsed = Number(raw);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    case "boolean":
      return Boolean(raw);
    case "string-list": {
      if (Array.isArray(raw)) return raw;
      if (typeof raw !== "string") return [];
      return raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    default: {
      if (raw === "" || raw === undefined || raw === null) return undefined;
      return String(raw);
    }
  }
}

/** Present a stored config value in an input. */
export function formatFieldValue(field: FieldDescriptor, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (field.kind === "string-list") {
    return Array.isArray(value) ? value.join(", ") : String(value);
  }
  return String(value);
}
