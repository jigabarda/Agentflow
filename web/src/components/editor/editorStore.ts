"use client";

import { validateGraph } from "@agentflow/core";
import type { AgentModelChoice, GraphIssue, Pipeline } from "@agentflow/core";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import { create } from "zustand";
import { defaultConfigFor, getNodeType } from "@/nodes/registry";

/**
 * Canvas state.
 *
 * Validation runs here on every change so the editor can flag a broken graph
 * immediately, rather than only when the save is rejected. The server validates
 * again — the client check is a courtesy, not the authority.
 */

export interface FlowNodeData extends Record<string, unknown> {
  typeId: string;
  label: string;
  config: Record<string, unknown>;
}

export type FlowNode = Node<FlowNodeData>;

interface EditorState {
  pipelineId: string;
  name: string;
  nodes: FlowNode[];
  edges: Edge[];
  selectedNodeId: string | null;
  /** Agent profiles, for resolving an agent node that references one. */
  profiles: Map<string, AgentModelChoice>;
  issues: GraphIssue[];
  dirty: boolean;
  saving: boolean;
  saveError: string | null;

  load: (pipeline: Pipeline, profiles: Map<string, AgentModelChoice>) => void;
  setName: (name: string) => void;
  onNodesChange: (changes: NodeChange<FlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  addNode: (typeId: string, position: { x: number; y: number }) => void;
  removeNode: (nodeId: string) => void;
  selectNode: (nodeId: string | null) => void;
  updateNodeConfig: (nodeId: string, config: Record<string, unknown>) => void;
  updateNodeLabel: (nodeId: string, label: string) => void;
  setProfiles: (profiles: Map<string, AgentModelChoice>) => void;
  revalidate: () => void;
  save: () => Promise<boolean>;
}

let nodeCounter = 0;

/** Stable, readable node ids: `agent-1`, `open-pr-2`. */
function nextNodeId(typeId: string, existing: FlowNode[]): string {
  for (;;) {
    nodeCounter += 1;
    const candidate = `${typeId}-${nodeCounter}`;
    if (!existing.some((node) => node.id === candidate)) return candidate;
  }
}

function toCoreGraph(nodes: FlowNode[], edges: Edge[]) {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.typeId,
      label: node.data.label,
      config: node.data.config,
      x: node.position.x,
      y: node.position.y,
    })),
    edges: edges.map((edge) => {
      const meta = (edge.data ?? {}) as { loop?: unknown; maxIterations?: unknown };
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
        ...(meta.loop ? { loop: true } : {}),
        ...(typeof meta.maxIterations === "number" ? { maxIterations: meta.maxIterations } : {}),
      };
    }),
  };
}

export const useEditorStore = create<EditorState>((set, get) => ({
  pipelineId: "",
  name: "",
  nodes: [],
  edges: [],
  selectedNodeId: null,
  profiles: new Map(),
  issues: [],
  dirty: false,
  saving: false,
  saveError: null,

  load: (pipeline, profiles) => {
    const nodes: FlowNode[] = pipeline.nodes.map((node) => ({
      id: node.id,
      type: "agentflow",
      position: { x: node.x, y: node.y },
      data: { typeId: node.type, label: node.label, config: node.config },
    }));

    const edges: Edge[] = pipeline.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
      // Carried through the canvas untouched. Dropping it here would silently
      // turn a valid reviewer loop into an invalid cycle on the next save.
      ...(edge.loop
        ? {
            data: {
              loop: true,
              ...(edge.maxIterations ? { maxIterations: edge.maxIterations } : {}),
            },
            label: `loop${edge.maxIterations ? ` ×${edge.maxIterations}` : ""}`,
            animated: true,
          }
        : {}),
    }));

    set({
      pipelineId: pipeline.id,
      name: pipeline.name,
      nodes,
      edges,
      profiles,
      dirty: false,
      saveError: null,
      issues: validateGraph(toCoreGraph(nodes, edges), profiles).issues,
    });
  },

  setName: (name) => set({ name, dirty: true }),

  onNodesChange: (changes) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) });

    // React Flow emits `dimensions` and `select` changes constantly as it
    // measures and focuses nodes — those are not edits. A drag only counts once
    // the user drops the node. Otherwise "unsaved changes" would never clear.
    const meaningful = changes.some((change) => {
      if (change.type === "position") return change.dragging === false;
      return change.type === "add" || change.type === "remove" || change.type === "replace";
    });
    if (meaningful) set({ dirty: true });
  },

  onEdgesChange: (changes) => {
    set({ edges: applyEdgeChanges(changes, get().edges) });

    // Selecting or hovering an edge is not an edit — same reasoning as nodes.
    if (changes.some((change) => change.type !== "select")) {
      set({ dirty: true });
      get().revalidate();
    }
  },

  onConnect: (connection) => {
    set({ edges: addEdge(connection, get().edges), dirty: true });
    get().revalidate();
  },

  addNode: (typeId, position) => {
    const type = getNodeType(typeId);
    if (!type) return;

    const id = nextNodeId(typeId, get().nodes);
    const node: FlowNode = {
      id,
      type: "agentflow",
      position,
      data: { typeId, label: type.label, config: defaultConfigFor(typeId) },
    };

    set({ nodes: [...get().nodes, node], selectedNodeId: id, dirty: true });
    get().revalidate();
  },

  removeNode: (nodeId) => {
    set({
      nodes: get().nodes.filter((node) => node.id !== nodeId),
      edges: get().edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
      selectedNodeId: get().selectedNodeId === nodeId ? null : get().selectedNodeId,
      dirty: true,
    });
    get().revalidate();
  },

  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),

  updateNodeConfig: (nodeId, config) => {
    set({
      nodes: get().nodes.map((node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, config } } : node,
      ),
      dirty: true,
    });
    get().revalidate();
  },

  updateNodeLabel: (nodeId, label) => {
    set({
      nodes: get().nodes.map((node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, label } } : node,
      ),
      dirty: true,
    });
  },

  setProfiles: (profiles) => {
    set({ profiles });
    get().revalidate();
  },

  revalidate: () => {
    const { nodes, edges, profiles } = get();
    set({ issues: validateGraph(toCoreGraph(nodes, edges), profiles).issues });
  },

  save: async () => {
    const { pipelineId, name, nodes, edges } = get();
    set({ saving: true, saveError: null });

    try {
      const response = await fetch(`/api/pipelines/${pipelineId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, ...toCoreGraph(nodes, edges) }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string; issues?: GraphIssue[] };
        set({
          saving: false,
          saveError: payload.error ?? "Could not save.",
          ...(payload.issues ? { issues: payload.issues } : {}),
        });
        return false;
      }

      set({ saving: false, dirty: false });
      return true;
    } catch {
      set({ saving: false, saveError: "Could not reach the server." });
      return false;
    }
  },
}));

/** Issues attached to one node, for inline flagging on the canvas. */
export function issuesForNode(issues: GraphIssue[], nodeId: string): GraphIssue[] {
  return issues.filter((issue) => issue.nodeId === nodeId);
}
