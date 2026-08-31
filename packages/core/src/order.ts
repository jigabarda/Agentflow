/**
 * Fractional ordering for board cards.
 *
 * A drag-reorder must write exactly ONE row — never renumber a whole column.
 * So a card's `order` is a float placed strictly between its new neighbours.
 * Floats run out of room eventually (repeatedly inserting into the same gap
 * halves it each time), so `orderBetween` refuses to return a non-strict value
 * and the caller renormalizes that column with `renormalizeOrders`.
 */

/** Default spacing when a column is (re)numbered from scratch. */
export const ORDER_STEP = 1000;

/**
 * The smallest gap we will subdivide.
 *
 * Deliberately far above the float floor: an order value makes a round trip
 * through the database, and we do not want ordering to depend on how many
 * significant digits that layer preserves. Below this gap we renormalize
 * instead — which is cheap and happens rarely.
 */
export const MIN_ORDER_GAP = 1e-6;

/**
 * Thrown when no float exists strictly between `prev` and `next`.
 * The caller should renormalize the column and retry the move.
 */
export class OrderPrecisionError extends Error {
  constructor(
    readonly prev: number,
    readonly next: number,
  ) {
    super(
      `No order value exists strictly between ${prev} and ${next}; renormalize the column and retry.`,
    );
    this.name = "OrderPrecisionError";
  }
}

/**
 * Pick an order value that sorts strictly between `prev` and `next`.
 * Pass `undefined` for either end to place at the head or tail of a column.
 *
 * @throws {OrderPrecisionError} when the gap is too small to subdivide.
 */
export function orderBetween(prev?: number, next?: number): number {
  if (prev !== undefined && !Number.isFinite(prev)) {
    throw new TypeError(`prev must be a finite number, got ${prev}`);
  }
  if (next !== undefined && !Number.isFinite(next)) {
    throw new TypeError(`next must be a finite number, got ${next}`);
  }

  // Empty column.
  if (prev === undefined && next === undefined) return ORDER_STEP;
  // Append to the tail.
  if (next === undefined) return prev! + ORDER_STEP;
  // Prepend to the head.
  if (prev === undefined) return next - ORDER_STEP;

  if (prev >= next) {
    throw new RangeError(`prev (${prev}) must sort before next (${next})`);
  }

  if (next - prev < MIN_ORDER_GAP) throw new OrderPrecisionError(prev, next);

  const mid = prev + (next - prev) / 2;
  if (mid <= prev || mid >= next) throw new OrderPrecisionError(prev, next);
  return mid;
}

/**
 * Evenly spaced order values for a column of `count` cards, in display order.
 * Used to recover from `OrderPrecisionError`.
 */
export function renormalizeOrders(count: number, step: number = ORDER_STEP): number[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new TypeError(`count must be a non-negative integer, got ${count}`);
  }
  if (!Number.isFinite(step) || step <= 0) {
    throw new TypeError(`step must be a positive number, got ${step}`);
  }
  return Array.from({ length: count }, (_, i) => (i + 1) * step);
}
