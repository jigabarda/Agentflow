"use client";

import { CATEGORY_LABELS, nodeTypesByCategory, type NodeCategory } from "@/nodes/registry";
import { useEditorStore } from "./editorStore";

/**
 * The palette is generated from the node registry — adding a node type makes it
 * appear here with no edit to this file (docs/NODES.md).
 */
export function NodePalette() {
  const addNode = useEditorStore((state) => state.addNode);
  const nodeCount = useEditorStore((state) => state.nodes.length);
  const grouped = nodeTypesByCategory();

  return (
    <aside className="w-56 shrink-0 overflow-y-auto border-r border-border bg-muted/40 p-3">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Add a step
      </h2>

      {[...grouped.entries()].map(([category, types]) => (
        <section key={category} className="mb-4">
          <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {CATEGORY_LABELS[category as NodeCategory]}
          </h3>
          <ul className="space-y-1">
            {types.map((type) => (
              <li key={type.id}>
                <button
                  type="button"
                  data-testid={`palette-${type.id}`}
                  title={type.description}
                  onClick={() =>
                    // Stagger new nodes so they never land exactly on top of each other.
                    addNode(type.id, { x: 80 + (nodeCount % 4) * 60, y: 80 + nodeCount * 30 })
                  }
                  className="w-full rounded border border-border bg-card px-2 py-1.5 text-left text-sm transition-colors hover:border-ring/40 hover:bg-accent"
                >
                  <span>{type.label}</span>
                  {type.phase === "later" && (
                    <span className="ml-1 text-[10px] text-muted-foreground/70">soon</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}
