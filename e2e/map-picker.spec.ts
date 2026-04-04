import { test, expect, gotoWelcome } from "./fixtures";

test.describe("Map Picker", () => {
  test("renders map with tiles visible", async ({ wikiPage: page }) => {
    await gotoWelcome(page);
    await page
      .locator("button.welcome-choice", {
        hasText: "Pick a spot on the map",
      })
      .click();

    await expect(page.locator(".leaflet-container")).toBeVisible();
    // Leaflet tile pane should be in the DOM
    await expect(page.locator(".leaflet-tile-pane")).toBeAttached();
  });

  test("clicking the map places a marker and shows confirm button", async ({
    wikiPage: page,
  }) => {
    await gotoWelcome(page);
    await page
      .locator("button.welcome-choice", {
        hasText: "Pick a spot on the map",
      })
      .click();

    await expect(page.locator(".leaflet-container")).toBeVisible();

    // No confirm button yet
    await expect(page.locator("button.map-picker-confirm")).not.toBeVisible();

    // Click on the map
    await page.locator(".leaflet-container").click();

    // Confirm button appears
    await expect(page.locator("button.map-picker-confirm")).toBeVisible();
    await expect(page.locator("button.map-picker-confirm")).toHaveText(
      "Use this location",
    );
  });

  test("confirm button is disabled until a location is picked", async ({
    wikiPage: page,
  }) => {
    await gotoWelcome(page);
    await page
      .locator("button.welcome-choice", {
        hasText: "Pick a spot on the map",
      })
      .click();

    await expect(page.locator(".leaflet-container")).toBeVisible();

    // The confirm button simply doesn't exist until map is clicked
    await expect(page.locator("button.map-picker-confirm")).toHaveCount(0);
  });

  test("clicking confirm navigates to browsing view", async ({
    wikiPage: page,
  }) => {
    await gotoWelcome(page);
    await page
      .locator("button.welcome-choice", {
        hasText: "Pick a spot on the map",
      })
      .click();

    await expect(page.locator(".leaflet-container")).toBeVisible();
    await page.locator(".leaflet-container").click();
    await page.locator("button.map-picker-confirm").click();

    // Should transition to browsing (or downloading/loading tiles first)
    await expect(
      page.locator(".nearby-item, .loading-dot").first(),
    ).toBeVisible({ timeout: 10000 });
  });

  test("picking a new location moves the marker (only one marker at a time)", async ({
    wikiPage: page,
  }) => {
    await gotoWelcome(page);
    await page
      .locator("button.welcome-choice", {
        hasText: "Pick a spot on the map",
      })
      .click();

    const map = page.locator(".leaflet-container");
    await expect(map).toBeVisible();

    // Click at two different positions on the map
    const box = await map.boundingBox();
    if (!box) throw new Error("Map not visible");

    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
    await page.waitForTimeout(200);
    await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.7);
    await page.waitForTimeout(200);

    // Only one CircleMarker should exist (Leaflet renders as SVG path)
    const markers = page.locator(".leaflet-overlay-pane path");
    await expect(markers).toHaveCount(1);
  });

  test("confirm button remains visible at max zoom-out", async ({
    wikiPage: page,
  }) => {
    await gotoWelcome(page);
    await page
      .locator("button.welcome-choice", {
        hasText: "Pick a spot on the map",
      })
      .click();

    await expect(page.locator(".leaflet-container")).toBeVisible();
    await page.locator(".leaflet-container").click();

    // Zoom out fully using keyboard
    const zoomOutBtn = page.locator(".leaflet-control-zoom-out");
    for (let i = 0; i < 5; i++) {
      await zoomOutBtn.click();
      await page.waitForTimeout(100);
    }

    // Confirm button should still be visible and clickable
    const confirmBtn = page.locator("button.map-picker-confirm");
    await expect(confirmBtn).toBeVisible();
    await expect(confirmBtn).toBeEnabled();
  });
});
