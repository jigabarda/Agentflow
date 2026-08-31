/**
 * Agent role presets — the crew.
 *
 * A preset is a *starting point* for an agent node: the prompt, the tools it
 * should have, and how hard it should think. It deliberately carries **no
 * provider and no model**: those are the user's choice on every node, and a
 * preset that quietly picked one would be exactly the default this project
 * refuses to have (docs/AGENTS.md).
 *
 * `suggestedEffort` is a hint the picker pre-selects — cheap for triage,
 * expensive for implementing — and the user can always override it.
 */

export interface AgentRolePreset {
  id: string;
  label: string;
  /** One line, shown in the picker. */
  description: string;
  systemPrompt: string;
  /** Seeds the node's prompt; interpolated like any other config. */
  prompt: string;
  allowedTools: string[];
  suggestedEffort: string;
  /** Why this role is usually cheap or expensive — shown next to the effort. */
  costNote: string;
}

/** Read-only roles get none of the writing tools. */
const READ_ONLY = ["Read", "Glob", "Grep"];
const READ_WRITE = ["Read", "Glob", "Grep", "Write", "Edit"];

export const AGENT_ROLE_PRESETS: readonly AgentRolePreset[] = [
  {
    id: "triager",
    label: "Triager",
    description: "Classifies a card and decides whether it is worth doing at all.",
    systemPrompt: "You triage incoming work. Answer briefly and decisively. You never write code.",
    prompt: [
      "Classify this task. Reply with one line of the form:",
      "<bug|feature|chore|question> — <one sentence on what it actually needs>",
      "",
      "Title: {{ trigger.task.title }}",
      "",
      "{{ trigger.task.body }}",
    ].join("\n"),
    allowedTools: [],
    suggestedEffort: "low",
    costNote: "Runs on every card, so this is the one to keep cheap.",
  },
  {
    id: "planner",
    label: "Planner",
    description: "Breaks a large card into subtasks. Feed its output to Create cards.",
    systemPrompt:
      "You break work into small, independently completable steps. You never write code.",
    prompt: [
      "Break this task into the smallest set of independent subtasks that would",
      "complete it. Reply with JSON only: an array of objects with `title` and",
      "an optional `body`. No prose around it.",
      "",
      "Title: {{ trigger.task.title }}",
      "",
      "{{ trigger.task.body }}",
    ].join("\n"),
    allowedTools: READ_ONLY,
    suggestedEffort: "medium",
    costNote: "Reads the repo to plan realistically, but writes nothing.",
  },
  {
    id: "implementer",
    label: "Implementer",
    description: "Writes the code in the run's clone of the repo.",
    systemPrompt:
      "You are a senior engineer working in the repository cloned into your workspace. Make the smallest correct change, and match the surrounding code's style and testing conventions.",
    prompt: [
      "Implement the task below.",
      "",
      "Task: {{ trigger.task.title }}",
      "",
      "{{ trigger.task.body }}",
    ].join("\n"),
    allowedTools: READ_WRITE,
    suggestedEffort: "xhigh",
    costNote: "The one place not to economise — this is the work itself.",
  },
  {
    id: "reviewer",
    label: "Reviewer",
    description: "Reviews the diff and either approves or asks for changes.",
    systemPrompt:
      "You review code critically but fairly. You do not change files; you report what you find.",
    prompt: [
      "Review the changes in the workspace against the task.",
      "",
      "Begin your reply with exactly one word: APPROVED or CHANGES.",
      "Then, if CHANGES, list what must be fixed and why. Be specific.",
      "",
      "Task: {{ trigger.task.title }}",
      "",
      "What the implementer reported:",
      "{{ nodes.implementer.output.result }}",
    ].join("\n"),
    // Read-only on purpose: a reviewer that can edit is not a reviewer.
    allowedTools: READ_ONLY,
    suggestedEffort: "high",
    costNote: "Reads the diff only — it must not be able to fix things itself.",
  },
];

export function getRolePreset(id: string): AgentRolePreset | undefined {
  return AGENT_ROLE_PRESETS.find((preset) => preset.id === id);
}

/**
 * The config a preset contributes to an agent node.
 *
 * Provider and model are absent by design, so applying a preset to a node
 * never fills them in and never makes an unconfigured node look runnable.
 */
export function presetConfig(preset: AgentRolePreset): Record<string, unknown> {
  return {
    systemPrompt: preset.systemPrompt,
    prompt: preset.prompt,
    allowedTools: [...preset.allowedTools],
    effort: preset.suggestedEffort,
  };
}

/**
 * The verdict handles a reviewer's condition node routes on.
 * `changes` first: it is the more specific word, and the first match wins.
 */
export const REVIEW_BRANCHES = ["CHANGES", "APPROVED"];
