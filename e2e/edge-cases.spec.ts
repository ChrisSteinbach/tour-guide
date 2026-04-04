import { test, expect, gotoBrowsingViaPick } from "./fixtures";

test.describe("Edge Cases", () => {
  test("rapidly clicking articles does not crash the app", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);

    // Rapidly click on the article list area
    const firstItem = page.locator(".nearby-item").first();
    await firstItem.click({ delay: 0 });
    await page.waitForTimeout(50);
    // Click again — may hit detail view or nothing
    await page.mouse.click(200, 300).catch(() => {});

    // App should not crash — wait and verify it's still functional
    await page.waitForTimeout(1000);

    // Navigate back to a known state via browser back
    await page.goBack().catch(() => {});
    await page.waitForTimeout(500);

    // The page should still be responding
    const title = await page.locator("h1").first().textContent();
    expect(title).toBeTruthy();
  });

  test("browser back button works from detail to browsing", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);

    // Navigate to detail and wait for it to fully render
    await page.locator(".nearby-item").first().click();
    await expect(page.locator("header.detail-header")).toBeVisible({
      timeout: 10000,
    });

    // Browser back should return to browsing
    await page.goBack();
    await expect(page.locator(".nearby-item").first()).toBeVisible({
      timeout: 10000,
    });
  });

  test("resizing from mobile to desktop triggers layout change", async ({
    wikiPage: page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await gotoBrowsingViaPick(page);

    // Resize to desktop
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(500);

    // Drawer should open
    await expect(page.locator(".map-drawer")).toBeVisible();
  });

  test("resizing from desktop to mobile hides drawer", async ({
    wikiPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoBrowsingViaPick(page);

    await expect(page.locator(".map-drawer")).toBeVisible();

    // Resize to mobile
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(500);

    // Drawer handle should be visible instead
    await expect(page.locator(".map-drawer-handle")).toBeVisible();
  });
});
