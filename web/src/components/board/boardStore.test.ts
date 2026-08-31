// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board, Task } from "@agentflow/core";
import { useBoardStore } from "./boardStore";

/**
 * The optimistic-move contract: the card lands instantly, and a refusal puts
 * the board back exactly as it was — with a reason the user can read.
 */

const board: Board = {
  id: "b1",
  name: "My work",
  columns: [
    { id: "todo", boardId: "b1", name: "Todo", order: 100, kind: "ready" },
    { id: "doing", boardId: "b1", name: "In progress", order: 200, kind: "working" },
  ],
};

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    boardId: "b1",
    columnId: "todo",
    title: "Fix login redirect",
    order: 1000,
    priority: "normal",
    labels: [],
    blockedBy: [],
    ...overrides,
  };
}

const initial = useBoardStore.getState();

beforeEach(() => {
  useBoardStore.setState(initial, true);
  useBoardStore.getState().load(board, [task(), task({ id: "t2", order: 2000, title: "Second" })]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) =>
    handler(url, init),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("moveTask — the happy path", () => {
  it("shows the card in its new column immediately, before the server answers", async () => {
    let resolve: (value: Response) => void = () => {};
    stubFetch(() => new Promise<Response>((r) => (resolve = r)));

    const move = useBoardStore.getState().moveTask("t1", "doing", 0);

    // Not awaited yet — the optimistic update has already happened.
    expect(useBoardStore.getState().tasks.find((t) => t.id === "t1")?.columnId).toBe("doing");

    resolve(json({ task: task({ columnId: "doing", order: 500 }) }));
    await move;
  });

  it("adopts the server's authoritative order once it answers", async () => {
    stubFetch(() => json({ task: task({ columnId: "doing", order: 4242 }) }));

    await useBoardStore.getState().moveTask("t1", "doing", 0);

    const moved = useBoardStore.getState().tasks.find((t) => t.id === "t1");
    expect(moved?.order).toBe(4242);
    expect(useBoardStore.getState().rejection).toBeNull();
  });

  it("sends the neighbours it dropped between", async () => {
    const spy = stubFetch(() => json({ task: task({ columnId: "todo", order: 1500 }) }));

    // Drop t1 at the end of its own column, after t2.
    await useBoardStore.getState().moveTask("t1", "todo", 1);

    const body = JSON.parse(String(spy.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body.columnId).toBe("todo");
    expect(body.afterTaskId).toBe("t2");
    expect(body.beforeTaskId).toBeNull();
  });

  it("surfaces a WIP-limit warning without undoing the move", async () => {
    stubFetch(() =>
      json({ task: task({ columnId: "doing" }), warning: "over its WIP limit (3/2)" }),
    );

    await useBoardStore.getState().moveTask("t1", "doing", 0);

    expect(useBoardStore.getState().tasks.find((t) => t.id === "t1")?.columnId).toBe("doing");
    expect(useBoardStore.getState().warning).toContain("WIP limit");
  });
});

describe("moveTask — rejection rolls back", () => {
  it("restores the ORIGINAL column and order when the server refuses", async () => {
    stubFetch(() => json({ error: "Blocked by 1 unfinished task." }, 409));

    const before = useBoardStore.getState().tasks;
    const ok = await useBoardStore.getState().moveTask("t1", "doing", 0);

    expect(ok).toBe(false);
    const after = useBoardStore.getState().tasks.find((t) => t.id === "t1");
    expect(after?.columnId).toBe("todo");
    expect(after?.order).toBe(1000);
    // Every other card is untouched too.
    expect(useBoardStore.getState().tasks).toEqual(before);
  });

  it("shows the server's reason verbatim", async () => {
    stubFetch(() => json({ error: "Blocked by 2 unfinished tasks." }, 409));
    await useBoardStore.getState().moveTask("t1", "doing", 0);
    expect(useBoardStore.getState().rejection).toBe("Blocked by 2 unfinished tasks.");
  });

  it("rolls back when the network fails, and says so", async () => {
    stubFetch(() => {
      throw new Error("offline");
    });

    await useBoardStore.getState().moveTask("t1", "doing", 0);

    expect(useBoardStore.getState().tasks.find((t) => t.id === "t1")?.columnId).toBe("todo");
    expect(useBoardStore.getState().rejection).toBe("Could not reach the server.");
  });

  it("falls back to a readable message when the error body is unusable", async () => {
    stubFetch(() => new Response("not json", { status: 500 }));
    await useBoardStore.getState().moveTask("t1", "doing", 0);
    expect(useBoardStore.getState().rejection).toBe("That move was not allowed.");
  });

  it("does nothing for a card that is not on the board", async () => {
    const spy = stubFetch(() => json({}));
    expect(await useBoardStore.getState().moveTask("ghost", "doing", 0)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("clears a previous rejection when a later move succeeds", async () => {
    stubFetch(() => json({ error: "nope" }, 409));
    await useBoardStore.getState().moveTask("t1", "doing", 0);
    expect(useBoardStore.getState().rejection).toBe("nope");

    stubFetch(() => json({ task: task({ columnId: "doing" }) }));
    await useBoardStore.getState().moveTask("t1", "doing", 0);
    expect(useBoardStore.getState().rejection).toBeNull();
  });
});

describe("createTask", () => {
  it("adds the new card to the board", async () => {
    stubFetch(() => json(task({ id: "t3", title: "Third", order: 3000 }), 201));

    const created = await useBoardStore.getState().createTask("todo", "Third");

    expect(created?.id).toBe("t3");
    expect(useBoardStore.getState().tasks).toHaveLength(3);
  });

  it("refuses an empty title without calling the server", async () => {
    const spy = stubFetch(() => json({}, 201));
    expect(await useBoardStore.getState().createTask("todo", "   ")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("trims the title", async () => {
    const spy = stubFetch(() => json(task({ id: "t3" }), 201));
    await useBoardStore.getState().createTask("todo", "  Padded  ");

    const body = JSON.parse(String(spy.mock.calls[0]![1]!.body)) as { title: string };
    expect(body.title).toBe("Padded");
  });
});

describe("visibleTasks", () => {
  it("returns a column's cards in order", () => {
    expect(
      useBoardStore
        .getState()
        .visibleTasks("todo")
        .map((t) => t.id),
    ).toEqual(["t1", "t2"]);
    expect(useBoardStore.getState().visibleTasks("doing")).toEqual([]);
  });

  it("hides archived cards", () => {
    useBoardStore.getState().load(board, [task({ archivedAt: new Date() })]);
    expect(useBoardStore.getState().visibleTasks("todo")).toEqual([]);
  });

  it("applies the active filter", () => {
    useBoardStore.setState({ filters: { ...useBoardStore.getState().filters, text: "second" } });
    expect(
      useBoardStore
        .getState()
        .visibleTasks("todo")
        .map((t) => t.id),
    ).toEqual(["t2"]);
  });
});
