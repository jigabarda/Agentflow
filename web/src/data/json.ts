import type { Prisma } from "@prisma/client";

/**
 * SQLite Json column helpers.
 *
 * Prisma hands back `JsonValue`, which is wider than what we store. These
 * narrow it defensively: a corrupt or hand-edited row degrades to an empty
 * value rather than crashing a board render.
 */

export function toStringArray(value: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function toRecord(
  value: Prisma.JsonValue | null | undefined,
): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
