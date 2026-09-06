"use client";

import type { AgentProfile } from "@/data/agentProfiles";
import { fieldsFromSchema } from "@/nodes/fields";
import { AGENT_TOOLS, EFFORT_LEVELS, PROVIDERS, modelsFor } from "@/nodes/models";
import { getNodeType } from "@/nodes/registry";
import { issuesForNode, useEditorStore } from "./editorStore";
import { ConfigField } from "./ConfigField";
import { controlClass } from "./controls";

/** Fields the agent panel renders by hand; the rest are generated. */
const AGENT_CUSTOM_FIELDS = new Set([
  "agentProfileId",
  "provider",
  "model",
  "effort",
  "allowedTools",
]);

export function NodeConfigPanel({ profiles }: { profiles: AgentProfile[] }) {
  const selectedNodeId = useEditorStore((state) => state.selectedNodeId);
  const node = useEditorStore((state) => state.nodes.find((n) => n.id === state.selectedNodeId));
  // Filter outside the selector — see the note in FlowNode.tsx.
  const allIssues = useEditorStore((state) => state.issues);
  const issues = selectedNodeId ? issuesForNode(allIssues, selectedNodeId) : [];
  const updateNodeConfig = useEditorStore((state) => state.updateNodeConfig);
  const updateNodeLabel = useEditorStore((state) => state.updateNodeLabel);
  const removeNode = useEditorStore((state) => state.removeNode);

  if (!node) {
    return (
      <aside className="w-80 shrink-0 border-l border-border bg-muted/40 p-4 text-sm text-muted-foreground">
        Select a step to configure it.
      </aside>
    );
  }

  const type = getNodeType(node.data.typeId);
  const config = node.data.config;
  const isAgent = node.data.typeId === "agent";

  /**
   * Apply a patch to the node's config in ONE write.
   *
   * Two sequential single-key writes would both build from the same stale
   * `config` closure, so the second would silently discard the first.
   */
  const patchConfig = (patch: Record<string, unknown>) => {
    const next = { ...config };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === "") delete next[key];
      else next[key] = value;
    }
    updateNodeConfig(node.id, next);
  };

  const setConfig = (key: string, value: unknown) => patchConfig({ [key]: value });

  const allFields = type ? fieldsFromSchema(type.configSchema) : [];
  const generatedFields = isAgent
    ? allFields.filter((field) => !AGENT_CUSTOM_FIELDS.has(field.name))
    : allFields;

  const assignedProfile = profiles.find((p) => p.id === config.agentProfileId);
  const providerId = (config.provider as string) ?? assignedProfile?.provider ?? "";
  const modelId = (config.model as string) ?? assignedProfile?.model ?? "";
  const knownModels = modelsFor(providerId);
  const allowedTools = Array.isArray(config.allowedTools) ? (config.allowedTools as string[]) : [];

  return (
    <aside
      data-testid="config-panel"
      className="w-80 shrink-0 overflow-y-auto border-l border-border bg-muted/40 p-4"
    >
      <h2 className="text-sm font-semibold text-foreground">{type?.label ?? node.data.typeId}</h2>
      {type && <p className="mb-4 mt-1 text-[11px] text-muted-foreground">{type.description}</p>}

      {issues.length > 0 && (
        <div
          data-testid="config-issues"
          className="mb-3 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          {issues.map((issue, index) => (
            <p key={index}>{issue.message}</p>
          ))}
        </div>
      )}

      <div className="mb-3">
        <label
          htmlFor="node-label"
          className="mb-1 block text-xs font-medium text-muted-foreground"
        >
          Name on the canvas
        </label>
        <input
          id="node-label"
          data-testid="node-label"
          value={node.data.label}
          onChange={(event) => updateNodeLabel(node.id, event.target.value)}
          className={controlClass}
        />
      </div>

      {isAgent && (
        <section className="mb-4 rounded border border-violet-200 bg-violet-50/60 p-3 dark:border-violet-900 dark:bg-violet-950/20">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">
            Which AI does this step
          </h3>

          <div className="mb-3">
            <label
              htmlFor="agent-profile"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Use a saved agent
            </label>
            <select
              id="agent-profile"
              data-testid="agent-profile"
              value={(config.agentProfileId as string) ?? ""}
              onChange={(event) => setConfig("agentProfileId", event.target.value || undefined)}
              className={controlClass}
            >
              <option value="">Configure here instead</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} — {profile.model}
                </option>
              ))}
            </select>
          </div>

          <div className="mb-3">
            <label
              htmlFor="agent-provider"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Provider<span className="ml-0.5 text-destructive">*</span>
            </label>
            <select
              id="agent-provider"
              data-testid="agent-provider"
              value={providerId}
              onChange={(event) =>
                // The old model belongs to the old provider — clear it in the
                // same write, never carry it over.
                patchConfig({ provider: event.target.value || undefined, model: undefined })
              }
              className={controlClass}
            >
              <option value="">Pick a provider…</option>
              {PROVIDERS.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                </option>
              ))}
            </select>
          </div>

          <div className="mb-3">
            <label
              htmlFor="agent-model"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Model<span className="ml-0.5 text-destructive">*</span>
            </label>
            {knownModels.length > 0 ? (
              <select
                id="agent-model"
                data-testid="agent-model"
                value={modelId}
                onChange={(event) => setConfig("model", event.target.value || undefined)}
                className={controlClass}
              >
                {/* No model is preselected — the user must choose. */}
                <option value="">Set a model…</option>
                {knownModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                    {model.note ? ` — ${model.note}` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="agent-model"
                data-testid="agent-model"
                value={modelId}
                placeholder="Type the model id"
                onChange={(event) => setConfig("model", event.target.value || undefined)}
                className={controlClass}
              />
            )}
            {assignedProfile && !config.model && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                From “{assignedProfile.name}”. Choosing here overrides it for this step only.
              </p>
            )}
          </div>

          <div className="mb-3">
            <label
              htmlFor="agent-effort"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Effort
            </label>
            <select
              id="agent-effort"
              data-testid="agent-effort"
              value={(config.effort as string) ?? ""}
              onChange={(event) => setConfig("effort", event.target.value || undefined)}
              className={controlClass}
            >
              <option value="">—</option>
              {EFFORT_LEVELS.map((level) => (
                <option key={level.id} value={level.id}>
                  {level.label}
                  {level.note ? ` — ${level.note}` : ""}
                </option>
              ))}
            </select>
          </div>

          <fieldset>
            <legend className="mb-1 text-xs font-medium text-muted-foreground">
              Tools this agent may use
            </legend>
            <div className="flex flex-wrap gap-2">
              {AGENT_TOOLS.map((tool) => (
                <label key={tool} className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={allowedTools.includes(tool)}
                    onChange={(event) =>
                      setConfig(
                        "allowedTools",
                        event.target.checked
                          ? [...allowedTools, tool]
                          : allowedTools.filter((item) => item !== tool),
                      )
                    }
                  />
                  {tool}
                </label>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Read-only roles need no Write, Edit, or Bash.
            </p>
          </fieldset>
        </section>
      )}

      {generatedFields.map((field) => (
        <ConfigField
          key={field.name}
          field={field}
          value={config[field.name]}
          onChange={(next) => setConfig(field.name, next)}
        />
      ))}

      <button
        type="button"
        data-testid="delete-node"
        onClick={() => removeNode(node.id)}
        className="mt-2 w-full rounded border border-red-300 px-2 py-1 text-sm text-destructive hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950/40"
      >
        Remove this step
      </button>
    </aside>
  );
}
