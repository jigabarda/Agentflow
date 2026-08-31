import { expect, test, type Page } from "@playwright/test";

/**
 * team-run.spec.ts — the crew (Phase 8).
 *
 * Proves through the real app that a four-role pipeline with a reviewer loop
 * is accepted, validates, binds to a column, and starts on a drop.
 *
 * As in golden-loop.spec.ts, nothing EXECUTES here: there is no worker in E2E.
 * The crew actually running — triage, plan, the loop, the PR — is covered in
 * worker/src/engine/team.integration.test.ts.
 */

const CREW = {
  repo: "jigabarda/Agentflow",
  provider: "ollama",
  models: {
    triager: "qwen2.5-coder",
    planner: "qwen2.5-coder",
    implementer: "deepseek-coder-v2",
    reviewer: "qwen2.5-coder",
  },
};

async function openBoardWithCrew(page: Page) {
  const created = await page.request.post("/api/boards", {
    data: { name: `Crew ${Date.now()}-${Math.round(performance.now())}` },
  });
  const board = (await created.json()) as { id: string };

  const seeded = await page.request.post(`/api/boards/${board.id}/crew`, { data: CREW });
  expect(seeded.ok()).toBe(true);
  const crew = (await seeded.json()) as { pipelineId: string };

  await page.request.post(`/api/pipelines/${crew.pipelineId}/credentials`, {
    data: { provider: "ollama", baseUrl: "http://localhost:11434/v1" },
  });

  await page.goto(`/?board=${board.id}`);
  await expect(page.locator('[data-column-kind="backlog"]')).toBeVisible();
  return { boardId: board.id, ...crew };
}

async function columnId(page: Page, kind: string): Promise<string> {
  const column = page.locator(`[data-column-kind="${kind}"]`).first();
  return (await column.getAttribute("data-testid"))!.replace("column-", "");
}

test("a crew pipeline with a reviewer loop is valid and runnable", async ({ page }) => {
  const { pipelineId } = await openBoardWithCrew(page);

  // The readiness check refuses an invalid graph, so a 201 here means the
  // loop edge passed validation rather than being read as a cycle.
  const run = await page.request.post("/api/runs", { data: { pipelineId } });
  expect(run.status()).toBe(201);
});

test("the crew is bound to the working column", async ({ page }) => {
  await openBoardWithCrew(page);
  await expect(page.getByTestId(`automated-${await columnId(page, "working")}`)).toBeVisible();
});

test("the canvas shows all four roles", async ({ page }) => {
  const { pipelineId } = await openBoardWithCrew(page);
  await page.goto(`/pipelines/${pipelineId}`);

  for (const role of ["Triager", "Planner", "Implementer", "Reviewer"]) {
    await expect(page.getByText(role, { exact: false }).first()).toBeVisible();
  }
});

test("dropping a card on the crew's column starts it", async ({ page }) => {
  await openBoardWithCrew(page);

  const todo = await columnId(page, "ready");
  await page.getByTestId(`quick-add-${todo}`).fill("Fix login redirect");
  await page.getByTestId(`quick-add-${todo}`).press("Enter");
  await expect(page.locator('[data-task-title="Fix login redirect"]')).toBeVisible();

  const card = page.locator('[data-task-title="Fix login redirect"]');
  const target = page.getByTestId(`dropzone-${await columnId(page, "working")}`);
  const from = await card.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("card or target not visible");

  const moved = page.waitForResponse(
    (response) => response.url().includes("/move") && response.request().method() === "POST",
  );

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 20, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 10 });
  await page.mouse.up();

  const body = (await (await moved).json()) as { runId?: string };
  expect(body.runId).toBeTruthy();

  await expect(card.locator("[data-run-status]")).toBeVisible({ timeout: 10_000 });
});
