import { expect, test, type Page } from "@playwright/test";

/**
 * board.spec.ts — the daily driver (Phase 3), per docs/TESTING.md.
 *
 * Quick-add, drag across columns, edit the brief, and prove a blocked card is
 * refused and rolled back. Runs against the real app and database.
 */

/**
 * Open a board of this test's own. Tests run in parallel against one database,
 * and a shared board would let them reorder each other's cards.
 */
async function openFreshBoard(page: Page) {
  const response = await page.request.post("/api/boards", {
    data: { name: `Test board ${Date.now()}-${Math.round(performance.now())}` },
  });
  const board = (await response.json()) as { id: string };
  await page.goto(`/?board=${board.id}`);
  await expect(page.locator('[data-column-kind="backlog"]')).toBeVisible();
  return board.id;
}

/** Column ids are generated, so find them by their semantic kind. */
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

/**
 * Drag a card onto a column's drop zone, and wait for the move to be persisted.
 *
 * The board is optimistic: the card appears in its new column before the server
 * has answered. Asserting on the card alone would therefore pass even if the
 * write never landed — so wait for the response too.
 */
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
  // dnd-kit needs travel past its activation distance, and intermediate moves.
  await page.mouse.move(to.x + to.width / 2, to.y + 30, { steps: 12 });
  await page.mouse.up();

  return moved;
}

/** Wait for a card edit (PATCH) to be persisted before reloading. */
function savedEdit(page: Page) {
  return page.waitForResponse(
    (response) => response.url().includes("/api/tasks/") && response.request().method() === "PATCH",
  );
}

test("the app opens on the board", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-column-kind="backlog"]')).toBeVisible();
  await expect(page.locator('[data-column-kind="working"]')).toBeVisible();
  await expect(page.locator('[data-column-kind="done"]')).toBeVisible();
});

test("a card can be quick-added, dragged two columns right, and survives a reload", async ({
  page,
}) => {
  await openFreshBoard(page);
  const title = `Fix login redirect ${Date.now()}`;
  await addCard(page, "backlog", title);

  await dragCardTo(page, title, "ready");
  await dragCardTo(page, title, "working");

  const workingId = await columnId(page, "working");
  await expect(
    page.getByTestId(`column-${workingId}`).locator(`[data-task-title="${title}"]`),
  ).toBeVisible();

  await page.reload();
  await expect(
    page.getByTestId(`column-${workingId}`).locator(`[data-task-title="${title}"]`),
  ).toBeVisible();
});

test("cards keep their order within a column across a reload", async ({ page }) => {
  await openFreshBoard(page);
  const stamp = Date.now();
  const backlogId = await columnId(page, "backlog");

  for (const name of ["alpha", "beta", "gamma"]) {
    await addCard(page, "backlog", `${name} ${stamp}`);
  }

  const ownTitles = async () =>
    page
      .getByTestId(`column-${backlogId}`)
      .locator(`[data-task-title$="${stamp}"]`)
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-task-title")));

  // Quick-add puts each new card at the TOP, where the input is and the eye
  // already is — so the newest is first.
  const before = await ownTitles();
  expect(before).toEqual([`gamma ${stamp}`, `beta ${stamp}`, `alpha ${stamp}`]);

  await page.reload();
  // evaluateAll does not auto-wait, so let the reloaded board render first.
  await expect(page.locator(`[data-task-title$="${stamp}"]`)).toHaveCount(3);
  expect(await ownTitles()).toEqual(before);
});

test("the brief can be edited in the drawer and is persisted", async ({ page }) => {
  await openFreshBoard(page);
  const title = `Refactor auth ${Date.now()}`;
  await addCard(page, "backlog", title);

  await page.locator(`[data-task-title="${title}"]`).dblclick();
  await expect(page.getByTestId("task-drawer")).toBeVisible();

  // The body is explicitly the agent's brief.
  await expect(page.getByText("this is what the agent reads")).toBeVisible();

  await page.getByTestId("drawer-body").fill("## Steps\n1. reproduce the redirect");
  const bodySaved = savedEdit(page);
  await page.getByTestId("drawer-body").blur();
  await bodySaved;

  const prioritySaved = savedEdit(page);
  await page.getByTestId("drawer-priority").selectOption("urgent");
  await prioritySaved;

  await page.reload();
  await page.locator(`[data-task-title="${title}"]`).dblclick();
  await expect(page.getByTestId("drawer-body")).toHaveValue(/reproduce the redirect/);
  await expect(page.getByTestId("drawer-priority")).toHaveValue("urgent");
});

test("the timeline records what happened to a card", async ({ page }) => {
  await openFreshBoard(page);
  const title = `Timeline ${Date.now()}`;
  await addCard(page, "backlog", title);

  await dragCardTo(page, title, "ready");
  await page.locator(`[data-task-title="${title}"]`).dblclick();

  await expect(page.getByTestId("timeline")).toContainText("Created");
  await expect(page.getByTestId("timeline")).toContainText("Moved from Backlog to Todo");

  await page.getByTestId("drawer-comment").fill("Check the SSO callback first.");
  await page.getByTestId("post-comment").click();
  await expect(page.getByTestId("timeline")).toContainText("Check the SSO callback first.");
});

test("a blocked card is refused by a working column and rolls back", async ({ page }) => {
  await openFreshBoard(page);
  const stamp = Date.now();

  const blockerTitle = `Blocker ${stamp}`;
  const blockedTitle = `Blocked ${stamp}`;
  await addCard(page, "backlog", blockerTitle);
  await addCard(page, "backlog", blockedTitle);

  // Point the second card at the first via the API — blockedBy has no UI yet.
  const blockerId = await page
    .locator(`[data-task-title="${blockerTitle}"]`)
    .getAttribute("data-testid");
  const blockedId = await page
    .locator(`[data-task-title="${blockedTitle}"]`)
    .getAttribute("data-testid");

  await page.request.patch(`/api/tasks/${blockedId!.replace("card-", "")}`, {
    data: { blockedBy: [blockerId!.replace("card-", "")] },
  });
  await page.reload();

  await expect(page.getByTestId(`card-blocked-${blockedId!.replace("card-", "")}`)).toBeVisible();

  const backlogId = await columnId(page, "backlog");
  await dragCardTo(page, blockedTitle, "working");

  // The move is refused, the reason is shown, and the card is back where it was.
  await expect(page.getByTestId("move-rejected")).toContainText("Blocked by 1 unfinished task");
  await expect(
    page.getByTestId(`column-${backlogId}`).locator(`[data-task-title="${blockedTitle}"]`),
  ).toBeVisible();
});

test("the board is fully operable from the keyboard", async ({ page }) => {
  await openFreshBoard(page);
  const title = `Keyboard ${Date.now()}`;

  // `n` focuses the first column's quick-add.
  await page.locator("body").click();
  await page.keyboard.press("n");
  await page.keyboard.type(title);
  await page.keyboard.press("Enter");
  await expect(page.locator(`[data-task-title="${title}"]`)).toBeVisible();

  // `Escape` leaves the input, `j` selects, `3` moves to the third column.
  await page.keyboard.press("Escape");
  await page.keyboard.press("j");
  await page.keyboard.press("3");

  const workingId = await columnId(page, "working");
  await expect(
    page.getByTestId(`column-${workingId}`).locator("[data-task-title]").first(),
  ).toBeVisible();

  // `Enter` opens the drawer for the selected card, `Escape` closes it.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("task-drawer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("task-drawer")).toBeHidden();
});

test("filtering narrows the board and is captured in the URL", async ({ page }) => {
  await openFreshBoard(page);
  const stamp = Date.now();
  await addCard(page, "backlog", `Findable ${stamp}`);
  await addCard(page, "backlog", `Hidden ${stamp}`);

  // Quick-add left the focus in an input, and shortcuts never hijack typing —
  // so step out of the field first, exactly as a user would.
  await page.keyboard.press("Escape");
  await page.keyboard.press("/");
  await page.keyboard.type(`Findable ${stamp}`);

  await expect(page.locator(`[data-task-title="Findable ${stamp}"]`)).toBeVisible();
  await expect(page.locator(`[data-task-title="Hidden ${stamp}"]`)).toBeHidden();
  await expect(page).toHaveURL(/[?&]q=Findable/);

  // The filtered view is a link: opening the URL fresh reproduces it.
  await page.reload();
  await expect(page.locator(`[data-task-title="Hidden ${stamp}"]`)).toBeHidden();

  await page.getByTestId("clear-filters").click();
  await expect(page.locator(`[data-task-title="Hidden ${stamp}"]`)).toBeVisible();
});
