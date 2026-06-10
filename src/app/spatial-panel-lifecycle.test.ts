// @vitest-environment jsdom
import {
  createSpatialPanelLifecycle,
  SPATIAL_VIEW_STORAGE_KEY,
} from "./spatial-panel-lifecycle";
import type { SpatialPanelDeps } from "./spatial-panel-lifecycle";
import type { SpatialViewHandle } from "./lazy-view-lifecycle";

function makeHandle(): SpatialViewHandle {
  return {
    update: vi.fn(),
    highlight: vi.fn(),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
}

function makeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    dump: () => Object.fromEntries(store),
  };
}

function makeDeps(overrides: Partial<SpatialPanelDeps> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const radarHandle = makeHandle();
  const mapHandle = makeHandle();
  const createRadarView = vi.fn(() => radarHandle);
  const createBrowseMap = vi.fn(() => mapHandle);
  const deps: SpatialPanelDeps = {
    container,
    onSelectArticle: vi.fn(),
    importRadarView: () => Promise.resolve({ createRadarView }),
    importBrowseMap: () => Promise.resolve({ createBrowseMap }),
    storage: makeStorage(),
    ...overrides,
  };
  return {
    deps,
    container,
    radarHandle,
    mapHandle,
    createRadarView,
    createBrowseMap,
  };
}

/** Flush dynamic-import microtasks + the rAF-deferred creation step. */
async function flushImportAndRaf(): Promise<void> {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(20);
}

const POS = { lat: 59.3, lon: 18.1 };
const ARTICLES = [{ title: "Castle", lat: 59.31, lon: 18.11, distanceM: 1200 }];

describe("SpatialPanelLifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.textContent = "";
  });

  describe("first update", () => {
    it("builds tabs and shows the radar by default", async () => {
      const { deps, container, createRadarView, createBrowseMap } = makeDeps();
      const panel = createSpatialPanelLifecycle(deps);

      panel.update(POS, ARTICLES);
      await flushImportAndRaf();

      expect(container.querySelector(".spatial-tabs")).toBeTruthy();
      expect(
        container.querySelector<HTMLElement>(".spatial-slot-radar")?.hidden,
      ).toBe(false);
      expect(
        container.querySelector<HTMLElement>(".spatial-slot-map")?.hidden,
      ).toBe(true);
      expect(createRadarView).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        POS,
        ARTICLES,
        deps.onSelectArticle,
      );
      expect(createBrowseMap).not.toHaveBeenCalled();
    });

    it("respects a stored map preference", async () => {
      const { deps, container, createRadarView, createBrowseMap } = makeDeps({
        storage: makeStorage({ [SPATIAL_VIEW_STORAGE_KEY]: "map" }),
      });
      const panel = createSpatialPanelLifecycle(deps);

      panel.update(POS, ARTICLES);
      await flushImportAndRaf();

      expect(createBrowseMap).toHaveBeenCalled();
      expect(createRadarView).not.toHaveBeenCalled();
      expect(
        container.querySelector<HTMLElement>(".spatial-slot-map")?.hidden,
      ).toBe(false);
    });

    it("falls back to radar for unknown stored values", async () => {
      const { deps, createRadarView } = makeDeps({
        storage: makeStorage({ [SPATIAL_VIEW_STORAGE_KEY]: "hologram" }),
      });
      const panel = createSpatialPanelLifecycle(deps);

      panel.update(POS, ARTICLES);
      await flushImportAndRaf();

      expect(createRadarView).toHaveBeenCalled();
    });
  });

  describe("tab switching", () => {
    it("activates the map with the latest data and persists the choice", async () => {
      const storage = makeStorage();
      const { deps, container, createBrowseMap } = makeDeps({ storage });
      const panel = createSpatialPanelLifecycle(deps);

      panel.update(POS, ARTICLES);
      panel.highlight("Castle");
      await flushImportAndRaf();

      container.querySelector<HTMLButtonElement>(".spatial-tab-map")!.click();
      await flushImportAndRaf();

      expect(createBrowseMap).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        POS,
        ARTICLES,
        deps.onSelectArticle,
      );
      expect(storage.dump()[SPATIAL_VIEW_STORAGE_KEY]).toBe("map");
      expect(
        container.querySelector<HTMLElement>(".spatial-slot-radar")?.hidden,
      ).toBe(true);
    });

    it("replays the stored highlight to the newly activated view", async () => {
      const { deps, container, mapHandle } = makeDeps();
      const panel = createSpatialPanelLifecycle(deps);

      panel.update(POS, ARTICLES);
      await flushImportAndRaf();
      panel.highlight("Castle");

      container.querySelector<HTMLButtonElement>(".spatial-tab-map")!.click();
      await flushImportAndRaf();

      expect(mapHandle.highlight).toHaveBeenCalledWith("Castle");
    });

    it("marks the active tab with aria-pressed", async () => {
      const { deps, container } = makeDeps();
      const panel = createSpatialPanelLifecycle(deps);

      panel.update(POS, ARTICLES);
      await flushImportAndRaf();

      const radarTab = container.querySelector(".spatial-tab-radar")!;
      const mapTab =
        container.querySelector<HTMLButtonElement>(".spatial-tab-map")!;
      expect(radarTab.getAttribute("aria-pressed")).toBe("true");
      expect(mapTab.getAttribute("aria-pressed")).toBe("false");

      mapTab.click();
      expect(radarTab.getAttribute("aria-pressed")).toBe("false");
      expect(mapTab.getAttribute("aria-pressed")).toBe("true");
    });

    it("returning to a previously created view re-sends the latest data", async () => {
      const { deps, container, radarHandle } = makeDeps();
      const panel = createSpatialPanelLifecycle(deps);

      panel.update(POS, ARTICLES);
      await flushImportAndRaf();

      container.querySelector<HTMLButtonElement>(".spatial-tab-map")!.click();
      await flushImportAndRaf();

      const newer = [
        { title: "Bridge", lat: 59.32, lon: 18.12, distanceM: 600 },
      ];
      panel.update(POS, newer);

      container.querySelector<HTMLButtonElement>(".spatial-tab-radar")!.click();

      expect(radarHandle.update).toHaveBeenLastCalledWith(POS, newer);
    });

    it("keeps working when the preference cannot be persisted", async () => {
      const storage = {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
      };
      const { deps, container, createBrowseMap } = makeDeps({ storage });
      const panel = createSpatialPanelLifecycle(deps);

      panel.update(POS, ARTICLES);
      await flushImportAndRaf();

      container.querySelector<HTMLButtonElement>(".spatial-tab-map")!.click();
      await flushImportAndRaf();

      expect(createBrowseMap).toHaveBeenCalled();
    });
  });

  describe("forwarding", () => {
    it("forwards updates only to the active view", async () => {
      const { deps, container, radarHandle, mapHandle } = makeDeps();
      const panel = createSpatialPanelLifecycle(deps);

      panel.update(POS, ARTICLES);
      await flushImportAndRaf();
      panel.update(POS, []);

      expect(radarHandle.update).toHaveBeenLastCalledWith(POS, []);
      expect(mapHandle.update).not.toHaveBeenCalled();
      expect(container).toBeTruthy();
    });

    it("forwards resize to the active view", async () => {
      const { deps, radarHandle } = makeDeps();
      const panel = createSpatialPanelLifecycle(deps);

      panel.update(POS, ARTICLES);
      await flushImportAndRaf();
      panel.resize();

      expect(radarHandle.resize).toHaveBeenCalled();
    });

    it("is safe to highlight and resize before any update", () => {
      const { deps } = makeDeps();
      const panel = createSpatialPanelLifecycle(deps);
      panel.highlight("Castle");
      panel.resize(); // should not throw
    });
  });

  describe("destroy", () => {
    it("tears down views and panel DOM, then revives on the next update", async () => {
      const { deps, container, radarHandle, createRadarView } = makeDeps();
      const panel = createSpatialPanelLifecycle(deps);

      panel.update(POS, ARTICLES);
      await flushImportAndRaf();

      panel.destroy();

      expect(radarHandle.destroy).toHaveBeenCalled();
      expect(container.querySelector(".spatial-panel")).toBeNull();

      panel.update(POS, ARTICLES);
      await flushImportAndRaf();

      expect(container.querySelector(".spatial-panel")).toBeTruthy();
      expect(createRadarView).toHaveBeenCalledTimes(2);
    });

    it("is safe to call twice and before any update", () => {
      const { deps } = makeDeps();
      const panel = createSpatialPanelLifecycle(deps);
      panel.destroy();
      panel.destroy(); // should not throw
    });
  });
});
