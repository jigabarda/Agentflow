import type { Task, TaskPriority } from "@agentflow/core";

/**
 * Board filters — pure, so the board's "what am I looking at" logic is testable
 * without a browser, and so filter state can live in the URL (a filtered view
 * is a link you can send yourself).
 */

export interface BoardFilters {
  /** Free text over title and body. */
  text: string;
  labels: string[];
  priorities: TaskPriority[];
  repo: string | null;
  /** Only cards whose run is parked waiting for a human decision. */
  waitingOnMe: boolean;
  /** Only cards whose last run failed. */
  failed: boolean;
}

export const EMPTY_FILTERS: BoardFilters = {
  text: "",
  labels: [],
  priorities: [],
  repo: null,
  waitingOnMe: false,
  failed: false,
};

/** Per-card state the filters need but the Task row does not carry. */
export interface TaskRunState {
  waitingOnMe?: boolean;
  failed?: boolean;
}

export function matchesFilters(
  task: Task,
  filters: BoardFilters,
  runState: TaskRunState = {},
): boolean {
  const text = filters.text.trim().toLowerCase();
  if (text) {
    const haystack = `${task.title} ${task.body ?? ""}`.toLowerCase();
    if (!haystack.includes(text)) return false;
  }

  // A card must carry EVERY selected label, not merely one of them — otherwise
  // adding a second label widens the view instead of narrowing it.
  if (filters.labels.length > 0) {
    if (!filters.labels.every((label) => task.labels.includes(label))) return false;
  }

  if (filters.priorities.length > 0 && !filters.priorities.includes(task.priority)) return false;
  if (filters.repo && task.repo !== filters.repo) return false;
  if (filters.waitingOnMe && !runState.waitingOnMe) return false;
  if (filters.failed && !runState.failed) return false;

  return true;
}

export function isFiltering(filters: BoardFilters): boolean {
  return (
    filters.text.trim() !== "" ||
    filters.labels.length > 0 ||
    filters.priorities.length > 0 ||
    filters.repo !== null ||
    filters.waitingOnMe ||
    filters.failed
  );
}

// ───────────────────────────── URL round trip ──────────────────────────────

/** Every query key the filters own. Anything else in the URL is left alone. */
export const FILTER_PARAM_KEYS = ["q", "label", "priority", "repo", "waiting", "failed"] as const;

/**
 * Serialise filters into query params, preserving any unrelated params already
 * in `existing` (e.g. `?board=`). Empty filters produce an empty string.
 */
export function filtersToQuery(filters: BoardFilters, existing?: string | URLSearchParams): string {
  const params = new URLSearchParams(existing ?? "");
  for (const key of FILTER_PARAM_KEYS) params.delete(key);

  if (filters.text.trim()) params.set("q", filters.text.trim());
  if (filters.labels.length) params.set("label", filters.labels.join(","));
  if (filters.priorities.length) params.set("priority", filters.priorities.join(","));
  if (filters.repo) params.set("repo", filters.repo);
  if (filters.waitingOnMe) params.set("waiting", "1");
  if (filters.failed) params.set("failed", "1");
  return params.toString();
}

const PRIORITIES: readonly TaskPriority[] = ["low", "normal", "high", "urgent"];

export function filtersFromQuery(query: string | URLSearchParams): BoardFilters {
  const params = typeof query === "string" ? new URLSearchParams(query) : query;

  const list = (key: string) =>
    (params.get(key) ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

  return {
    text: params.get("q") ?? "",
    labels: list("label"),
    // Ignore anything that is not a real priority rather than filtering to nothing.
    priorities: list("priority").filter((p): p is TaskPriority =>
      PRIORITIES.includes(p as TaskPriority),
    ),
    repo: params.get("repo"),
    waitingOnMe: params.get("waiting") === "1",
    failed: params.get("failed") === "1",
  };
}
