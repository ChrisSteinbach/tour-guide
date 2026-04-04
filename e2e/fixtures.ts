/**
 * Shared Playwright fixtures for WikiRadar E2E tests.
 *
 * Provides:
 * - Route interception for tile data (index.json + .bin files)
 * - Route interception for Wikipedia API summaries
 * - Geolocation mocking
 * - Helpers for navigating to the browsing view
 */

import { test as base, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Fixture data ────────────────────────────────────────────

const FIXTURES_DIR = resolve(import.meta.dirname, "fixtures");
const TILE_INDEX = readFileSync(resolve(FIXTURES_DIR, "index.json"));
const TILE_BIN = readFileSync(resolve(FIXTURES_DIR, "27-36.bin"));

/** Default position: near the Eiffel Tower in Paris. */
export const PARIS = { latitude: 48.8566, longitude: 2.3522 };

/** A sample Wikipedia summary for route interception. */
export function makeSummary(title: string) {
  return {
    title,
    extract: `${title} is a landmark in Paris, France.`,
    description: `Landmark in Paris`,
    thumbnail: {
      source:
        "https://upload.wikimedia.org/wikipedia/commons/thumb/placeholder.jpg",
      width: 320,
      height: 240,
    },
    content_urls: {
      desktop: {
        page: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      },
    },
  };
}

// ── Route handlers ──────────────��───────────────────────────

/** Intercept tile data requests and serve canned fixtures. */
async function interceptTileData(page: Page): Promise<void> {
  await page.route("**/tiles/en/index.json", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: TILE_INDEX,
    }),
  );

  await page.route("**/tiles/en/*.bin", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      body: TILE_BIN,
    }),
  );

  // Other languages return 404 by default (no fixture data)
  await page.route(/\/tiles\/(?!en)\w+\/index\.json$/, (route: Route) =>
    route.fulfill({ status: 404 }),
  );
}

/** Intercept Wikipedia API summary requests. */
async function interceptWikipediaApi(page: Page): Promise<void> {
  await page.route(
    "**/*wikipedia.org/api/rest_v1/page/summary/**",
    (route: Route) => {
      const url = route.request().url();
      const titleMatch = url.match(/\/summary\/(.+?)(\?|$)/);
      const title = titleMatch
        ? decodeURIComponent(titleMatch[1]).replace(/_/g, " ")
        : "Unknown";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeSummary(title)),
      });
    },
  );
}

/** Intercept OpenStreetMap tile requests with a transparent pixel. */
async function interceptOsmTiles(page: Page): Promise<void> {
  await page.route("**/tile.openstreetmap.org/**", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      // 1x1 transparent PNG
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    }),
  );
}

// ── Custom test fixture ───────��─────────────────────────────

type WikiRadarFixtures = {
  /** Page with tile data, Wikipedia API, and OSM tiles intercepted. */
  wikiPage: Page;
};

export const test = base.extend<WikiRadarFixtures>({
  wikiPage: async ({ page, context }, use) => {
    // Grant geolocation permission and set default position
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation(PARIS);

    // Set up route interception before navigating
    await interceptTileData(page);
    await interceptWikipediaApi(page);
    await interceptOsmTiles(page);

    // Clear stored state so each test starts fresh
    await page.addInitScript(() => {
      localStorage.clear();
      indexedDB.deleteDatabase("tour-guide");
    });

    await use(page);
  },
});

export { expect };

// ── Navigation helpers ──────────────────────────────────────

/** Navigate to the app and wait for the welcome screen. */
export async function gotoWelcome(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("WikiRadar");
  await expect(page.locator(".welcome-choices")).toBeVisible();
}

/** Navigate to the browsing view via "Pick a spot on the map". */
export async function gotoBrowsingViaPick(page: Page): Promise<void> {
  await gotoWelcome(page);
  await page
    .locator("button.welcome-choice", { hasText: "Pick a spot on the map" })
    .click();

  // Wait for map picker to render
  await expect(page.locator(".leaflet-container")).toBeVisible();

  // Click a location on the map (center of viewport)
  const mapContainer = page.locator(".leaflet-container");
  await mapContainer.click();

  // Wait for confirm button and click it
  const confirmBtn = page.locator("button.map-picker-confirm");
  await expect(confirmBtn).toBeVisible();
  await confirmBtn.click();

  // Wait for browsing view to appear (use .nearby-item since the list
  // container may have both .virtual-scroll-container and .nearby-list)
  await expect(page.locator(".nearby-item").first()).toBeVisible({
    timeout: 10000,
  });
  // Let the virtual scroll lifecycle settle before interacting
  await page.waitForTimeout(300);
}

/** Navigate to the browsing view via "Use my location" (GPS). */
export async function gotoBrowsingViaGps(page: Page): Promise<void> {
  await gotoWelcome(page);
  await page
    .locator("button.welcome-choice", { hasText: "Use my location" })
    .click();

  // Wait for browsing view
  await expect(page.locator(".nearby-item").first()).toBeVisible({
    timeout: 10000,
  });
  // Let the virtual scroll lifecycle settle before interacting
  await page.waitForTimeout(300);
}
