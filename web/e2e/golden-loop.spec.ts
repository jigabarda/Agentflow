import { expect, test, type Page } from "@playwright/test";

/**
 * golden-loop.spec.ts — the board half of the loop (Phase 7).
 *
 * What this proves through the real UI: binding a pipeline to a column, that
 * dropping a card there queues a run, that the run's state reaches the card
 * face over SSE with no reload, and that ▶ Run now does the same deliberately.
 *
 * What it does NOT prove: the agent → PR → auto-move half. Nothing executes a
 * run without the worker, and the worker is not started for E2E. That half is
 * covered end-to-end in worker/src/engine/goldenLoop.integration.test.ts.
 */

async function openBoardWithGoldenLoop(page: Page) {
  const created = await page.request.post("/api/boards", {
    data: { name: `Golden ${Date.now()}-${Math.round(performance.now())}` },
  });
  const board = (await created.json()) as { id: string };

  // Ollama is keyless, so this pipeline is runnable with no API key anywhere —
  // which is the point: the loop must work for someone with no paid account.
  const seeded = await page.request.post(`/api/boards/${board.id}/golden-loop`, {
    data: { repo: "jigabarda/Agentflow", provider: "ollama", model: "qwen2.5-coder" },
  });
  expect(seeded.ok()).toBe(true);
  const loop = (await seeded.json()) as { pipelineId: string };

  await page.request.post(`/api/pipelines/${loop.pipelineId}/credentials`, {
    data: { provider: "ollama", baseUrl: "http://localhost:11434/v1" },
  });

  await page.goto(`/?board=${board.id}`);
  await expect(page.locator('[data-column-kind="backlog"]')).toBeVisible();
  return { boardId: board.id, ...loop };
}

async function columnId(page: Page, kind: string): Promise<string> {
  const column = page.locator(`[data-column-kind="${kind}"]`).first();
  const id = await column.getAttribute("data-testid");
  return id!.replace("column-", "");
}

async function addCard(page: Page, kind: string, title: string) {
  const id = await columnId(page, kind);
  await page.getByTestId(`quick-add-${id}`).fill(title);
  await page.getByTestId(`quick-add-${id}`).press("Enter");
  await expect(page.locator(`[data-task-title="${title}"]`)).toBeVisible();
  return id;
}

async function dragCardTo(page: Page, title: string, kind: string) {
  const card = page.locator(`[data-task-title="${title}"]`);
  const target = page.getByTestId(`dropzone-${await columnId(page, kind)}`);

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

  return moved;
}

test("a column bound to a pipeline shows it is automated", async ({ page }) => {
  await openBoardWithGoldenLoop(page);
  await expect(page.getByTestId(`automated-${await columnId(page, "working")}`)).toBeVisible();
});

test("dropping a card into the automated column queues a run and the card says so", async ({
  page,
}) => {
  await openBoardWithGoldenLoop(page);
  await addCard(page, "ready", "Fix login redirect");

  const moved = await dragCardTo(page, "Fix login redirect", "working");
  const response = await moved;
  expect(response.ok()).toBe(true);

  // The move response carries the run it started.
  const body = (await response.json()) as { runId?: string };
  expect(body.runId).toBeTruthy();

  // And the badge arrives over SSE, with no reload anywhere in this test.
  const card = page.locator('[data-task-title="Fix login redirect"]');
  const badge = card.locator("[data-run-status]");
  await expect(badge).toBeVisible({ timeout: 10_000 });
  await expect(badge).toHaveAttribute("data-run-status", "queued");
});

test("a card dropped into a column with no pipeline starts nothing", async ({ page }) => {
  await openBoardWithGoldenLoop(page);
  await addCard(page, "ready", "Just filing this");

  await await dragCardTo(page, "Just filing this", "backlog");

  const card = page.locator('[data-task-title="Just filing this"]');
  await expect(card).toBeVisible();
  await expect(card.locator("[data-run-status]")).toHaveCount(0);
});

test("the drawer offers Run now, and it queues a run", async ({ page }) => {
  await openBoardWithGoldenLoop(page);
  await addCard(page, "working", "Run me deliberately");

  await page.locator('[data-task-title="Run me deliberately"]').dblclick();
  await expect(page.getByTestId("task-drawer")).toBeVisible();
  await expect(page.getByTestId("drawer-automation")).toContainText("run a pipeline");

  const queued = page.waitForResponse(
    (response) => response.url().includes("/run") && response.request().method() === "POST",
  );
  await page.getByTestId("drawer-run-now").click();
  expect((await queued).status()).toBe(201);

  await expect(page.getByTestId("drawer-run-status")).toHaveText("queued", { timeout: 10_000 });
});

test("Run now is refused on a column that automates nothing", async ({ page }) => {
  await openBoardWithGoldenLoop(page);
  await addCard(page, "backlog", "Nothing to run");

  await page.locator('[data-task-title="Nothing to run"]').dblclick();
  await expect(page.getByTestId("drawer-run-now")).toBeDisabled();
});

test("the timeline records the queued run", async ({ page }) => {
  await openBoardWithGoldenLoop(page);
  await addCard(page, "ready", "Trace me");
  await await dragCardTo(page, "Trace me", "working");

  await page.locator('[data-task-title="Trace me"]').dblclick();
  await expect(page.getByTestId("task-drawer")).toBeVisible();
  await expect(page.getByTestId("timeline")).toContainText("Card → PR");
});
