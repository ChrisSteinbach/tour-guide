import { test, expect, gotoBrowsingViaGps, PARIS } from "./fixtures";

test.describe("Browsing — GPS Mode", () => {
  test("GPS browsing shows articles near the mocked position", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaGps(page);

    const items = page.locator(".nearby-item");
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
  });

  test("pause button appears in header controls for GPS mode", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaGps(page);

    await expect(page.locator("button.pause-toggle")).toBeVisible();
  });

  test("GPS button is active in GPS mode", async ({ wikiPage: page }) => {
    await gotoBrowsingViaGps(page);

    const gpsBtn = page.locator("button.use-gps-btn");
    await expect(gpsBtn).toHaveAttribute("aria-pressed", "true");
    await expect(gpsBtn).toHaveClass(/mode-active/);
  });
});

test.describe("Pause / Resume", () => {
  test("clicking pause shows paused state in subtitle", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaGps(page);

    await page.locator("button.pause-toggle").click();

    // Subtitle should include "paused"
    const subtitle = page.locator("header.app-header p");
    await expect(subtitle).toContainText("paused");
  });

  test("clicking play resumes updates", async ({ wikiPage: page }) => {
    await gotoBrowsingViaGps(page);

    // Pause
    await page.locator("button.pause-toggle").click();
    await expect(page.locator("header.app-header p")).toContainText("paused");

    // Resume
    await page.locator("button.pause-toggle").click();
    await expect(page.locator("header.app-header p")).not.toContainText(
      "paused",
    );
  });
});
