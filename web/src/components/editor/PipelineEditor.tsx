"use client";

import { useCallback, useEffect, useState } from "react";
import { Background, Controls, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { providersUsedBy } from "@agentflow/core";
import type { CredentialState, Pipeline } from "@agentflow/core";
import type { AgentProfile } from "@/data/agentProfiles";
import { AgentsPanel } from "./AgentsPanel";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { NodeConfigPanel } from "./NodeConfigPanel";
import { NodePalette } from "./NodePalette";
import { VariablesPanel } from "./VariablesPanel";
import { nodeTypes } from "./FlowNode";
import { useEditorStore } from "./editorStore";

type SideTab = "agents" | "connections" | "variables";

function profileChoices(profiles: AgentProfile[]) {
  return new Map(profiles.map((p) => [p.id, { provider: p.provider, model: p.model }]));
}

function EditorInner({
  pipeline,
  initialProfiles,
  initialCredentials,
  initialVariables,
}: {
  pipeline: Pipeline;
  initialProfiles: AgentProfile[];
  initialCredentials: CredentialState[];
  initialVariables: Record<string, string>;
}) {
  const [profiles, setProfiles] = useState(initialProfiles);
  const [credentials, setCredentials] = useState(initialCredentials);
  const [variables, setVariables] = useState(initialVariables);
  const [tab, setTab] = useState<SideTab>("agents");

  const load = useEditorStore((state) => state.load);
  const setStoreProfiles = useEditorStore((state) => state.setProfiles);
  const nodes = useEditorStore((state) => state.nodes);
  const edges = useEditorStore((state) => state.edges);
  const name = useEditorStore((state) => state.name);
  const issues = useEditorStore((state) => state.issues);
  const dirty = useEditorStore((state) => state.dirty);
  const saving = useEditorStore((state) => state.saving);
  const saveError = useEditorStore((state) => state.saveError);
  const setName = useEditorStore((state) => state.setName);
  const onNodesChange = useEditorStore((state) => state.onNodesChange);
  const onEdgesChange = useEditorStore((state) => state.onEdgesChange);
  const onConnect = useEditorStore((state) => state.onConnect);
  const selectNode = useEditorStore((state) => state.selectNode);
  const save = useEditorStore((state) => state.save);

  useEffect(() => {
    load(pipeline, profileChoices(initialProfiles));
  }, [load, pipeline, initialProfiles]);

  const refreshProfiles = useCallback(async () => {
    const response = await fetch("/api/agent-profiles");
    const next = (await response.json()) as AgentProfile[];
    setProfiles(next);
    setStoreProfiles(profileChoices(next));
  }, [setStoreProfiles]);

  const refreshCredentials = useCallback(async () => {
    const response = await fetch(`/api/pipelines/${pipeline.id}/credentials`);
    setCredentials((await response.json()) as CredentialState[]);
  }, [pipeline.id]);

  const refreshVariables = useCallback(async () => {
    const response = await fetch(`/api/pipelines/${pipeline.id}/variables`);
    setVariables((await response.json()) as Record<string, string>);
  }, [pipeline.id]);

  const providersUsed = providersUsedBy(
    {
      nodes: nodes.map((node) => ({
        id: node.id,
        type: node.data.typeId,
        label: node.data.label,
        config: node.data.config,
        x: node.position.x,
        y: node.position.y,
      })),
    },
    profileChoices(profiles),
  );

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2 ">
        <input
          data-testid="pipeline-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="rounded-md border border-transparent px-2 py-1 text-sm font-semibold outline-none transition-[color,box-shadow] hover:border-input focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />

        {issues.length > 0 && (
          <span data-testid="graph-issues" className="text-xs font-medium text-destructive">
            {issues.length} problem{issues.length === 1 ? "" : "s"} — {issues[0]!.message}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
          {saveError && (
            <span data-testid="save-error" className="text-xs text-destructive">
              {saveError}
            </span>
          )}
          <button
            type="button"
            data-testid="save-pipeline"
            disabled={saving}
            onClick={() => void save()}
            className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <NodePalette />

        <main className="min-w-0 flex-1" data-testid="canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_event, node) => selectNode(node.id)}
            onPaneClick={() => selectNode(null)}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls />
          </ReactFlow>
        </main>

        <div className="flex w-72 shrink-0 flex-col border-l bg-muted/40">
          <nav className="flex border-b border-border text-xs ">
            {(["agents", "connections", "variables"] as SideTab[]).map((item) => (
              <button
                key={item}
                type="button"
                data-testid={`tab-${item}`}
                onClick={() => setTab(item)}
                className={`flex-1 px-2 py-2 capitalize ${
                  tab === item
                    ? "border-b-2 border-sky-500 font-medium text-sky-700 dark:text-sky-400"
                    : "text-muted-foreground"
                }`}
              >
                {item}
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === "agents" && (
              <AgentsPanel profiles={profiles} onChanged={() => void refreshProfiles()} />
            )}
            {tab === "connections" && (
              <ConnectionsPanel
                pipelineId={pipeline.id}
                credentials={credentials}
                providersUsed={providersUsed}
                onChanged={() => void refreshCredentials()}
              />
            )}
            {tab === "variables" && (
              <VariablesPanel
                pipelineId={pipeline.id}
                variables={variables}
                onChanged={() => void refreshVariables()}
              />
            )}
          </div>
        </div>

        <NodeConfigPanel profiles={profiles} />
      </div>
    </div>
  );
}

export function PipelineEditor(props: {
  pipeline: Pipeline;
  initialProfiles: AgentProfile[];
  initialCredentials: CredentialState[];
  initialVariables: Record<string, string>;
}) {
  return (
    <ReactFlowProvider>
      <EditorInner {...props} />
    </ReactFlowProvider>
  );
}
