"use client";

import { useEffect } from "react";
import type { RunSummary } from "@/data/runSummaries";

/**
 * Subscribe the board to live run state.
 *
 * The board must never poll: a step transition has to reach the card in under a
 * second, and that is what makes this feel like a system rather than a form
 * (docs/BOARD.md, live updates). `EventSource` reconnects on its own, so a
 * worker restart or a dropped connection heals without anything here.
 */
export function useRunStream(boardId: string | undefined, onRuns: (runs: RunSummary[]) => void) {
  useEffect(() => {
    if (!boardId) return;
    // Not available in a non-browser test environment; the board still renders.
    if (typeof EventSource === "undefined") return;

    const source = new EventSource(`/api/runs/stream?boardId=${encodeURIComponent(boardId)}`);

    source.addEventListener("runs", (event) => {
      try {
        onRuns(JSON.parse((event as MessageEvent<string>).data) as RunSummary[]);
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    });

    return () => source.close();
  }, [boardId, onRuns]);
}
