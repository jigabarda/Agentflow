import { describe, expect, it } from "vitest";
import {
  MIN_ORDER_GAP,
  ORDER_STEP,
  OrderPrecisionError,
  orderBetween,
  renormalizeOrders,
} from "./order";

describe("orderBetween", () => {
  it("places the first card in an empty column", () => {
    expect(orderBetween()).toBe(ORDER_STEP);
  });

  it("appends after the last card", () => {
    expect(orderBetween(1000)).toBe(2000);
  });

  it("prepends before the first card", () => {
    expect(orderBetween(undefined, 1000)).toBe(0);
  });

  it("lands strictly between two neighbours", () => {
    const value = orderBetween(1000, 2000);
    expect(value).toBeGreaterThan(1000);
    expect(value).toBeLessThan(2000);
  });

  it("rejects neighbours given in the wrong order", () => {
    expect(() => orderBetween(2000, 1000)).toThrow(RangeError);
    expect(() => orderBetween(1000, 1000)).toThrow(RangeError);
  });

  it("rejects non-finite input", () => {
    expect(() => orderBetween(Number.NaN, 1)).toThrow(TypeError);
    expect(() => orderBetween(0, Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it("throws OrderPrecisionError when the gap can no longer be split", () => {
    // 1 + EPSILON is the next representable double after 1 — nothing fits between.
    expect(() => orderBetween(1, 1 + Number.EPSILON)).toThrow(OrderPrecisionError);
  });

  it("refuses to subdivide below MIN_ORDER_GAP, well before the float floor", () => {
    // Order values round-trip through the database; we renormalize long before
    // the result depends on how many digits that layer keeps.
    expect(() => orderBetween(1000, 1000 + MIN_ORDER_GAP / 2)).toThrow(OrderPrecisionError);
    expect(() => orderBetween(1000, 1000 + MIN_ORDER_GAP * 4)).not.toThrow();
  });

  it("keeps a comfortable number of significant digits at realistic magnitudes", () => {
    const value = orderBetween(1000, 1000 + MIN_ORDER_GAP * 2);
    // ~10 significant digits — inside any sane float serialization.
    expect(Number(value.toPrecision(12))).toBe(value);
  });
});

describe("renormalizeOrders", () => {
  it("spaces a column evenly", () => {
    expect(renormalizeOrders(3)).toEqual([1000, 2000, 3000]);
    expect(renormalizeOrders(2, 10)).toEqual([10, 20]);
  });

  it("handles an empty column", () => {
    expect(renormalizeOrders(0)).toEqual([]);
  });

  it("rejects nonsense input", () => {
    expect(() => renormalizeOrders(-1)).toThrow(TypeError);
    expect(() => renormalizeOrders(1.5)).toThrow(TypeError);
    expect(() => renormalizeOrders(3, 0)).toThrow(TypeError);
  });
});

describe("repeated inserts into the same slot", () => {
  it("stays strictly ordered across 100 inserts, renormalizing at the precision floor", () => {
    // Worst case: always drop the new card into the same gap, between the
    // first two cards. The gap halves every time, so this is the scenario that
    // exhausts float precision — and must still produce a strict ordering.
    let column = renormalizeOrders(2);
    let renormalizations = 0;

    for (let i = 0; i < 100; i++) {
      let value: number;
      try {
        value = orderBetween(column[0], column[1]);
      } catch (error) {
        expect(error).toBeInstanceOf(OrderPrecisionError);
        renormalizations++;
        column = renormalizeOrders(column.length);
        value = orderBetween(column[0], column[1]);
      }
      column = [column[0]!, value, ...column.slice(1)];

      const sorted = [...column].sort((a, b) => a - b);
      expect(column).toEqual(sorted);
      expect(new Set(column).size).toBe(column.length);
    }

    expect(column).toHaveLength(102);
    // The floor is real: this cannot pass by luck alone.
    expect(renormalizations).toBeGreaterThan(0);
  });
});
