import { test as base, expect } from "@playwright/test";
import { test, gotoWelcome } from "./fixtures";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FIXTURES_DIR = resolve(import.meta.dirname, "fixtures");
const TILE_INDEX = readFileSync(resolve(FIXTURES_DIR, "index.json"));
const TILE_BIN = readFileSync(resolve(FIXTURES_DIR, "27-36.bin"));

test.describe("Status / Error Screens", () => {
  test("loading screen shows pulsing dot and message", async ({
    wikiPage: page,
  }) => {
    // Delay tile index response so we see the loading screen
    await page.route("**/tiles/en/index.json", async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: TILE_INDEX,
      });
    });

    await gotoWelcome(page);
    await page
      .locator("button.welcome-choice", { hasText: "Use my location" })
      .click();

    // Should see loading state
    await expect(page.locator(".loading-dot")).toBeVisible({ timeout: 3000 });
  });

  test("GPS permission denied shows error and pick-on-map fallback", async ({
    page,
    context,
  }) => {
    // Set up route interception
    await page.route("**/tiles/en/index.json", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: TILE_INDEX,
      }),
    );
    await page.route("**/tiles/en/*.bin", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        body: TILE_BIN,
      }),
    );
    await page.route("**/tile.openstreetmap.org/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          "base64",
        ),
      }),
    );

    // Override geolocation to simulate denial
    await page.addInitScript(() => {
      localStorage.clear();
      indexedDB.deleteDatabase("tour-guide");
      Object.defineProperty(navigator, "geolocation", {
        value: {
          watchPosition: (
            _success: PositionCallback,
            error?: PositionErrorCallback,
          ) => {
            error?.({
              code: 1,
              message: "User denied",
              PERMISSION_DENIED: 1,
              POSITION_UNAVAILABLE: 2,
              TIMEOUT: 3,
            });
            return 1;
          },
          clearWatch: () => {},
          getCurrentPosition: () => {},
        },
        configurable: true,
      });
    });

    await page.goto("/");
    await expect(page.locator(".welcome-choices")).toBeVisible();

    await page
      .locator("button.welcome-choice", { hasText: "Use my location" })
      .click();

    // Should show error message
    await expect(page.locator(".status-message")).toContainText(
      "Location access was denied",
      { timeout: 10000 },
    );

    // "Pick on map" fallback button
    const fallbackBtn = page.locator("button.status-action");
    await expect(fallbackBtn).toHaveText("Pick on map");

    // Clicking it should open the map picker
    await fallbackBtn.click();
    await expect(page.locator(".leaflet-container")).toBeVisible();
  });

  test("data unavailable shows message with language selector", async ({
    wikiPage: page,
  }) => {
    // Remove existing tile data routes and replace with 404
    await page.unroute("**/tiles/en/index.json");
    await page.unroute("**/tiles/en/*.bin");
    await page.route("**/tiles/*/index.json", (route) =>
      route.fulfill({ status: 404 }),
    );

    // Navigate fresh — the app may skip welcome if localStorage has started flag
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("WikiRadar");

    // If welcome screen is shown, click "Use my location"
    const welcomeVisible = await page
      .locator(".welcome-choices")
      .isVisible()
      .catch(() => false);
    if (welcomeVisible) {
      await page
        .locator("button.welcome-choice", { hasText: "Use my location" })
        .click();
    }

    await expect(page.locator(".status-message")).toContainText(
      "No data available",
      { timeout: 10000 },
    );
    await expect(
      page.locator('select[aria-label="Wikipedia language"]'),
    ).toBeVisible();
  });
});
