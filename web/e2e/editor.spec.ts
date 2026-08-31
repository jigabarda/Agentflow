import { expect, test } from "@playwright/test";

/**
 * editor.spec.ts — build & persist (Phase 2), per docs/TESTING.md.
 *
 * Create an agent profile → add a trigger + an agent node → assign the profile,
 * change the model on the node → connect them → save → reload → everything is
 * intact. Runs against the real local app and database.
 */

async function newPipeline(page: import("@playwright/test").Page, name: string) {
  await page.goto("/pipelines");
  await page.getByTestId("new-pipeline-name").fill(name);
  await page.getByTestId("create-pipeline").click();
  await page.waitForURL(/\/pipelines\/[^/]+$/);
  return page.url();
}

test("a pipeline can be built, configured, saved, and reloaded intact", async ({ page }) => {
  const url = await newPipeline(page, `Implement a task ${Date.now()}`);

  // A saved agent, defined once and reused.
  const profileName = `Senior implementer ${Date.now()}`;
  await page.getByTestId("tab-agents").click();
  await page.getByTestId("profile-name").fill(profileName);
  await page.getByTestId("profile-provider").selectOption("claude");
  await page.getByTestId("profile-model").selectOption("claude-opus-5");
  await page.getByTestId("profile-effort").selectOption("xhigh");
  await page.getByTestId("create-profile").click();
  await expect(page.getByText(profileName)).toBeVisible();

  // Build the graph: a card trigger and an agent.
  await page.getByTestId("palette-task-trigger").click();
  await page.getByTestId("palette-agent").click();

  // The agent node starts with NO model, so the graph is invalid and says so.
  await expect(page.getByTestId("graph-issues")).toContainText("no model set");

  // Assign the saved agent, then override the model for this node only.
  await page.getByTestId("agent-profile").selectOption({ label: `${profileName} — claude-opus-5` });
  await page.getByTestId("agent-provider").selectOption("claude");
  await page.getByTestId("agent-model").selectOption("claude-haiku-4-5");
  await page.getByTestId("node-label").fill("Implementer");

  // Once a model is set the graph is valid, so the problem banner goes away entirely.
  await expect(page.getByTestId("graph-issues")).toBeHidden();

  // Connect trigger → agent by dragging between handles.
  const trigger = page.locator('[data-node-type="task-trigger"]');
  const agent = page.locator('[data-node-type="agent"]');
  await trigger
    .locator(".react-flow__handle-right")
    .dragTo(agent.locator(".react-flow__handle-left"));
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  await page.getByTestId("save-pipeline").click();
  await expect(page.getByText("Unsaved changes")).toBeHidden();

  // Reload from the database — the graph and the node's config survive.
  await page.goto(url);
  await expect(page.locator('[data-node-type="task-trigger"]')).toBeVisible();
  await expect(page.locator('[data-node-type="agent"]')).toBeVisible();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  // Scope to the node — "implementer" also appears in the saved-agents list.
  await expect(page.locator('[data-node-type="agent"]')).toContainText("Implementer");

  await page.locator('[data-node-type="agent"]').click();
  await expect(page.getByTestId("agent-model")).toHaveValue("claude-haiku-4-5");
  await expect(page.getByTestId("agent-profile")).not.toHaveValue("");
});

test("an agent node with no model blocks the save, and the server says why", async ({ page }) => {
  await newPipeline(page, `Unconfigured ${Date.now()}`);

  await page.getByTestId("palette-task-trigger").click();
  await page.getByTestId("palette-agent").click();

  // The node itself is flagged on the canvas, not just in a banner.
  await expect(page.locator('[data-testid^="node-issue-"]')).toContainText("Set a model");

  await page.getByTestId("save-pipeline").click();
  await expect(page.getByTestId("save-error")).toContainText("no model set");
});

test("the palette is generated from the registry", async ({ page }) => {
  await newPipeline(page, `Palette ${Date.now()}`);

  // A sample across categories — all present without any per-node UI code.
  for (const id of ["task-trigger", "agent", "update-task", "require-approval", "open-pr"]) {
    await expect(page.getByTestId(`palette-${id}`)).toBeVisible();
  }
});

test("a variable can be added and is shown in its {{ }} form", async ({ page }) => {
  await newPipeline(page, `Variables ${Date.now()}`);

  await page.getByTestId("tab-variables").click();
  await page.getByTestId("variable-key").fill("repoUrl");
  await page.getByTestId("variable-value").fill("acme/app");
  await page.getByTestId("save-variable").click();

  await expect(page.getByTestId("variable-repoUrl")).toContainText("{{ pipeline.vars.repoUrl }}");
});

test("a provider key is stored write-only and never sent back", async ({ page }) => {
  await newPipeline(page, `Connections ${Date.now()}`);

  await page.getByTestId("tab-connections").click();
  await page.getByTestId("credential-provider").selectOption("claude");
  await page.getByTestId("credential-key").fill("sk-ant-not-a-real-key-000000");
  await page.getByTestId("save-credential").click();

  const credential = page.getByTestId("credential-claude");
  await expect(credential).toContainText("key set");
  // The key itself must never come back to the browser.
  await expect(credential).not.toContainText("sk-ant");
  expect(await page.content()).not.toContain("sk-ant-not-a-real-key-000000");
});
