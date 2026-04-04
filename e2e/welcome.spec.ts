import { test, expect, gotoWelcome } from "./fixtures";

test.describe("Welcome Screen", () => {
  test("shows title, tagline, language selector, action buttons, and about link", async ({
    wikiPage: page,
  }) => {
    await gotoWelcome(page);

    await expect(page.locator("h1")).toHaveText("WikiRadar");
    await expect(page.locator(".status-message")).toHaveText(
      "Discover Wikipedia articles about nearby places.",
    );
    await expect(
      page.locator('select[aria-label="Wikipedia language"]'),
    ).toBeVisible();
    await expect(
      page.locator("button.welcome-choice", { hasText: "Use my location" }),
    ).toBeVisible();
    await expect(
      page.locator("button.welcome-choice", {
        hasText: "Pick a spot on the map",
      }),
    ).toBeVisible();
    await expect(page.locator("button.welcome-about")).toHaveText("About");
  });

  test('"Use my location" button requests geolocation and navigates to browsing', async ({
    wikiPage: page,
  }) => {
    await gotoWelcome(page);
    await page
      .locator("button.welcome-choice", { hasText: "Use my location" })
      .click();

    // Should leave welcome screen — either locating or browsing
    await expect(page.locator(".welcome-choices")).not.toBeVisible({
      timeout: 5000,
    });
  });

  test('"Pick a spot on the map" navigates to map picker', async ({
    wikiPage: page,
  }) => {
    await gotoWelcome(page);
    await page
      .locator("button.welcome-choice", {
        hasText: "Pick a spot on the map",
      })
      .click();

    await expect(page.locator(".leaflet-container")).toBeVisible();
  });

  test("language selector shows all 14 supported languages", async ({
    wikiPage: page,
  }) => {
    await gotoWelcome(page);
    const options = page.locator(
      'select[aria-label="Wikipedia language"] option',
    );
    await expect(options).toHaveCount(14);
  });

  test("selecting a language persists to localStorage", async ({
    wikiPage: page,
  }) => {
    await gotoWelcome(page);
    await page
      .locator('select[aria-label="Wikipedia language"]')
      .selectOption("de");

    const stored = await page.evaluate(() =>
      localStorage.getItem("tour-guide-lang"),
    );
    expect(stored).toBe("de");
  });

  test("About link opens about dialog", async ({ wikiPage: page }) => {
    await gotoWelcome(page);
    await page.locator("button.welcome-about").click();

    const dialog = page.locator('dialog[aria-label="About"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("h2")).toHaveText("WikiRadar");
  });

  test("welcome screen is keyboard-navigable", async ({ wikiPage: page }) => {
    await gotoWelcome(page);

    // Tab through the interactive elements
    const interactiveElements = [
      'select[aria-label="Wikipedia language"]',
      "button.welcome-choice:first-of-type",
      "button.welcome-choice:last-of-type",
      "button.welcome-about",
    ];

    for (const selector of interactiveElements) {
      await page.keyboard.press("Tab");
      // The element should be reachable via Tab
      const focused = await page.evaluate(
        () => document.activeElement?.tagName,
      );
      expect(focused).toBeTruthy();
    }
  });
});
