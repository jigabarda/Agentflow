import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import type { Task } from "@agentflow/core";
import { TaskCard } from "./TaskCard";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    boardId: "b1",
    columnId: "c1",
    title: "Fix login redirect",
    order: 1000,
    priority: "normal",
    labels: [],
    blockedBy: [],
    ...overrides,
  };
}

/** dnd-kit's useSortable needs its providers, even in a unit test. */
function renderCard(props: Partial<Parameters<typeof TaskCard>[0]> = {}) {
  const merged = {
    task: task(),
    blocked: false,
    selected: false,
    onOpen: vi.fn(),
    onSelect: vi.fn(),
    onDecide: vi.fn(),
    ...props,
  };

  render(
    <DndContext>
      <SortableContext items={[merged.task.id]}>
        <ul>
          <TaskCard {...merged} />
        </ul>
      </SortableContext>
    </DndContext>,
  );
  return merged;
}

describe("TaskCard", () => {
  it("shows the title", () => {
    renderCard();
    expect(screen.getByText("Fix login redirect")).toBeInTheDocument();
  });

  it("shows every label", () => {
    renderCard({ task: task({ labels: ["bug", "auth"] }) });
    expect(screen.getByText("bug")).toBeInTheDocument();
    expect(screen.getByText("auth")).toBeInTheDocument();
  });

  it("shows the repo and issue number together", () => {
    renderCard({ task: task({ repo: "acme/app", issueNumber: 12 }) });
    expect(screen.getByText("acme/app #12")).toBeInTheDocument();
  });

  it("marks a blocked card so you can see it without opening it", () => {
    renderCard({ task: task({ blockedBy: ["t9"] }), blocked: true });
    expect(screen.getByTestId("card-blocked-t1")).toBeInTheDocument();
  });

  it("does not mark a card whose blockers are done", () => {
    renderCard({ task: task({ blockedBy: ["t9"] }), blocked: false });
    expect(screen.queryByTestId("card-blocked-t1")).not.toBeInTheDocument();
  });

  it("shows a PR chip once a run has opened one", () => {
    renderCard({ task: task({ prNumber: 204, prUrl: "https://github.com/acme/app/pull/204" }) });
    expect(screen.getByTestId("card-pr-t1")).toHaveTextContent("PR #204");
  });

  it("has no PR chip before a PR exists", () => {
    renderCard();
    expect(screen.queryByTestId("card-pr-t1")).not.toBeInTheDocument();
  });

  it("reflects each priority with a distinct stripe", () => {
    const { container } = render(
      <DndContext>
        <SortableContext items={["t1"]}>
          <ul>
            <TaskCard
              task={task({ priority: "urgent" })}
              blocked={false}
              selected={false}
              onOpen={vi.fn()}
              onSelect={vi.fn()}
              onDecide={vi.fn()}
            />
          </ul>
        </SortableContext>
      </DndContext>,
    );
    expect(container.querySelector(".bg-red-500")).not.toBeNull();
  });

  it("shows a selection ring only when selected", () => {
    const { container } = render(
      <DndContext>
        <SortableContext items={["t1"]}>
          <ul>
            <TaskCard
              task={task()}
              blocked={false}
              selected
              onOpen={vi.fn()}
              onSelect={vi.fn()}
              onDecide={vi.fn()}
            />
          </ul>
        </SortableContext>
      </DndContext>,
    );
    expect(container.querySelector(".ring-2")).not.toBeNull();
  });
});
