import { describe, expect, it } from "vitest";
import { z } from "zod";
import { coerceFieldValue, fieldsFromSchema, formatFieldValue, labelFor } from "./fields";
import { NODE_TYPES, getNodeType } from "./registry";

describe("fieldsFromSchema", () => {
  it("derives a field per schema key", () => {
    const fields = fieldsFromSchema(
      z.object({ url: z.string(), retries: z.number(), enabled: z.boolean() }),
    );
    expect(fields.map((f) => f.name)).toEqual(["url", "retries", "enabled"]);
    expect(fields.map((f) => f.kind)).toEqual(["text", "number", "boolean"]);
  });

  it("marks required fields as required and optional ones as not", () => {
    const fields = fieldsFromSchema(
      z.object({ repo: z.string(), ref: z.string().optional(), base: z.string().default("main") }),
    );
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.repo!.required).toBe(true);
    expect(byName.ref!.required).toBe(false);
    expect(byName.base!.required).toBe(false);
    expect(byName.base!.defaultValue).toBe("main");
  });

  it("sees through nested optional/default/nullable wrappers", () => {
    const fields = fieldsFromSchema(
      z.object({ count: z.number().int().positive().optional().nullable() }),
    );
    expect(fields[0]!.kind).toBe("number");
    expect(fields[0]!.required).toBe(false);
  });

  it("turns an enum into a select with its options", () => {
    const fields = fieldsFromSchema(z.object({ method: z.enum(["GET", "POST"]).default("GET") }));
    expect(fields[0]!.kind).toBe("select");
    expect(fields[0]!.options).toEqual(["GET", "POST"]);
  });

  it("treats arrays as an editable list", () => {
    const fields = fieldsFromSchema(z.object({ labels: z.array(z.string()).default([]) }));
    expect(fields[0]!.kind).toBe("string-list");
  });

  it("carries .describe() text through as help text", () => {
    const fields = fieldsFromSchema(z.object({ repo: z.string().describe("owner/name") }));
    expect(fields[0]!.description).toBe("owner/name");
  });

  it("gives long-form keys a textarea", () => {
    const fields = fieldsFromSchema(z.object({ systemPrompt: z.string(), title: z.string() }));
    expect(fields[0]!.kind).toBe("textarea");
    expect(fields[1]!.kind).toBe("text");
  });

  it("generates fields for every registered node type without throwing", () => {
    for (const type of NODE_TYPES) {
      expect(() => fieldsFromSchema(type.configSchema)).not.toThrow();
    }
  });

  it("renders the required fields of a real node type", () => {
    const openPr = getNodeType("open-pr")!;
    const fields = fieldsFromSchema(openPr.configSchema);
    const required = fields.filter((f) => f.required).map((f) => f.name);
    expect(required).toEqual(expect.arrayContaining(["repo", "head", "title"]));
  });
});

describe("labelFor", () => {
  it("humanises a camelCase key", () => {
    expect(labelFor("branchName")).toBe("Branch name");
    expect(labelFor("issueNumber")).toBe("Issue number");
    expect(labelFor("url")).toBe("Url");
  });
});

describe("coerceFieldValue", () => {
  const number = { name: "n", kind: "number" as const, label: "N", required: false };
  const list = { name: "l", kind: "string-list" as const, label: "L", required: false };
  const text = { name: "t", kind: "text" as const, label: "T", required: false };

  it("converts a numeric input's string to a number", () => {
    expect(coerceFieldValue(number, "42")).toBe(42);
  });

  it("drops an emptied number rather than storing NaN", () => {
    expect(coerceFieldValue(number, "")).toBeUndefined();
    expect(coerceFieldValue(number, "abc")).toBeUndefined();
  });

  it("splits a comma list and trims the parts", () => {
    expect(coerceFieldValue(list, "bug, auth , ")).toEqual(["bug", "auth"]);
    expect(coerceFieldValue(list, "")).toEqual([]);
  });

  it("leaves an already-array list alone", () => {
    expect(coerceFieldValue(list, ["a", "b"])).toEqual(["a", "b"]);
  });

  it("drops an emptied text field so it does not save an empty string", () => {
    expect(coerceFieldValue(text, "")).toBeUndefined();
    expect(coerceFieldValue(text, "acme/app")).toBe("acme/app");
  });
});

describe("formatFieldValue", () => {
  const list = { name: "l", kind: "string-list" as const, label: "L", required: false };
  const text = { name: "t", kind: "text" as const, label: "T", required: false };

  it("shows an empty string for a missing value", () => {
    expect(formatFieldValue(text, undefined)).toBe("");
    expect(formatFieldValue(text, null)).toBe("");
  });

  it("joins a list for display", () => {
    expect(formatFieldValue(list, ["bug", "auth"])).toBe("bug, auth");
  });

  it("round-trips a list through format and coerce", () => {
    expect(coerceFieldValue(list, formatFieldValue(list, ["a", "b"]))).toEqual(["a", "b"]);
  });
});
