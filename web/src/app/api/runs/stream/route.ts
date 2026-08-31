import { fingerprint, runSummariesForBoard } from "@/data/runSummaries";

/**
 * Live run state for a board, over SSE.
 *
 * The board subscribes to this and never polls: a step transition has to reach
 * the card in under a second, and a page that refetches on a timer both feels
 * slower and hammers the database (docs/BOARD.md, live updates).
 *
 * The server side of it *is* a poll — SQLite has nothing to subscribe to, and a
 * 500ms read of one board's runs on a single-user machine is cheap. That is an
 * implementation detail behind this route, not something the client repeats.
 */

const TICK_MS = 500;
/** Well under any proxy's idle timeout, so the connection is not dropped. */
const HEARTBEAT_MS = 20_000;

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const boardId = new URL(request.url).searchParams.get("boardId");
  if (!boardId) {
    return new Response("boardId is required", { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let lastSent = "";
      let lastBeat = Date.now();

      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          // Already closed by the client going away. Nothing to do.
        }
      };

      const tick = async () => {
        if (closed) return;
        try {
          const summaries = await runSummariesForBoard(boardId);
          const current = fingerprint(summaries);

          if (current !== lastSent) {
            lastSent = current;
            lastBeat = Date.now();
            send("runs", summaries);
            return;
          }

          // Nothing changed: keep the connection warm without sending state.
          if (Date.now() - lastBeat >= HEARTBEAT_MS) {
            lastBeat = Date.now();
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
          }
        } catch {
          // A transient read failure must not kill the stream; the next tick
          // will pick the state up again.
        }
      };

      const timer = setInterval(() => void tick(), TICK_MS);
      request.signal.addEventListener("abort", stop);

      // Send the current state immediately, so a subscriber is never blank.
      await tick();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx and friends buffer by default, which would defeat the point.
      "X-Accel-Buffering": "no",
    },
  });
}
