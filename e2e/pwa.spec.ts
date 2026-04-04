import { test, expect, gotoBrowsingViaPick } from "./fixtures";

test.describe("PWA / Service Worker", () => {
  // VitePWA only generates the service worker in production builds.
  // In dev mode (which our E2E server uses), no SW is registered.
  // Skip SW tests unless running against a production build.
  test.skip(
    () => !process.env.E2E_PRODUCTION,
    "Service worker only available in production build",
  );

  test("app registers service worker on load", async ({ wikiPage: page }) => {
    await page.goto("/");
    await page.waitForTimeout(3000);

    const hasServiceWorker = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return false;
      const registrations = await navigator.serviceWorker.getRegistrations();
      return registrations.length > 0;
    });

    expect(hasServiceWorker).toBe(true);
  });
});

test.describe("IDB Cache (tile data)", () => {
  test("after browsing, tiles are cached in IndexedDB", async ({
    wikiPage: page,
  }) => {
    await gotoBrowsingViaPick(page);

    // Wait for data to be loaded and cached
    await page.waitForTimeout(2000);

    const hasCachedTiles = await page.evaluate(async () => {
      return new Promise<boolean>((resolve) => {
        const req = indexedDB.open("tour-guide", 1);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("cache", "readonly");
          const store = tx.objectStore("cache");
          const getAllReq = store.getAllKeys();
          getAllReq.onsuccess = () => {
            const keys = getAllReq.result as string[];
            const hasTile = keys.some(
              (k) => typeof k === "string" && k.startsWith("tile-v1-"),
            );
            resolve(hasTile);
          };
          getAllReq.onerror = () => resolve(false);
        };
        req.onerror = () => resolve(false);
      });
    });

    expect(hasCachedTiles).toBe(true);
  });
});
