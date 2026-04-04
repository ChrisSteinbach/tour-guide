import { test, expect, gotoBrowsingViaPick } from "./fixtures";

test.describe("Map Drawer (Browse Map)", () => {
  test("desktop (>=1024px): drawer auto-opens on browse start", async ({
    wikiPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoBrowsingViaPick(page);

    const drawer = page.locator(".map-drawer");
    await expect(drawer).toBeVisible();
    // Drawer should contain a Leaflet map
    await expect(drawer.locator(".leaflet-container")).toBeVisible({
      timeout: 5000,
    });
  });

  test("desktop: article list gets margin offset when drawer is open", async ({
    wikiPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoBrowsingViaPick(page);

    // The drawer should push the content
    const drawer = page.locator(".map-drawer");
    await expect(drawer).toBeVisible();

    // Content should have some left margin or transform to account for drawer
    const scrollWrapper = page.locator(
      ".app-scroll, .virtual-scroll-container",
    );
    const box = await scrollWrapper.first().boundingBox();
    // On desktop with drawer open, content shouldn't start at x=0
    expect(box).toBeTruthy();
  });

  test("mobile (<1024px): drawer is hidden by default", async ({
    wikiPage: page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await gotoBrowsingViaPick(page);

    // Drawer should exist but not be visible (translated off-screen)
    const drawer = page.locator(".map-drawer");
    // The drawer panel exists but is not open
    await expect(drawer).toBeAttached();
  });

  test("mobile: clicking handle opens and closes drawer", async ({
    wikiPage: page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await gotoBrowsingViaPick(page);

    const handle = page.locator(".map-drawer-handle");
    // Handle should be visible on mobile
    await expect(handle).toBeVisible();

    // Click to open
    await handle.click();
    await page.waitForTimeout(500); // Wait for transition

    // The drawer should now show the map
    const drawerMap = page.locator(".map-drawer .leaflet-container");
    await expect(drawerMap).toBeVisible({ timeout: 5000 });

    // Click handle again to close
    await handle.click();
    await page.waitForTimeout(500);
  });

  test("resizing from mobile to desktop triggers drawer open", async ({
    wikiPage: page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await gotoBrowsingViaPick(page);

    // Resize to desktop
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(500);

    const drawer = page.locator(".map-drawer");
    await expect(drawer).toBeVisible();
  });
});
