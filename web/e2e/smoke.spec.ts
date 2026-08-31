import { expect, test } from "@playwright/test";

// Phase 0 smoke: the app serves. Phase 2 adds editor.spec.ts and Phase 3 the
// board flows — see docs/TESTING.md for the full list of golden journeys.
test("the app serves a page", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
});
