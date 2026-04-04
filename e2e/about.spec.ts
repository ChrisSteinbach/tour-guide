import { test, expect, gotoWelcome, gotoBrowsingViaPick } from "./fixtures";

test.describe("About Dialog", () => {
  test("opens from welcome screen about link", async ({ wikiPage: page }) => {
    await gotoWelcome(page);
    await page.locator("button.welcome-about").click();

    const dialog = page.locator('dialog[aria-label="About"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("h2")).toHaveText("WikiRadar");
  });

  test("opens from browsing header about button", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);
    await page.locator("button.about-btn").click();

    const dialog = page.locator('dialog[aria-label="About"]');
    await expect(dialog).toBeVisible();
  });

  test("shows title, tagline, and attribution links", async ({
    wikiPage: page,
  }) => {
    await gotoWelcome(page);
    await page.locator("button.welcome-about").click();

    const dialog = page.locator('dialog[aria-label="About"]');
    await expect(dialog.locator("h2")).toHaveText("WikiRadar");
    await expect(dialog.locator(".about-tagline")).toBeVisible();
    await expect(dialog.locator(".about-section")).toBeVisible();
    await expect(dialog.locator('a[href*="wikimedia"]')).toBeVisible();
    await expect(dialog.locator('a[href*="openstreetmap"]')).toBeVisible();
  });

  test("close button closes dialog and returns focus to trigger", async ({
    wikiPage: page,
  }) => {
    await gotoWelcome(page);
    await page.locator("button.welcome-about").click();

    const dialog = page.locator('dialog[aria-label="About"]');
    await expect(dialog).toBeVisible();

    await dialog.locator('button[aria-label="Close"]').click();
    await expect(dialog).not.toBeVisible();

    // Focus should return to the about trigger
    const focused = await page.evaluate(
      () => document.activeElement?.className,
    );
    expect(focused).toContain("welcome-about");
  });

  test("Escape key closes dialog", async ({ wikiPage: page }) => {
    await gotoWelcome(page);
    await page.locator("button.welcome-about").click();

    const dialog = page.locator('dialog[aria-label="About"]');
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });

  test("clicking backdrop closes dialog", async ({ wikiPage: page }) => {
    await gotoWelcome(page);
    await page.locator("button.welcome-about").click();

    const dialog = page.locator('dialog[aria-label="About"]');
    await expect(dialog).toBeVisible();

    // Click outside the dialog (backdrop) — click at page corner
    await page.mouse.click(5, 5);
    await expect(dialog).not.toBeVisible();
  });

  test("external links open in new tab", async ({ wikiPage: page }) => {
    await gotoWelcome(page);
    await page.locator("button.welcome-about").click();

    const dialog = page.locator('dialog[aria-label="About"]');
    const links = dialog.locator("a[target='_blank']");
    const count = await links.count();
    expect(count).toBeGreaterThanOrEqual(2); // Wikipedia + OSM at minimum
  });

  test("Tab key cycles within dialog (focus trap)", async ({
    wikiPage: page,
  }) => {
    await gotoWelcome(page);
    await page.locator("button.welcome-about").click();

    const dialog = page.locator('dialog[aria-label="About"]');
    await expect(dialog).toBeVisible();

    // Count focusable elements inside the dialog
    const focusableCount = await dialog.evaluate((el) => {
      const focusable = el.querySelectorAll("a, button, [tabindex]");
      return focusable.length;
    });

    // Tab through all focusable elements plus a few extra (should wrap)
    let inDialogCount = 0;
    for (let i = 0; i < focusableCount + 2; i++) {
      await page.keyboard.press("Tab");
      const isInDialog = await page.evaluate(() => {
        const dlg = document.querySelector('dialog[aria-label="About"]');
        return dlg?.contains(document.activeElement) ?? false;
      });
      if (isInDialog) inDialogCount++;
    }

    // Most tab presses should stay in the dialog (native showModal traps focus)
    expect(inDialogCount).toBeGreaterThanOrEqual(focusableCount);
  });
});
