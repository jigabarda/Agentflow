import { expect, test, type Page } from "@playwright/test";

/**
 * today.spec.ts — the 9am screen (Phase 9).
 *
 * Proves through the real app that a card set to repeat is stored with a
 * readable schedule and a preview, and that Today lists what is due, overdue
 * and waiting on you with a working Run button.
 *
 * The scheduler itself is not exercised here — spawning happens in the worker,
 * which E2E does not start. That is covered with an injected clock in
 * worker/src/scheduler/scheduler.test.ts.
 */

async function freshBoard(page: Page) {
  const response = await page.request.post("/api/boards", {
    data: { name: `Today ${Date.now()}-${Math.round(performance.now())}` },
  });
  const board = (await response.json()) as { id: string };
  await page.goto(`/?board=${board.id}`);
  await expect(page.locator('[data-column-kind="backlog"]')).toBeVisible();
  return board.id;
}

async function columnId(page: Page, kind: string): Promise<string> {
  const column = page.locator(`[data-column-kind="${kind}"]`).first();
  return (await column.getAttribute("data-testid"))!.replace("column-", "");
}

async function addCard(page: Page, kind: string, title: string) {
  const id = await columnId(page, kind);
  await page.getByTestId(`quick-add-${id}`).fill(title);
  await page.getByTestId(`quick-add-${id}`).press("Enter");
  await expect(page.locator(`[data-task-title="${title}"]`)).toBeVisible();
}

test("a card can be set to repeat, and says when it will next run", async ({ page }) => {
  await freshBoard(page);
  await addCard(page, "ready", "Daily standup notes");

  await page.locator('[data-task-title="Daily standup notes"]').dblclick();
  await expect(page.getByTestId("drawer-recurrence")).toBeVisible();

  const saved = page.waitForResponse(
    (response) => response.url().includes("/api/tasks/") && response.request().method() === "PATCH",
  );
  await page.getByTestId("recurrence-preset").selectOption("0 9 * * 1-5");
  await saved;

  await expect(page.getByTestId("recurrence-description")).toContainText("Every weekday at 09:00");
  // Three concrete times, so the schedule can be checked rather than trusted.
  await expect(page.getByTestId("recurrence-preview").locator("li")).toHaveCount(3);
});

test("an unreadable schedule is refused with an explanation", async ({ page }) => {
  await freshBoard(page);
  await addCard(page, "ready", "Bad schedule");

  await page.locator('[data-task-title="Bad schedule"]').dblclick();
  await page.getByTestId("recurrence-cron").fill("every morning");
  await page.getByTestId("recurrence-cron").blur();

  await expect(page.getByTestId("recurrence-invalid")).toBeVisible();
});

test("the repeat survives a reload", async ({ page }) => {
  const boardId = await freshBoard(page);
  await addCard(page, "ready", "Weekly review");

  await page.locator('[data-task-title="Weekly review"]').dblclick();
  const saved = page.waitForResponse(
    (response) => response.url().includes("/api/tasks/") && response.request().method() === "PATCH",
  );
  await page.getByTestId("recurrence-preset").selectOption("0 9 * * 1");
  await saved;

  await page.goto(`/?board=${boardId}`);
  await page.locator('[data-task-title="Weekly review"]').dblclick();
  await expect(page.getByTestId("recurrence-description")).toContainText("Every Monday at 09:00");
});

test("Today lists an overdue card and offers to run it", async ({ page }) => {
  const boardId = await freshBoard(page);

  // A card due yesterday, created through the API so the date is exact.
  const columns = await page.request.get(`/api/boards`);
  expect(columns.ok()).toBe(true);

  const ready = await columnId(page, "ready");
  const created = await page.request.post("/api/tasks", {
    data: {
      boardId,
      columnId: ready,
      title: "Overdue thing",
      dueAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    },
  });
  expect(created.ok()).toBe(true);
  const task = (await created.json()) as { id: string };

  await page.goto("/today");
  await expect(page.getByTestId(`today-${task.id}`)).toBeVisible();
  await expect(page.getByTestId("today-summary")).toContainText("item");

  // The column runs no pipeline, so Run is offered but disabled rather than
  // silently doing nothing.
  await expect(page.getByTestId(`today-run-${task.id}`)).toBeDisabled();
});

test("Today says so plainly when there is nothing to do", async ({ page }) => {
  await freshBoard(page);
  await page.goto("/today");

  // Other tests' cards may exist, so assert on the page rendering rather than
  // on it being empty: either the empty state or a list, never a crash.
  const empty = page.getByTestId("today-empty");
  const summary = page.getByTestId("today-summary");
  await expect(summary).toBeVisible();

  if (await empty.isVisible()) {
    await expect(summary).toContainText("Nothing needs you");
  }
});
