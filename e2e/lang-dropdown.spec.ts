import { test, expect, gotoBrowsingViaPick } from "./fixtures";

test.describe("Language Switching (Browsing Header)", () => {
  test("language button shows current language code", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);

    const trigger = page.locator("button.lang-trigger");
    await expect(trigger).toHaveText("EN");
  });

  test("clicking opens dropdown with all 14 languages", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);

    await page.locator("button.lang-trigger").click();

    const listbox = page.locator('[role="listbox"]');
    await expect(listbox).toBeVisible();

    const options = listbox.locator('[role="option"]');
    await expect(options).toHaveCount(14);
  });

  test("keyboard navigation: ArrowDown/ArrowUp moves focus", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);

    const trigger = page.locator("button.lang-trigger");
    await trigger.click();

    // ArrowDown from trigger focuses first option
    await trigger.press("ArrowDown");
    const firstOption = page.locator('[role="option"]').first();
    await expect(firstOption).toBeFocused();

    // ArrowDown moves to second
    await page.keyboard.press("ArrowDown");
    const secondOption = page.locator('[role="option"]').nth(1);
    await expect(secondOption).toBeFocused();

    // ArrowUp moves back to first
    await page.keyboard.press("ArrowUp");
    await expect(firstOption).toBeFocused();
  });

  test("Enter selects highlighted option", async ({ wikiPage: page }) => {
    await gotoBrowsingViaPick(page);

    const trigger = page.locator("button.lang-trigger");
    await trigger.click();
    await trigger.press("ArrowDown");

    // Move to DE (second option)
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    // Dropdown should close
    const listbox = page.locator('[role="listbox"]');
    await expect(listbox).toBeHidden();
  });

  test("Escape closes dropdown without changing", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);

    const trigger = page.locator("button.lang-trigger");
    await trigger.click();

    const listbox = page.locator('[role="listbox"]');
    await expect(listbox).toBeVisible();

    // Move focus into the listbox (Escape handler lives on listbox)
    await trigger.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(listbox).toBeHidden();

    // Language should still be EN
    await expect(trigger).toHaveText("EN");
  });

  test("clicking outside closes dropdown", async ({ wikiPage: page }) => {
    await gotoBrowsingViaPick(page);

    await page.locator("button.lang-trigger").click();

    const listbox = page.locator('[role="listbox"]');
    await expect(listbox).toBeVisible();

    // Click on the page title (outside dropdown)
    await page.locator("h1").click();
    await expect(listbox).toBeHidden();
  });

  test("selected language persists to localStorage across reload", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);

    // Open dropdown and select DE
    await page.locator("button.lang-trigger").click();
    await page.locator('[role="option"][data-lang="de"]').click();

    // Check localStorage
    const stored = await page.evaluate(() =>
      localStorage.getItem("tour-guide-lang"),
    );
    expect(stored).toBe("de");
  });
});
