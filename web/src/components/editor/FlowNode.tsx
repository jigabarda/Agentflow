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

  return (
    <div
      data-testid={`node-${id}`}
      data-node-type={data.typeId}
      className={[
        "min-w-52 rounded-md border border-l-4 bg-white px-3 py-2 shadow-sm",
        "dark:border-neutral-700 dark:bg-neutral-900",
        accent,
        selected ? "ring-2 ring-sky-500" : "",
        issues.length > 0 ? "border-red-500 dark:border-red-500" : "",
      ].join(" ")}
    >
      {!isTrigger && <Handle type="target" position={Position.Left} />}

      <div className="text-[11px] uppercase tracking-wide text-neutral-500">
        {type?.label ?? data.typeId}
      </div>
      <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{data.label}</div>

      {issues.length > 0 && (
        <div data-testid={`node-issue-${id}`} className="mt-1 text-xs font-medium text-red-600">
          {/* The most common case by far: an agent with no model chosen. */}
          {issues[0]!.code === "agent-missing-model" ? "Set a model" : issues[0]!.message}
        </div>
      )}

      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const nodeTypes = { agentflow: FlowNodeView };
