// @vitest-environment jsdom

import type { NearbyArticle, UserPosition } from "./types";
import type { AppState, QueryState } from "./state-machine";
import type { ArticleWindow } from "./article-window";
import type { InfiniteScrollLifecycle } from "./infinite-scroll-lifecycle";
import type { MapDrawer } from "./map-drawer";
import type { BrowseMapLifecycle } from "./browse-map-lifecycle";
import type { MapPickerLifecycle } from "./map-picker-lifecycle";
import { createRenderer, type RendererDeps } from "./renderer";

const pos: UserPosition = { lat: 59.33, lon: 18.07 };
const article: NearbyArticle = {
  title: "Stockholm",
  lat: 59.33,
  lon: 18.07,
  distanceM: 42,
};

function tiledBrowsingState(
  overrides: Partial<AppState> = {},
  phaseOverrides: Partial<
    Extract<AppState["phase"], { phase: "browsing" }>
  > = {},
): AppState {
  const query: QueryState = {
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
  return {
    phase: {
      phase: "browsing",
      articles: [article],
      nearbyCount: 15,
      paused: false,
      pauseReason: null,
      lastQueryPos: pos,
      scrollMode: "infinite",
      infiniteScrollLimit: 200,
      ...phaseOverrides,
    },
    query,
    position: pos,
    positionSource: "picked",
    currentLang: "en",
    loadGeneration: 1,
    loadingTiles: new Set(),
    downloadProgress: -1,
    updateBanner: null,
    hasGeolocation: true,
    gpsSignalLost: false,
    viewportFillCount: 15,
    aboutOpen: false,
    ...overrides,
  };
}

function stubArticleWindow(
  overrides: Partial<ArticleWindow> = {},
): ArticleWindow {
  return {
    getArticle: vi.fn(),
    ensureRange: vi.fn(async () => {}),
    totalKnown: vi.fn(() => 0),
    loadedCount: vi.fn(() => 0),
    getLoadedArticles: vi.fn(() => []),
    reset: vi.fn(),
    ...overrides,
  };
}

function stubInfiniteScroll(
  overrides: Partial<InfiniteScrollLifecycle> = {},
): InfiniteScrollLifecycle {
  return {
    init: vi.fn(),
    update: vi.fn(),
    updateHeader: vi.fn(),
    destroy: vi.fn(),
    isActive: vi.fn(() => false),
    virtualList: vi.fn(() => null),
    scrollElement: vi.fn(() => null),
    ...overrides,
  };
}

function stubDrawer(): MapDrawer {
  const panel = document.createElement("div");
  const element = document.createElement("div");
  return {
    open: vi.fn(),
    close: vi.fn(),
    toggle: vi.fn(),
    isOpen: vi.fn(() => false),
    element,
    panel,
    destroy: vi.fn(),
  };
}

function stubBrowseMap(
  overrides: Partial<BrowseMapLifecycle> = {},
): BrowseMapLifecycle {
  return {
    update: vi.fn(),
    highlight: vi.fn(),
    resize: vi.fn(),
    destroy: vi.fn(),
    ...overrides,
  };
}

function stubMapPicker(): MapPickerLifecycle {
  return {
    show: vi.fn(),
    destroy: vi.fn(),
  };
}

function stubDesktopQuery(matches = false): MediaQueryList {
  return {
    matches,
    media: "(min-width: 768px)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList;
}

function makeDeps(overrides: Partial<RendererDeps> = {}): RendererDeps {
  const app = document.createElement("div");
  document.body.appendChild(app);
  const drawerPanel = document.createElement("div");
  const scrollContainer = document.createElement("div");
  Object.defineProperty(scrollContainer, "scrollTop", {
    value: 0,
    configurable: true,
  });
  return {
    getState: vi.fn(() => tiledBrowsingState()),
    dispatch: vi.fn(),
    app,
    infiniteScroll: stubInfiniteScroll(),
    drawer: stubDrawer(),
    drawerPanel,
    desktopQuery: stubDesktopQuery(false),
    browseMap: stubBrowseMap(),
    mapPicker: stubMapPicker(),
    resetArticleWindow: vi.fn(),
    getCurrentWindow: vi.fn(() => null),
    getArticleByIndex: vi.fn(() => undefined),
    getScrollContainer: vi.fn(() => scrollContainer),
    onHoverArticle: vi.fn(),
    updateScrollCount: vi.fn(),
    itemHeight: 68,
    scrollPauseThreshold: 5,
    hasGeolocation: true,
    ...overrides,
  };
}

describe("renderer renderBrowsingList scrollMode switch", () => {
  it("tears down ArticleWindow and infinite scroll BEFORE rendering the viewport list when leaving infinite mode", () => {
    // The teardown ordering matters: a stale ArticleWindow leaking into the
    // viewport render would be a regression. Track call order and assert
    // resetArticleWindow + infiniteScroll.destroy precede browseMap.update
    // (which is called from inside renderViewportListDOM).
    const callOrder: string[] = [];
    const resetArticleWindow = vi.fn(() =>
      callOrder.push("resetArticleWindow"),
    );
    const infiniteScroll = stubInfiniteScroll({
      destroy: vi.fn(() => callOrder.push("infiniteScroll.destroy")),
    });
    const browseMap = stubBrowseMap({
      update: vi.fn(() => callOrder.push("browseMap.update")),
    });
    const deps = makeDeps({
      getState: vi.fn(() => tiledBrowsingState({}, { scrollMode: "viewport" })),
      resetArticleWindow,
      infiniteScroll,
      browseMap,
    });

    const renderer = createRenderer(deps);
    renderer.renderBrowsingList();

    expect(callOrder).toEqual([
      "resetArticleWindow",
      "infiniteScroll.destroy",
      "browseMap.update",
    ]);
  });

  it("does not call resetArticleWindow when scrollMode stays in infinite mode", () => {
    // The infinite-mode branch should NOT touch the ArticleWindow — the
    // lifecycle owns it and renders re-use the existing window.
    const resetArticleWindow = vi.fn();
    const deps = makeDeps({
      getState: vi.fn(() => tiledBrowsingState({}, { scrollMode: "infinite" })),
      resetArticleWindow,
    });

    const renderer = createRenderer(deps);
    renderer.renderBrowsingList();

    expect(resetArticleWindow).not.toHaveBeenCalled();
  });
});

describe("renderer renderInfiniteScrollDOM self-heal", () => {
  it("destroys an active infinite scroll whose container element has gone missing", () => {
    // The self-heal branch handles a corner case where infiniteScroll thinks
    // it's active but the .virtual-scroll-container has been removed from
    // the DOM (e.g. by a renderPhase teardown that didn't reset isActive).
    // The renderer destroys the stale lifecycle and re-inits it.
    let active = true;
    const destroy = vi.fn(() => {
      active = false;
    });
    const init = vi.fn();
    const infiniteScroll = stubInfiniteScroll({
      isActive: vi.fn(() => active),
      destroy,
      init,
    });
    // The app does NOT contain a .virtual-scroll-container — that's the
    // self-heal trigger.
    const deps = makeDeps({ infiniteScroll });
    expect(deps.app.querySelector(".virtual-scroll-container")).toBeNull();

    const renderer = createRenderer(deps);
    renderer.renderBrowsingList();

    // Self-heal calls destroy, which flips isActive to false, so the
    // renderer falls through to the !isActive branch and re-inits.
    expect(destroy).toHaveBeenCalled();
    expect(init).toHaveBeenCalled();
  });

  it("does not destroy the infinite scroll when the container element exists", () => {
    // Sanity: the self-heal branch only fires when the container is missing.
    // A normal active infinite scroll with its container intact must not
    // be torn down on every renderBrowsingList call.
    const destroy = vi.fn();
    const update = vi.fn();
    const infiniteScroll = stubInfiniteScroll({
      isActive: vi.fn(() => true),
      destroy,
      update,
    });
    const deps = makeDeps({ infiniteScroll });
    // Simulate the existing virtual scroll container in the DOM.
    const container = document.createElement("div");
    container.className = "virtual-scroll-container";
    deps.app.appendChild(container);

    const renderer = createRenderer(deps);
    renderer.renderBrowsingList();

    expect(destroy).not.toHaveBeenCalled();
  });
});

describe("renderer renderInfiniteScrollDOM totalCount", () => {
  it("uses totalKnown as the ceiling when the ArticleWindow has seen any tile", () => {
    // Once any tile has loaded, totalKnown reflects the real article count
    // across loaded tiles. infiniteScrollLimit must NOT inflate the list
    // past that real ceiling — otherwise the virtual list would extend
    // past the last real article.
    const aw = stubArticleWindow({
      loadedCount: vi.fn(() => 50),
      totalKnown: vi.fn(() => 150),
    });
    const init = vi.fn();
    const infiniteScroll = stubInfiniteScroll({
      isActive: vi.fn(() => false),
      init,
    });
    const deps = makeDeps({
      getState: vi.fn(() =>
        tiledBrowsingState(
          {},
          {
            articles: Array.from({ length: 5 }, (_, i) => ({
              ...article,
              title: `A${i}`,
            })),
            infiniteScrollLimit: 200,
          },
        ),
      ),
      getCurrentWindow: vi.fn(() => aw),
      infiniteScroll,
    });

    const renderer = createRenderer(deps);
    renderer.renderBrowsingList();

    expect(init).toHaveBeenCalledWith(150);
  });

  it("uses infiniteScrollLimit as optimistic headroom before the first tile loads", () => {
    // Before totalKnown is populated, the renderer inflates the list to
    // infiniteScrollLimit so the user never hits bottom during the
    // scroll-pause transition. See docs/infinite-scroll.md "Scroll Headroom".
    const aw = stubArticleWindow({
      loadedCount: vi.fn(() => 0),
      totalKnown: vi.fn(() => 0),
    });
    const init = vi.fn();
    const infiniteScroll = stubInfiniteScroll({
      isActive: vi.fn(() => false),
      init,
    });
    const deps = makeDeps({
      getState: vi.fn(() =>
        tiledBrowsingState(
          {},
          {
            articles: Array.from({ length: 12 }, (_, i) => ({
              ...article,
              title: `A${i}`,
            })),
            infiniteScrollLimit: 200,
          },
        ),
      ),
      getCurrentWindow: vi.fn(() => aw),
      infiniteScroll,
    });

    const renderer = createRenderer(deps);
    renderer.renderBrowsingList();

    expect(init).toHaveBeenCalledWith(200);
  });

  it("handles a null ArticleWindow by using the optimistic fallback", () => {
    // No ArticleWindow at all — the renderer must not crash on
    // aw.loadedCount() and must still produce a non-zero headroom count
    // driven by infiniteScrollLimit.
    const init = vi.fn();
    const infiniteScroll = stubInfiniteScroll({
      isActive: vi.fn(() => false),
      init,
    });
    const deps = makeDeps({
      getState: vi.fn(() =>
        tiledBrowsingState(
          {},
          {
            articles: [article, { ...article, title: "B" }],
            infiniteScrollLimit: 200,
          },
        ),
      ),
      getCurrentWindow: vi.fn(() => null),
      infiniteScroll,
    });

    const renderer = createRenderer(deps);
    renderer.renderBrowsingList();

    expect(init).toHaveBeenCalledWith(200);
  });
});

describe("renderer renderPhase teardown prefix", () => {
  it("runs all teardowns before switching to a non-browsing phase", () => {
    // When renderPhase is called for a phase like welcome, ALL pre-switch
    // teardowns must run: resetArticleWindow, infiniteScroll.destroy,
    // mapPicker.destroy, browseMap.destroy, drawerPanel.hidden=true,
    // drawer.close, drawerInitialized=false. Missing any leaks state into
    // the next phase.
    const resetArticleWindow = vi.fn();
    const infiniteScrollDestroy = vi.fn();
    const mapPickerDestroy = vi.fn();
    const browseMapDestroy = vi.fn();
    const drawerClose = vi.fn();
    const infiniteScroll = stubInfiniteScroll({
      destroy: infiniteScrollDestroy,
    });
    const mapPicker: MapPickerLifecycle = {
      show: vi.fn(),
      destroy: mapPickerDestroy,
    };
    const browseMap = stubBrowseMap({ destroy: browseMapDestroy });
    const drawer: MapDrawer = {
      ...stubDrawer(),
      close: drawerClose,
    };
    const drawerPanel = document.createElement("div");
    // Drawer panel starts visible to verify the hidden attribute is set.
    drawerPanel.removeAttribute("hidden");

    const deps = makeDeps({
      getState: vi.fn(() => ({
        ...tiledBrowsingState(),
        phase: { phase: "welcome" as const },
      })),
      resetArticleWindow,
      infiniteScroll,
      mapPicker,
      browseMap,
      drawer,
      drawerPanel,
    });

    const renderer = createRenderer(deps);
    renderer.renderPhase();

    expect(resetArticleWindow).toHaveBeenCalled();
    expect(infiniteScrollDestroy).toHaveBeenCalled();
    expect(mapPickerDestroy).toHaveBeenCalled();
    expect(browseMapDestroy).toHaveBeenCalled();
    expect(drawerClose).toHaveBeenCalled();
    expect(drawerPanel.hasAttribute("hidden")).toBe(true);
  });

  it("re-initializes the drawer on the next browsing render after a teardown", () => {
    // drawerInitialized is local state inside the renderer. After
    // renderPhase tears it down (drawerInitialized=false), the next
    // renderBrowsingList call must re-run the open/close branch (here
    // close, since desktopQuery.matches is false).
    //
    // renderBrowsingList only calls drawer.close() on the FIRST render after
    // drawerInitialized flips false — subsequent renders skip the branch.
    // renderPhase also calls drawer.close() unconditionally as part of its
    // teardown prefix; this test counts both call sites and asserts the
    // re-initialization branch fires exactly once per teardown cycle.
    const drawerClose = vi.fn();
    const drawer: MapDrawer = { ...stubDrawer(), close: drawerClose };
    const deps = makeDeps({
      drawer,
      desktopQuery: stubDesktopQuery(false),
    });

    const renderer = createRenderer(deps);
    // First render: drawerInitialized flips true, drawer.close fires once.
    renderer.renderBrowsingList();
    expect(drawerClose).toHaveBeenCalledTimes(1);

    // Second render: drawerInitialized still true, no extra close call.
    renderer.renderBrowsingList();
    expect(drawerClose).toHaveBeenCalledTimes(1);

    // renderPhase tears the drawer down — drawer.close() is part of the
    // unconditional teardown prefix, so this is call #2.
    deps.getState = vi.fn(() => ({
      ...tiledBrowsingState(),
      phase: { phase: "welcome" as const },
    }));
    renderer.renderPhase();
    expect(drawerClose).toHaveBeenCalledTimes(2);

    // Next browsing render: drawerInitialized has been reset, so the
    // re-init branch fires and drawer.close() runs again — call #3.
    deps.getState = vi.fn(() => tiledBrowsingState());
    renderer.renderBrowsingList();
    expect(drawerClose).toHaveBeenCalledTimes(3);
  });
});
