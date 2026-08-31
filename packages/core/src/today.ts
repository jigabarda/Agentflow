/**
 * The Today view's one rule: which pile does this card belong in?
 *
 * Pure, and takes `now` as an argument — a view of "what is due today" that
 * cannot be tested at 11pm is not much of a view.
 *
 * The order of the buckets is the order of the screen, and it is deliberate:
 * what is blocked on YOU comes before what is running, which comes before what
 * you have not started. See docs/BOARD.md.
 */

export type TodayBucket = "waiting" | "in-flight" | "overdue" | "due" | "later";

export const TODAY_BUCKET_ORDER: readonly TodayBucket[] = [
  "waiting",
  "in-flight",
  "overdue",
  "due",
  "later",
];

export const TODAY_BUCKET_LABELS: Record<TodayBucket, string> = {
  waiting: "Waiting on you",
  "in-flight": "In flight",
  overdue: "Overdue",
  due: "Due today",
  later: "Later",
};

export interface TodayInput {
  dueAt?: Date | null;
  columnKind: string;
  /** The status of this card's newest run, when it has one. */
  runStatus?: string | null;
}

/** Is `when` on the same calendar day as `now`, in the viewer's timezone? */
function isSameDay(when: Date, now: Date): boolean {
  return (
    when.getFullYear() === now.getFullYear() &&
    when.getMonth() === now.getMonth() &&
    when.getDate() === now.getDate()
  );
}

/**
 * Which pile a card belongs in.
 *
 * A card needing a decision outranks everything: it is the only kind that
 * cannot make progress without you.
 */
export function todayBucket(input: TodayInput, now: Date): TodayBucket {
  if (input.runStatus === "awaiting_approval") return "waiting";
  if (input.runStatus === "running" || input.runStatus === "queued") return "in-flight";

  const due = input.dueAt ?? null;
  if (due) {
    if (isSameDay(due, now)) return "due";
    if (due.getTime() < now.getTime()) return "overdue";
  }

  return "later";
}

/** True when this card is worth showing on the 9am screen at all. */
export function belongsOnToday(bucket: TodayBucket, columnKind: string): boolean {
  // Finished work is not today's problem.
  if (columnKind === "done") return false;
  // "Later" is only noise unless something is actually happening to it.
  return bucket !== "later";
}
