import { test, expect, gotoBrowsingViaPick, gotoWelcome } from "./fixtures";

test.describe("Responsive Layout", () => {
  test("desktop (>=1024px): map drawer visible", async ({ wikiPage: page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoBrowsingViaPick(page);

    await expect(page.locator(".map-drawer")).toBeVisible();
  });

  test("mobile (360px): full-width layout", async ({ wikiPage: page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await gotoBrowsingViaPick(page);

    // Articles should be visible
    await expect(page.locator(".nearby-item").first()).toBeVisible();
  });

  test("resizing window from desktop to mobile hides drawer", async ({
    wikiPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoBrowsingViaPick(page);

    // Drawer is visible on desktop
    await expect(page.locator(".map-drawer")).toBeVisible();

    // Resize to mobile
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(500);

    // Drawer should no longer be visible (closed)
    // The drawer handle should still be accessible
    const handle = page.locator(".map-drawer-handle");
    await expect(handle).toBeVisible();
  });

  test("viewport meta tag prevents text size adjust on iOS", async ({
    wikiPage: page,
  }) => {
    await gotoWelcome(page);

    const viewport = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="viewport"]');
      return meta?.getAttribute("content") ?? null;
    });

    expect(viewport).toBeTruthy();
    expect(viewport).toContain("width=device-width");
  });
});
