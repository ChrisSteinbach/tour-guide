import {
  test,
  expect,
  gotoBrowsingViaPick,
  gotoBrowsingViaGps,
} from "./fixtures";

test.describe("Mode Toggle (GPS / Picked)", () => {
  test("GPS button is highlighted when active", async ({ wikiPage: page }) => {
    await gotoBrowsingViaGps(page);

    const gpsBtn = page.locator("button.use-gps-btn");
    await expect(gpsBtn).toHaveAttribute("aria-pressed", "true");
    await expect(gpsBtn).toHaveClass(/mode-active/);
  });

  test("map button is highlighted in picked mode", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);

    const pinBtn = page.locator("button.pick-location-btn");
    await expect(pinBtn).toHaveAttribute("aria-pressed", "true");
    await expect(pinBtn).toHaveClass(/mode-active/);
  });

  test("switching from picked to GPS requests geolocation", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);

    // GPS button should be inactive
    const gpsBtn = page.locator("button.use-gps-btn");
    await expect(gpsBtn).toHaveAttribute("aria-pressed", "false");

    // Click GPS button to switch mode
    await gpsBtn.click();

    // GPS button should now be active
    await expect(gpsBtn).toHaveAttribute("aria-pressed", "true");
    await expect(gpsBtn).toHaveClass(/mode-active/);
  });

  test("switching from GPS to picked opens map picker", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaGps(page);

    const pinBtn = page.locator("button.pick-location-btn");
    await pinBtn.click();

    // Map picker should appear
    await expect(page.locator(".leaflet-container")).toBeVisible();
    await expect(page.locator("button.map-picker-confirm")).not.toBeVisible();
  });
});
