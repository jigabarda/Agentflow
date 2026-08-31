import type { RunContext } from "@agentflow/core";
import type { BoardStore, BoardTask, NewTask } from "../../board/BoardStore";
import type { NodeHandler, NodeInfo } from "../types";
import { NodeFailure, RunPaused } from "../types";

/**
 * The board nodes.
 *
 * These are what make the board *management* rather than a viewer: an agent
 * writes progress back to the card, decomposes work into new cards, and stops
 * for a human when it is about to do something outward (docs/BOARD.md).
 */

export type ApprovalState = "pending" | "approved" | "rejected";

export interface ApprovalRecord {
  state: ApprovalState;
  comment: string | null;
}

export interface BoardHandlerDeps {
  board: BoardStore;
  /** The verdict on a gate, or null when it has never been opened. */
  getApproval: (runId: string, nodeId: string) => Promise<ApprovalRecord | null>;
  /** Open a gate: records it as pending so the UI can offer Approve / Reject. */
  openApproval: (runId: string, nodeId: string) => Promise<void>;
  log: (
    runId: string,
    entry: { level: "debug" | "info" | "warn" | "error"; message: string; nodeId: string },
  ) => Promise<void>;
}

/** The card this run belongs to, or a failure naming why there isn't one. */
async function requireTask(
  deps: BoardHandlerDeps,
  context: RunContext,
  node: NodeInfo,
  explicitId?: unknown,
): Promise<BoardTask> {
  const taskId =
    typeof explicitId === "string" && explicitId.trim() ? explicitId.trim() : undefined;
  const id = taskId ?? context.task?.id;

  if (!id) {
    throw new NodeFailure(
      `Node "${node.id}" needs a card to act on, but this run was not started from one. Set taskId, or run this pipeline from the board.`,
    );
  }

  const task = await deps.board.getTask(id);
  if (!task) throw new NodeFailure(`Node "${node.id}": card ${id} no longer exists.`);
  return task;
}

// ────────────────────────────── task-trigger ────────────────────────────────

/**
 * The board's entry point. It runs no logic — it exists so a pipeline declares
 * "this is started by a card", and so the card is addressable as
 * `{{ nodes.<id>.output.task }}` as well as `{{ trigger.task }}`.
 */
export function createTaskTriggerHandler(
  deps: BoardHandlerDeps,
): NodeHandler<Record<string, unknown>, { task: BoardTask }> {
  return {
    type: "task-trigger",
    async run(context, _config, node) {
      const task = await requireTask(deps, context, node);
      await deps.log(context.runId, {
        level: "info",
        nodeId: node.id,
        message: `Started from card "${task.title}".`,
      });
      return { task };
    },
  };
}

// ─────────────────────────────── update-task ────────────────────────────────

export interface UpdateTaskConfig {
  taskId?: string;
  columnId?: string;
  priority?: string;
  addLabels?: string[];
  comment?: string;
  prNumber?: string | number;
  prUrl?: string;
}

export function createUpdateTaskHandler(
  deps: BoardHandlerDeps,
): NodeHandler<UpdateTaskConfig, { task: BoardTask }> {
  return {
    type: "update-task",
    async run(context, config, node) {
      const task = await requireTask(deps, context, node, config.taskId);

      const prNumber =
        config.prNumber === undefined || config.prNumber === ""
          ? undefined
          : Number(config.prNumber);
      if (prNumber !== undefined && !Number.isInteger(prNumber)) {
        throw new NodeFailure(
          `Node "${node.id}": prNumber must be a whole number, but it is "${String(config.prNumber)}".`,
        );
      }

      const updated = await deps.board.updateTask(task.id, {
        ...(config.columnId ? { columnId: config.columnId } : {}),
        ...(config.priority ? { priority: config.priority } : {}),
        ...(config.addLabels?.length ? { addLabels: config.addLabels } : {}),
        ...(prNumber !== undefined ? { prNumber } : {}),
        ...(config.prUrl ? { prUrl: config.prUrl } : {}),
      });

      // A move the agent made is worth its own timeline entry, named as the
      // agent's doing rather than the user's.
      if (config.columnId && config.columnId !== task.columnId) {
        const column = await deps.board.getColumn(config.columnId);
        await deps.board.appendEvent(task.id, {
          actor: `agent:${node.id}`,
          kind: "moved",
          message: `Moved to ${column?.name ?? "another column"}.`,
          meta: { fromColumnId: task.columnId, toColumnId: config.columnId, runId: context.runId },
        });
      }

      if (config.prUrl) {
        await deps.board.appendEvent(task.id, {
          actor: `agent:${node.id}`,
          kind: "pr_opened",
          message: `Pull request ready: ${config.prUrl}`,
          meta: { prUrl: config.prUrl, ...(prNumber !== undefined ? { prNumber } : {}) },
        });
      }

      if (config.comment?.trim()) {
        await deps.board.appendEvent(task.id, {
          actor: `agent:${node.id}`,
          kind: "commented",
          message: config.comment.trim(),
          meta: { runId: context.runId },
        });
      }

      return { task: updated };
    },
  };
}

// ─────────────────────────────── create-task ────────────────────────────────

export interface CreateTaskConfig {
  boardId?: string;
  columnId: string;
  /** Usually `{{ nodes.planner.output.tasks }}` — so it may arrive as JSON text. */
  tasks: unknown;
}

interface SubtaskInput {
  title?: unknown;
  body?: unknown;
  labels?: unknown;
  priority?: unknown;
  repo?: unknown;
  blockedBy?: unknown;
}

/**
 * A planner agent emits a list; this turns it into cards.
 *
 * The list is agent output, so it is parsed defensively: a JSON string is
 * accepted, entries without a title are refused rather than silently creating
 * blank cards.
 */
export function createCreateTaskHandler(
  deps: BoardHandlerDeps,
): NodeHandler<CreateTaskConfig, { createdTaskIds: string[] }> {
  return {
    type: "create-task",
    async run(context, config, node) {
      const columnId = config.columnId?.trim();
      if (!columnId) throw new NodeFailure(`Node "${node.id}": columnId is required.`);

      const column = await deps.board.getColumn(columnId);
      if (!column) throw new NodeFailure(`Node "${node.id}": column ${columnId} does not exist.`);

      const parent = context.task?.id ? await deps.board.getTask(context.task.id) : null;
      const boardId = config.boardId?.trim() || column.boardId;

      const entries = parseTaskList(config.tasks, node.id);
      if (entries.length === 0) {
        await deps.log(context.runId, {
          level: "warn",
          nodeId: node.id,
          message: "No subtasks to create — the list was empty.",
        });
        return { createdTaskIds: [] };
      }

      const createdTaskIds: string[] = [];
      for (const entry of entries) {
        const title = typeof entry.title === "string" ? entry.title.trim() : "";
        if (!title) {
          throw new NodeFailure(
            `Node "${node.id}": one of the tasks has no title. The agent's output was not usable.`,
          );
        }

        const input: NewTask = {
          boardId,
          columnId,
          title,
          ...(typeof entry.body === "string" ? { body: entry.body } : {}),
          ...(Array.isArray(entry.labels) ? { labels: entry.labels.map(String) } : {}),
          ...(typeof entry.priority === "string" ? { priority: entry.priority } : {}),
          ...(typeof entry.repo === "string"
            ? { repo: entry.repo }
            : { repo: parent?.repo ?? null }),
          ...(Array.isArray(entry.blockedBy) ? { blockedBy: entry.blockedBy.map(String) } : {}),
          ...(parent ? { parentTaskId: parent.id } : {}),
        };

        const created = await deps.board.createTask(input);
        createdTaskIds.push(created.id);

        await deps.board.appendEvent(created.id, {
          actor: `agent:${node.id}`,
          kind: "created",
          message: parent
            ? `Created while working on "${parent.title}".`
            : `Created by ${node.label || node.id}.`,
          meta: { runId: context.runId, ...(parent ? { parentTaskId: parent.id } : {}) },
        });
      }

      // The parent's timeline should show the decomposition too.
      if (parent) {
        await deps.board.appendEvent(parent.id, {
          actor: `agent:${node.id}`,
          kind: "updated",
          message: `Split into ${createdTaskIds.length} card${createdTaskIds.length === 1 ? "" : "s"}.`,
          meta: { createdTaskIds, runId: context.runId },
        });
      }

      await deps.log(context.runId, {
        level: "info",
        nodeId: node.id,
        message: `Created ${createdTaskIds.length} card(s) in ${column.name}.`,
      });

      return { createdTaskIds };
    },
  };
}

function parseTaskList(value: unknown, nodeId: string): SubtaskInput[] {
  let raw = value;

  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return [];
    try {
      raw = JSON.parse(text);
    } catch {
      throw new NodeFailure(
        `Node "${nodeId}": tasks must be a list, but the agent produced text that is not JSON.`,
      );
    }
  }

  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new NodeFailure(`Node "${nodeId}": tasks must be a list.`);
  }

  return raw.filter((entry): entry is SubtaskInput => typeof entry === "object" && entry !== null);
}

// ───────────────────────────── require-approval ─────────────────────────────

export interface RequireApprovalConfig {
  columnId?: string;
  message?: string;
}

export interface ApprovalOutput {
  approved: boolean;
  comment: string | null;
}

/**
 * The human gate.
 *
 * First pass: opens the gate, parks the card in a `waiting` column and throws
 * `RunPaused` — no thread is blocked, nothing is polled, the worker moves on to
 * the next run. Approving re-queues the run; this node then runs a second time,
 * finds the verdict, and either returns it or fails the run with the comment.
 */
export function createRequireApprovalHandler(
  deps: BoardHandlerDeps,
): NodeHandler<RequireApprovalConfig, ApprovalOutput> {
  return {
    type: "require-approval",
    async run(context, config, node) {
      const decision = await deps.getApproval(context.runId, node.id);

      if (decision?.state === "approved") {
        const task = context.task?.id ? await deps.board.getTask(context.task.id) : null;
        if (task) {
          await deps.board.appendEvent(task.id, {
            actor: "user",
            kind: "approved",
            message: decision.comment?.trim() || "Approved.",
            meta: { runId: context.runId, nodeId: node.id },
          });
        }
        await deps.log(context.runId, {
          level: "info",
          nodeId: node.id,
          message: "Approved — resuming.",
        });
        return { approved: true, comment: decision.comment };
      }

      if (decision?.state === "rejected") {
        const task = context.task?.id ? await deps.board.getTask(context.task.id) : null;
        if (task) {
          await deps.board.appendEvent(task.id, {
            actor: "user",
            kind: "rejected",
            message: decision.comment?.trim() || "Rejected.",
            meta: { runId: context.runId, nodeId: node.id },
          });
        }
        // The user's own words become the run's failure reason.
        throw new NodeFailure(decision.comment?.trim() || "Rejected.");
      }

      // Undecided: open the gate and park.
      await deps.openApproval(context.runId, node.id);

      const message = config.message?.trim() || "Waiting for your approval.";
      const task = context.task?.id ? await deps.board.getTask(context.task.id) : null;

      if (task) {
        const destination =
          config.columnId?.trim() ||
          (await deps.board.findColumnByKind(task.boardId, "waiting"))?.id;

        if (destination && destination !== task.columnId) {
          await deps.board.updateTask(task.id, { columnId: destination });
        }

        await deps.board.appendEvent(task.id, {
          actor: `agent:${node.id}`,
          kind: "run_step",
          message,
          meta: { runId: context.runId, nodeId: node.id, awaitingApproval: true },
        });
      }

      await deps.log(context.runId, {
        level: "info",
        nodeId: node.id,
        message: `Paused: ${message}`,
      });

      throw new RunPaused(node.id, message);
    },
  };
}
