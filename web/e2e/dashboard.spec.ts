import { expect, test, type Page } from "@playwright/test";

/**
 * dashboard.spec.ts — run history and secrets (Phase 11).
 *
 * Proves through the real app that runs are listed and filterable, that a
 * failed run offers a retry, and that a stored token is never sent back to the
 * browser.
 */

async function seedRun(page: Page, status: string, options: { error?: string } = {}) {
  const board = (await (
    await page.request.post("/api/boards", {
      data: { name: `Dash ${Date.now()}-${Math.round(performance.now())}` },
    })
  ).json()) as { id: string };

  const seeded = await page.request.post(`/api/boards/${board.id}/golden-loop`, {
    data: { repo: "jigabarda/Agentflow", provider: "ollama", model: "qwen2.5-coder" },
  });
  const loop = (await seeded.json()) as { pipelineId: string; workingColumnId: string };

  await page.request.post(`/api/pipelines/${loop.pipelineId}/credentials`, {
    data: { provider: "ollama", baseUrl: "http://localhost:11434/v1" },
  });

  const task = (await (
    await page.request.post("/api/tasks", {
      data: { boardId: board.id, columnId: loop.workingColumnId, title: `Card ${status}` },
    })
  ).json()) as { id: string };

  const run = (await (
    await page.request.post("/api/runs", {
      data: { pipelineId: loop.pipelineId, taskId: task.id },
    })
  ).json()) as { id: string };

  return { boardId: board.id, taskId: task.id, runId: run.id, ...options };
}

test("the dashboard lists runs and filters by status", async ({ page }) => {
  const { runId } = await seedRun(page, "queued");

  await page.goto("/runs");
  await expect(page.getByTestId(`run-row-${runId}`)).toBeVisible();
  await expect(page.getByTestId(`run-row-${runId}`)).toHaveAttribute("data-run-status", "queued");

  await page.getByTestId("runs-filter-failed").click();
  await expect(page.getByTestId(`run-row-${runId}`)).toHaveCount(0);

  await page.getByTestId("runs-filter-queued").click();
  await expect(page.getByTestId(`run-row-${runId}`)).toBeVisible();
});

test("the dashboard shows what a run has cost", async ({ page }) => {
  const { runId } = await seedRun(page, "queued");

  await page.goto("/runs");
  await expect(page.getByTestId(`run-tokens-${runId}`)).toContainText("tokens");
  await expect(page.getByTestId("runs-totals")).toContainText("tokens today");
});

test("a run page links back and shows its usage", async ({ page }) => {
  const { runId } = await seedRun(page, "queued");

  await page.goto(`/runs/${runId}`);
  await expect(page.getByTestId("run-status")).toHaveText("queued");
  await expect(page.getByTestId("run-tokens")).toContainText("tokens");

  // A queued run has nothing to retry.
  await expect(page.getByTestId("run-retry")).toHaveCount(0);
});

test("a token can be stored and is never shown again", async ({ page }) => {
  await page.goto("/settings/secrets");

  await page.getByTestId("secret-name").fill("E2E_TEST_TOKEN");
  await page.getByTestId("secret-value").fill("super-secret-value-12345");

  const saved = page.waitForResponse(
    (response) => response.url().includes("/api/secrets") && response.request().method() === "POST",
  );
  await page.getByTestId("secret-save").click();

  // The response carries names only — the value never comes back.
  const body = await (await saved).text();
  expect(body).toContain("E2E_TEST_TOKEN");
  expect(body).not.toContain("super-secret-value-12345");

  await expect(page.getByTestId("secret-E2E_TEST_TOKEN")).toBeVisible();
  await expect(page.getByTestId("secret-message")).toContainText("will not be shown again");
  // The input is cleared the moment it is submitted.
  await expect(page.getByTestId("secret-value")).toHaveValue("");

  // And a reload shows the name with no value anywhere on the page.
  await page.reload();
  await expect(page.getByTestId("secret-E2E_TEST_TOKEN")).toBeVisible();
  expect(await page.content()).not.toContain("super-secret-value-12345");

  await page.getByTestId("secret-remove-E2E_TEST_TOKEN").click();
  await expect(page.getByTestId("secret-E2E_TEST_TOKEN")).toHaveCount(0);
});

test("a bad secret name is refused with an explanation", async ({ page }) => {
  await page.goto("/settings/secrets");

  await page.getByTestId("secret-name").fill("lower case");
  await page.getByTestId("secret-value").fill("x");
  await page.getByTestId("secret-save").click();

  await expect(page.getByTestId("secret-error")).toContainText("UPPER_SNAKE_CASE");
});
