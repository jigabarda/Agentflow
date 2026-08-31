import { describe, expect, it } from "vitest";
import { checkCost, costFraction, tokensFrom } from "./cost";

describe("checkCost", () => {
  it("allows a run under its cap", () => {
    expect(checkCost(500, 1000)).toMatchObject({ exceeded: false, used: 500, cap: 1000 });
  });

  it("allows a run exactly at its cap", () => {
    // The cap is what you may spend, not what you must stay under.
    expect(checkCost(1000, 1000).exceeded).toBe(false);
  });

  it("stops a run past its cap", () => {
    expect(checkCost(1001, 1000).exceeded).toBe(true);
  });

  it("says what was spent, what the limit was, and what to do", () => {
    const verdict = checkCost(12000, 10000);
    expect(verdict.reason).toContain("12,000");
    expect(verdict.reason).toContain("10,000");
    expect(verdict.reason).toMatch(/raise the limit on the pipeline/);
  });

  it("treats a missing cap as no limit", () => {
    // The absence of a number is not a reason to refuse to work.
    expect(checkCost(999_999, null).exceeded).toBe(false);
    expect(checkCost(999_999, undefined).exceeded).toBe(false);
  });

  it("treats a zero or negative cap as no limit rather than as 'never run'", () => {
    expect(checkCost(10, 0).exceeded).toBe(false);
    expect(checkCost(10, -5).exceeded).toBe(false);
  });

  it("shrugs off nonsense usage", () => {
    expect(checkCost(Number.NaN, 100).used).toBe(0);
    expect(checkCost(-10, 100).used).toBe(0);
    expect(checkCost(1.7, 100).used).toBe(1);
  });
});

describe("tokensFrom", () => {
  it("reads what an agent node reports", () => {
    expect(tokensFrom({ result: "done", usage: { tokens: 1234 } })).toBe(1234);
  });

  it("reads nothing from a node that reports nothing", () => {
    expect(tokensFrom({ result: "done" })).toBe(0);
    expect(tokensFrom({ usage: {} })).toBe(0);
    expect(tokensFrom(null)).toBe(0);
    expect(tokensFrom("done")).toBe(0);
  });

  it("ignores a usage figure that is not a usable number", () => {
    expect(tokensFrom({ usage: { tokens: "many" } })).toBe(0);
    expect(tokensFrom({ usage: { tokens: -5 } })).toBe(0);
    expect(tokensFrom({ usage: { tokens: Number.POSITIVE_INFINITY } })).toBe(0);
  });
});

describe("costFraction", () => {
  it("reports how much of the budget is gone", () => {
    expect(costFraction(250, 1000)).toBe(0.25);
  });

  it("never exceeds one, however far over the run went", () => {
    expect(costFraction(5000, 1000)).toBe(1);
  });

  it("has nothing to report without a cap", () => {
    expect(costFraction(500, null)).toBeNull();
  });
});
