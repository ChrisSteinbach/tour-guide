import { test, expect, gotoWelcome, gotoBrowsingViaPick } from "./fixtures";

test.describe("Performance Smoke Tests", () => {
  test("welcome screen loads in < 3 seconds", async ({ wikiPage: page }) => {
    const start = Date.now();
    await gotoWelcome(page);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(3000);
  });

  test("detail view content appears in < 2 seconds after navigation", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);

    const start = Date.now();
    await page.locator(".nearby-item").first().click();
    await expect(page.locator(".detail-content")).toBeVisible({
      timeout: 2000,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
  });
});
