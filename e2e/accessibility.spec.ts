import { test, expect, gotoWelcome, gotoBrowsingViaPick } from "./fixtures";

test.describe("Accessibility", () => {
  test("all interactive elements on welcome screen reachable via Tab", async ({
    wikiPage: page,
  }) => {
    await gotoWelcome(page);

    // Tab through and collect focused element tags/classes
    const focusedElements: string[] = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        return `${el.tagName}${el.className ? "." + el.className.split(" ")[0] : ""}`;
      });
      if (info) focusedElements.push(info);
    }

    // Should reach at least: select, 2 buttons (choices), about button
    expect(focusedElements.length).toBeGreaterThanOrEqual(4);
  });

  test("all buttons have aria-label or visible text", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);

    const buttons = page.locator("button");
    const count = await buttons.count();

    for (let i = 0; i < count; i++) {
      const btn = buttons.nth(i);
      const ariaLabel = await btn.getAttribute("aria-label");
      const text = await btn.textContent();
      const hasLabel =
        (ariaLabel && ariaLabel.length > 0) || (text && text.trim().length > 0);
      expect(hasLabel).toBe(true);
    }
  });

  test("dialog returns focus to trigger button on close", async ({
    wikiPage: page,
  }) => {
    await gotoWelcome(page);
    await page.locator("button.welcome-about").click();

    const dialog = page.locator('dialog[aria-label="About"]');
    await expect(dialog).toBeVisible();

    await dialog.locator('button[aria-label="Close"]').click();
    await expect(dialog).not.toBeVisible();

    // Focus should return to the about button
    const focusedClass = await page.evaluate(
      () => document.activeElement?.className ?? "",
    );
    expect(focusedClass).toContain("welcome-about");
  });

  test("no focus traps outside of dialogs", async ({ wikiPage: page }) => {
    await gotoBrowsingViaPick(page);

    // Tab through many elements — focus should cycle through page
    const focusedTags = new Set<string>();
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      const tag = await page.evaluate(
        () => document.activeElement?.tagName ?? "BODY",
      );
      focusedTags.add(tag);
    }

    // Should reach multiple different element types
    expect(focusedTags.size).toBeGreaterThan(1);
  });

  test("article list items are keyboard-accessible", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);

    // Find and focus an article item
    const firstItem = page.locator(".nearby-item").first();
    await expect(firstItem).toHaveAttribute("role", "button");
    await expect(firstItem).toHaveAttribute("tabindex", "0");

    // Should be focusable
    await firstItem.focus();
    const isFocused = await firstItem.evaluate(
      (el) => document.activeElement === el,
    );
    expect(isFocused).toBe(true);
  });
});
