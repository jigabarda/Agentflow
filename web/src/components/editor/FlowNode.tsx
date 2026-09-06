"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { getNodeType } from "@/nodes/registry";
import { issuesForNode, useEditorStore, type FlowNode as FlowNodeType } from "./editorStore";

const CATEGORY_ACCENT: Record<string, string> = {
  trigger: "border-l-emerald-500",
  flow: "border-l-slate-400",
  agent: "border-l-violet-500",
  board: "border-l-sky-500",
  github: "border-l-amber-500",
  deploy: "border-l-rose-500",
};

export function FlowNodeView({ id, data, selected }: NodeProps<FlowNodeType>) {
  const type = getNodeType(data.typeId);
  // Select the stable `issues` array and filter here. A selector that built a
  // new array each call would never compare equal, and re-render forever.
  const allIssues = useEditorStore((state) => state.issues);
  const issues = issuesForNode(allIssues, id);
  const accent = CATEGORY_ACCENT[type?.category ?? "flow"] ?? "border-l-slate-400";

  const isTrigger = type?.category === "trigger";

  /**
   * A branching node needs one NAMED handle per case, or React Flow cannot
   * attach the edge at all — the branch would simply not be drawn, and the
   * canvas would show a pipeline that is not the one that runs.
   */
  const branches = branchHandlesFor(data);

  return (
    <div
      data-testid={`node-${id}`}
      data-node-type={data.typeId}
      className={[
        "min-w-52 rounded-md border border-l-4 bg-card px-3 py-2 shadow-sm",
        "",
        accent,
        selected ? "ring-2 ring-ring" : "",
        issues.length > 0 ? "border-red-500 dark:border-red-500" : "",
      ].join(" ")}
    >
      {!isTrigger && <Handle type="target" position={Position.Left} />}

      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {type?.label ?? data.typeId}
      </div>
      <div className="text-sm font-medium text-foreground">{data.label}</div>

      {issues.length > 0 && (
        <div data-testid={`node-issue-${id}`} className="mt-1 text-xs font-medium text-destructive">
          {/* The most common case by far: an agent with no model chosen. */}
          {issues[0]!.code === "agent-missing-model" ? "Set a model" : issues[0]!.message}
        </div>
      )}

      {branches.length === 0 ? (
        <Handle type="source" position={Position.Right} />
      ) : (
        branches.map((branch, index) => (
          <Handle
            key={branch}
            id={branch}
            type="source"
            position={Position.Right}
            // Spread the handles down the right edge so both are reachable.
            style={{ top: `${((index + 1) / (branches.length + 1)) * 100}%` }}
          >
            <span className="pointer-events-none absolute left-3 -top-2 whitespace-nowrap text-[9px] text-muted-foreground">
              {branch}
            </span>
          </Handle>
        ))
      )}
    </div>
  );
}

/** The handle names a condition node routes on: its cases, plus its default. */
function branchHandlesFor(data: FlowNodeType["data"]): string[] {
  if (data.typeId !== "condition") return [];

  const config = (data.config ?? {}) as { cases?: unknown; default?: unknown };
  const cases = Array.isArray(config.cases) ? config.cases.map(String).filter(Boolean) : [];
  const fallback = typeof config.default === "string" ? config.default : "";

  const handles = [...cases];
  if (fallback && !handles.includes(fallback)) handles.push(fallback);
  return handles;
}

export const nodeTypes = { agentflow: FlowNodeView };
