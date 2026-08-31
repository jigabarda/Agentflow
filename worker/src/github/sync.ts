import type { GitHubIssue } from "@agentflow/core";

/**
 * GitHub issue sync — one job, idempotent, never destructive.
 *
 * The board is the source of truth for *your work*; GitHub is the source of
 * truth for *code*. This keeps them linked, not merged (docs/BOARD.md).
 *
 * Two rules make it safe to run on a timer:
 *   · **idempotent** — running it twice changes nothing the second time, so a
 *     retry after a network failure is free;
 *   · **never destructive** — it creates and it archives, and it never deletes
 *     a card. A conflict always resolves in favour of keeping work.
 *
 * The decisions live in `planIssueSync`, which is pure. The caller does the
 * writing, so this can be tested exhaustively with no token and no database.
 */

export interface SyncableCard {
  id: string;
  title: string;
  issueNumber: number | null;
  columnKind: string;
  archivedAt: Date | null;
}

export interface IssueSyncPlan {
  /** Issues with no card yet — import them. */
  create: GitHubIssue[];
  /** Cards whose issue has changed on GitHub. */
  update: { taskId: string; issue: GitHubIssue; changes: string[] }[];
  /** Cards whose issue was closed on GitHub — archive, never delete. */
  archive: { taskId: string; issueNumber: number }[];
  /** Cards that reached a `done` column — close their issue. */
  close: { taskId: string; issueNumber: number }[];
  /** Nothing to do. Counted so a caller can log "already in step". */
  unchanged: number;
}

export interface IssueSyncOptions {
  /** Close the GitHub issue when its card reaches a done column. */
  closeOnDone?: boolean;
  /** Archive the card when its issue is closed on GitHub. */
  archiveOnClosed?: boolean;
}

/**
 * Work out what syncing would do, without doing any of it.
 *
 * Deliberately total: an issue with no card, a card with no issue, a card whose
 * issue was deleted — each has a defined, non-destructive answer.
 */
export function planIssueSync(
  issues: readonly GitHubIssue[],
  cards: readonly SyncableCard[],
  options: IssueSyncOptions = {},
): IssueSyncPlan {
  const closeOnDone = options.closeOnDone ?? true;
  const archiveOnClosed = options.archiveOnClosed ?? true;

  const plan: IssueSyncPlan = { create: [], update: [], archive: [], close: [], unchanged: 0 };

  const byIssue = new Map<number, SyncableCard>();
  for (const card of cards) {
    // An archived card still claims its issue, so re-running the import does
    // not resurrect work someone deliberately put away.
    if (card.issueNumber !== null && !byIssue.has(card.issueNumber)) {
      byIssue.set(card.issueNumber, card);
    }
  }

  for (const issue of issues) {
    const card = byIssue.get(issue.number);

    if (!card) {
      // A closed issue nobody has a card for is history, not new work.
      if (issue.state === "closed") continue;
      plan.create.push(issue);
      continue;
    }

    if (card.archivedAt) {
      plan.unchanged += 1;
      continue;
    }

    if (issue.state === "closed" && archiveOnClosed) {
      plan.archive.push({ taskId: card.id, issueNumber: issue.number });
      continue;
    }

    const changes: string[] = [];
    if (issue.title !== card.title) changes.push("title");

    if (changes.length > 0) {
      plan.update.push({ taskId: card.id, issue, changes });
    } else {
      plan.unchanged += 1;
    }
  }

  if (closeOnDone) {
    const openIssues = new Set(
      issues.filter((issue) => issue.state === "open").map((issue) => issue.number),
    );

    for (const card of cards) {
      if (card.issueNumber === null) continue;
      if (card.archivedAt) continue;
      if (card.columnKind !== "done") continue;
      // Only close what is actually still open.
      if (!openIssues.has(card.issueNumber)) continue;

      plan.close.push({ taskId: card.id, issueNumber: card.issueNumber });
    }
  }

  return plan;
}

/** True when the plan would change nothing — the second run of a pair. */
export function isNoop(plan: IssueSyncPlan): boolean {
  return (
    plan.create.length === 0 &&
    plan.update.length === 0 &&
    plan.archive.length === 0 &&
    plan.close.length === 0
  );
}

/** The card an imported issue becomes. */
export function cardFromIssue(issue: GitHubIssue): {
  title: string;
  body: string;
  labels: string[];
  issueNumber: number;
} {
  return {
    title: issue.title || `Issue #${issue.number}`,
    body: issue.body,
    labels: issue.labels,
    issueNumber: issue.number,
  };
}
