import { describe, expect, it } from "vitest";
import { runStatusSchema } from "@agentflow/core";

describe("worker sanity", () => {
  it("imports the shared core package", () => {
    expect(runStatusSchema.parse("queued")).toBe("queued");
    expect(runStatusSchema.safeParse("not-a-status").success).toBe(false);
  });

  it("knows awaiting_approval is a real run state", () => {
    // The board's human gate parks a run here — see docs/BOARD.md.
    expect(runStatusSchema.parse("awaiting_approval")).toBe("awaiting_approval");
  });
});
