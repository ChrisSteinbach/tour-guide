// @vitest-environment jsdom
import { createMapPanelLifecycle } from "./map-panel-lifecycle";
import type { MapPanelLifecycleDeps } from "./map-panel-lifecycle";
import type { MapDrawer } from "./map-drawer";
import type { BrowseMapLifecycle } from "./browse-map-lifecycle";
import type { MapPickerLifecycle } from "./map-picker-lifecycle";
import type { AppState, QueryState } from "./state-machine";
import type { UserPosition } from "./types";

// Mock the three sub-lifecycle factories so we can observe the wiring
// without spinning up any real maps.
let drawerStub: MapDrawer;
let browseMapStub: BrowseMapLifecycle;
let mapPickerStub: MapPickerLifecycle;

vi.mock("./map-drawer", () => ({
  createMapDrawer: vi.fn(() => drawerStub),
}));

vi.mock("./browse-map-lifecycle", () => ({
  createBrowseMapLifecycle: vi.fn(() => browseMapStub),
}));

vi.mock("./map-picker-lifecycle", () => ({
  createMapPickerLifecycle: vi.fn(() => mapPickerStub),
}));

const pos: UserPosition = { lat: 59.33, lon: 18.07 };

function makeQueryState(): QueryState {
  return {
    mode: "tiled",
    index: {
      version: 1,
      gridDeg: 5,
      bufferDeg: 0.5,
      generated: "",
      tiles: [],
    },
    tileMap: new Map(),
    tiles: new Map(),
  };
}

function makeBrowsingState(): AppState {
  return {
    phase: {
      phase: "browsing",
      articles: [],
      nearbyCount: 10,
      paused: false,
      pauseReason: null,
      lastQueryPos: pos,
      scrollMode: "infinite",
      infiniteScrollLimit: 200,
    },
    query: makeQueryState(),
    position: pos,
    positionSource: "gps",
    currentLang: "en",
    loadGeneration: 1,
    loadingTiles: new Set(),
    downloadProgress: -1,
    updateBanner: null,
    hasGeolocation: true,
    gpsSignalLost: false,
    viewportFillCount: 15,
    aboutOpen: false,
  };
}

function makeNonBrowsingState(): AppState {
  return { ...makeBrowsingState(), phase: { phase: "locating" } };
}

function makeDrawer(isOpenValue = false): MapDrawer {
  const panel = document.createElement("div");
  panel.className = "map-drawer";
  document.body.appendChild(panel);
  const element = document.createElement("div");
  panel.appendChild(element);
  let openState = isOpenValue;
  return {
    open: vi.fn(() => {
      openState = true;
    }),
    close: vi.fn(() => {
      openState = false;
    }),
    toggle: vi.fn(),
    isOpen: vi.fn(() => openState),
    element,
    panel,
    destroy: vi.fn(() => panel.remove()),
  };
}

function makeBrowseMap(): BrowseMapLifecycle {
  return {
    update: vi.fn(),
    highlight: vi.fn(),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
}

function makeMapPicker(): MapPickerLifecycle {
  return { show: vi.fn(), destroy: vi.fn() };
}

/**
 * Minimal MediaQueryList stub. jsdom's window.matchMedia default returns a
 * static list; we need one whose `matches` value we can flip and on which we
 * can dispatch a 'change' event.
 */
function installMockMediaQuery(initialMatches: boolean): {
  setMatches: (v: boolean) => void;
  fireChange: () => void;
} {
  const listeners = new Set<(ev: MediaQueryListEvent) => void>();
  let matches = initialMatches;
  const mql: Partial<MediaQueryList> = {
    get matches() {
      return matches;
    },
    media: "(min-width: 1024px)",
    addEventListener: (type: string, cb: EventListener) => {
      if (type === "change")
        listeners.add(cb as (ev: MediaQueryListEvent) => void);
    },
    removeEventListener: (type: string, cb: EventListener) => {
      if (type === "change")
        listeners.delete(cb as (ev: MediaQueryListEvent) => void);
    },
    dispatchEvent: () => true,
  };
  window.matchMedia = vi.fn(() => mql as MediaQueryList);
  return {
    setMatches: (v: boolean) => {
      matches = v;
    },
    fireChange: () => {
      const event = { matches, media: "(min-width: 1024px)" };
      listeners.forEach((cb) => cb(event as MediaQueryListEvent));
    },
  };
}

function makeDeps(
  overrides: Partial<MapPanelLifecycleDeps> = {},
): MapPanelLifecycleDeps {
  const app = document.createElement("div");
  document.body.appendChild(app);
  const scrollContainer = document.createElement("div");
  document.body.appendChild(scrollContainer);
  return {
    getState: vi.fn(() => makeBrowsingState()),
    dispatch: vi.fn(),
    app,
    getScrollContainer: vi.fn(() => scrollContainer),
    itemHeight: 68,
    appName: "WikiRadar",
    renderBrowsingList: vi.fn(),
    ...overrides,
  };
}

describe("createMapPanelLifecycle", () => {
  beforeEach(() => {
    drawerStub = makeDrawer(false);
    browseMapStub = makeBrowseMap();
    mapPickerStub = makeMapPicker();
    installMockMediaQuery(false);
  });

  afterEach(() => {
    document.body.textContent = "";
  });

  it("returns the drawer, browseMap, mapPicker, and desktop query", () => {
    const deps = makeDeps();
    const lifecycle = createMapPanelLifecycle(deps);

    expect(lifecycle.drawer).toBe(drawerStub);
    expect(lifecycle.browseMap).toBe(browseMapStub);
    expect(lifecycle.mapPicker).toBe(mapPickerStub);
    expect(lifecycle.drawerPanel).toBe(drawerStub.panel);
    expect(lifecycle.desktopQuery.media).toBe("(min-width: 1024px)");
  });

  it("marks the drawer panel as hidden at construction time", () => {
    const deps = makeDeps();
    createMapPanelLifecycle(deps);

    expect(drawerStub.panel.hasAttribute("hidden")).toBe(true);
  });

  describe("desktopQuery change listener", () => {
    it("opens the drawer when crossing into desktop during browsing", () => {
      const mq = installMockMediaQuery(false);
      const renderBrowsingList = vi.fn();
      const deps = makeDeps({ renderBrowsingList });
      createMapPanelLifecycle(deps);

      mq.setMatches(true);
      mq.fireChange();

      expect(drawerStub.open).toHaveBeenCalled();
      expect(renderBrowsingList).toHaveBeenCalled();
    });

    it("closes the drawer when crossing into mobile during browsing", () => {
      const mq = installMockMediaQuery(true);
      const renderBrowsingList = vi.fn();
      const deps = makeDeps({ renderBrowsingList });
      createMapPanelLifecycle(deps);

      mq.setMatches(false);
      mq.fireChange();

      expect(drawerStub.close).toHaveBeenCalled();
      expect(renderBrowsingList).toHaveBeenCalled();
    });

    it("does nothing when the phase is not browsing", () => {
      const mq = installMockMediaQuery(false);
      const renderBrowsingList = vi.fn();
      const deps = makeDeps({
        getState: () => makeNonBrowsingState(),
        renderBrowsingList,
      });
      createMapPanelLifecycle(deps);

      mq.setMatches(true);
      mq.fireChange();

      expect(drawerStub.open).not.toHaveBeenCalled();
      expect(drawerStub.close).not.toHaveBeenCalled();
      expect(renderBrowsingList).not.toHaveBeenCalled();
    });
  });

  describe("drawerPanel transitionend listener", () => {
    it("calls browseMap.resize when transform transition ends with drawer open", () => {
      drawerStub = makeDrawer(true);
      const deps = makeDeps();
      createMapPanelLifecycle(deps);

      const event = new Event("transitionend") as TransitionEvent;
      Object.defineProperty(event, "propertyName", { value: "transform" });
      drawerStub.panel.dispatchEvent(event);

      expect(browseMapStub.resize).toHaveBeenCalled();
    });

    it("does not resize when the transitioned property is not transform", () => {
      drawerStub = makeDrawer(true);
      const deps = makeDeps();
      createMapPanelLifecycle(deps);

      const event = new Event("transitionend") as TransitionEvent;
      Object.defineProperty(event, "propertyName", { value: "opacity" });
      drawerStub.panel.dispatchEvent(event);

      expect(browseMapStub.resize).not.toHaveBeenCalled();
    });

    it("does not resize when the drawer is closed", () => {
      drawerStub = makeDrawer(false);
      const deps = makeDeps();
      createMapPanelLifecycle(deps);

      const event = new Event("transitionend") as TransitionEvent;
      Object.defineProperty(event, "propertyName", { value: "transform" });
      drawerStub.panel.dispatchEvent(event);

      expect(browseMapStub.resize).not.toHaveBeenCalled();
    });
  });

  describe("destroy", () => {
    it("removes the desktopQuery change listener so later changes are ignored", () => {
      const mq = installMockMediaQuery(false);
      const renderBrowsingList = vi.fn();
      const deps = makeDeps({ renderBrowsingList });
      const lifecycle = createMapPanelLifecycle(deps);

      lifecycle.destroy();

      mq.setMatches(true);
      mq.fireChange();

      expect(drawerStub.open).not.toHaveBeenCalled();
      expect(renderBrowsingList).not.toHaveBeenCalled();
    });

    it("removes the drawerPanel transitionend listener so later events are ignored", () => {
      drawerStub = makeDrawer(true);
      const deps = makeDeps();
      const lifecycle = createMapPanelLifecycle(deps);

      lifecycle.destroy();

      const event = new Event("transitionend") as TransitionEvent;
      Object.defineProperty(event, "propertyName", { value: "transform" });
      drawerStub.panel.dispatchEvent(event);

      expect(browseMapStub.resize).not.toHaveBeenCalled();
    });

    it("is safe to call more than once", () => {
      const deps = makeDeps();
      const lifecycle = createMapPanelLifecycle(deps);

      lifecycle.destroy();
      expect(() => lifecycle.destroy()).not.toThrow();
    });

    it("tears down the drawer, browseMap, and mapPicker sub-lifecycles", () => {
      const deps = makeDeps();
      const lifecycle = createMapPanelLifecycle(deps);

      lifecycle.destroy();

      expect(drawerStub.destroy).toHaveBeenCalled();
      expect(browseMapStub.destroy).toHaveBeenCalled();
      expect(mapPickerStub.destroy).toHaveBeenCalled();
    });

    it("removes the drawer panel from the DOM", () => {
      const deps = makeDeps();
      const lifecycle = createMapPanelLifecycle(deps);
      const panel = drawerStub.panel;
      expect(panel.parentNode).not.toBeNull();

      lifecycle.destroy();

      expect(panel.parentNode).toBeNull();
    });
  });

  describe("onHoverArticle", () => {
    it("delegates to browseMap.highlight with the article title", () => {
      const deps = makeDeps();
      const lifecycle = createMapPanelLifecycle(deps);

      lifecycle.onHoverArticle("Stockholm");

      expect(browseMapStub.highlight).toHaveBeenCalledWith("Stockholm");
    });

    it("passes null through to browseMap.highlight to clear the highlight", () => {
      const deps = makeDeps();
      const lifecycle = createMapPanelLifecycle(deps);

      lifecycle.onHoverArticle(null);

      expect(browseMapStub.highlight).toHaveBeenCalledWith(null);
    });
  });
});
