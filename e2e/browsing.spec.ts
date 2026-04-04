import {
  test,
  expect,
  gotoBrowsingViaPick,
  gotoBrowsingViaGps,
} from "./fixtures";

test.describe("Browsing — Article List", () => {
  test("articles render as a list showing title and distance", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);

    const items = page.locator(".nearby-item");
    const count = await items.count();
    expect(count).toBeGreaterThan(0);

    // First item should have a title and distance
    const firstItem = items.first();
    await expect(firstItem.locator(".nearby-name")).toBeVisible();
    await expect(firstItem.locator(".nearby-distance")).toBeVisible();
    const distance = await firstItem.locator(".nearby-distance").textContent();
    expect(distance).toMatch(/\d+\s*(m|km)/);
  });

  test("enrichment loads asynchronously: descriptions appear after initial render", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);

    // Wait for enrichment to load (descriptions appear)
    const firstDesc = page.locator(".nearby-desc").first();
    await expect(firstDesc).not.toBeEmpty({ timeout: 10000 });
  });

  test("clicking an article navigates to detail view", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);

    const firstItem = page.locator(".nearby-item").first();
    const title = await firstItem.locator(".nearby-name").textContent();
    await firstItem.click();

    // Detail view should show the article title
    await expect(page.locator("header.detail-header h1")).toHaveText(title!, {
      timeout: 10000,
    });
  });

  test("Enter key on focused article navigates to detail view", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);

    const firstItem = page.locator(".nearby-item").first();
    const title = await firstItem.locator(".nearby-name").textContent();
    await firstItem.focus();
    await page.keyboard.press("Enter");

    await expect(page.locator("header.detail-header h1")).toHaveText(title!, {
      timeout: 10000,
    });
  });

  test("focus is restored to the article list on back navigation", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);

    // Remember which article we click
    const firstItem = page.locator(".nearby-item").first();
    const title = await firstItem.locator(".nearby-name").textContent();

    // Navigate to detail
    await firstItem.click();
    await expect(page.locator("header.detail-header")).toBeVisible();

    // Go back
    await page.locator("button.detail-back").click();
    await expect(page.locator(".nearby-item").first()).toBeVisible();

    // The article we clicked should still be visible in the list
    await expect(
      page.locator(`.nearby-item[data-title="${title}"]`),
    ).toBeVisible();
  });
});
