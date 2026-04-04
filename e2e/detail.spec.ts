import { test, expect, gotoBrowsingViaPick } from "./fixtures";

test.describe("Detail View", () => {
  test("navigating to an article shows title, distance, and loading indicator", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);

    const firstItem = page.locator(".nearby-item").first();
    const title = await firstItem.locator(".nearby-name").textContent();
    await firstItem.click();

    await expect(page.locator("header.detail-header h1")).toHaveText(title!, {
      timeout: 10000,
    });
    await expect(page.locator("header.detail-header p")).toBeVisible();
  });

  test("after fetch: shows thumbnail, description, and extract text", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);
    await page.locator(".nearby-item").first().click();

    // Wait for content to load
    await expect(page.locator(".detail-content")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator(".detail-thumbnail")).toBeVisible();
    await expect(page.locator(".detail-description")).toBeVisible();
    await expect(page.locator(".detail-extract")).toBeVisible();
  });

  test('"Read on Wikipedia" link has target="_blank" and correct href', async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);

    const firstItem = page.locator(".nearby-item").first();
    const title = await firstItem.locator(".nearby-name").textContent();
    await firstItem.click();

    await expect(page.locator(".detail-content")).toBeVisible({
      timeout: 10000,
    });

    const wikiLink = page.locator("a.detail-wiki-link");
    await expect(wikiLink).toHaveText("Read on Wikipedia");
    await expect(wikiLink).toHaveAttribute("target", "_blank");
    const href = await wikiLink.getAttribute("href");
    expect(href).toContain("wikipedia.org");
    expect(href).toContain(encodeURIComponent(title!.replace(/ /g, "_")));
  });

  test('"Directions" link is present with a valid href', async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);
    await page.locator(".nearby-item").first().click();

    await expect(page.locator(".detail-content")).toBeVisible({
      timeout: 10000,
    });

    const directionsLink = page.locator("a.detail-directions-link");
    await expect(directionsLink).toHaveText("Directions");
    const href = await directionsLink.getAttribute("href");
    expect(href).toBeTruthy();
    expect(href!.length).toBeGreaterThan(0);
  });

  test("back button returns to article list", async ({ wikiPage: page }) => {
    await gotoBrowsingViaPick(page);
    await page.locator(".nearby-item").first().click();

    await expect(page.locator("header.detail-header")).toBeVisible();
    await page.locator("button.detail-back").click();

    await expect(page.locator(".nearby-item").first()).toBeVisible();
  });

  test("error state shows error message, retry button, and fallback Wikipedia link", async ({
    page,
    context,
  }) => {
    // Use raw page (not wikiPage) to avoid fixture's Wikipedia route
    // that would cache summaries during browsing enrichment
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 48.8566, longitude: 2.3522 });

    // Tile data routes (needed for browsing)
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const fixturesDir = resolve(import.meta.dirname, "fixtures");
    const tileIndex = readFileSync(resolve(fixturesDir, "index.json"));
    const tileBin = readFileSync(resolve(fixturesDir, "27-36.bin"));

    await page.route("**/tiles/en/index.json", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: tileIndex,
      }),
    );
    await page.route("**/tiles/en/*.bin", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        body: tileBin,
      }),
    );
    await page.route(/\/tiles\/(?!en)\w+\/index\.json$/, (route) =>
      route.fulfill({ status: 404 }),
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

    // Wikipedia API returns 500 — this means enrichment AND detail fetch fail
    await page.route("**/*wikipedia.org/**", (route) => {
      if (route.request().url().includes("/api/rest_v1/page/summary/")) {
        return route.fulfill({ status: 500 });
      }
      return route.continue();
    });

    await page.addInitScript(() => {
      localStorage.clear();
      indexedDB.deleteDatabase("tour-guide");
    });

    // Navigate to browsing via map picker
    await page.goto("/");
    await page
      .locator("button.welcome-choice", { hasText: "Pick a spot on the map" })
      .click();
    await page.locator(".leaflet-container").click();
    await page.locator("button.map-picker-confirm").click();
    await expect(page.locator(".nearby-item").first()).toBeVisible({
      timeout: 10000,
    });

    // Click an article to enter detail view
    await page.locator(".nearby-item").first().click();
    // Wait for error state
    await expect(page.locator(".status-message")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator("button.status-action")).toHaveText("Retry");
    await expect(page.locator("a.detail-wiki-link")).toHaveText(
      "Open on Wikipedia",
    );
  });
});
