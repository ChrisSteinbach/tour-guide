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

  it("preserves browseMap and drawer state when transitioning to detail", () => {
    // browsing → detail must not tear down the drawer — on desktop the
    // map stays visible alongside the article, and on mobile the drawer
    // must remain constructed so the gesture can reopen it.
    const browseMapDestroy = vi.fn();
    const drawerClose = vi.fn();
    const browseMap = stubBrowseMap({ destroy: browseMapDestroy });
    const drawer: MapDrawer = { ...stubDrawer(), close: drawerClose };
    const drawerPanel = document.createElement("div");
    drawerPanel.removeAttribute("hidden");
    const deps = makeDeps({
      getState: vi.fn(() => ({
        ...tiledBrowsingState(),
        phase: {
          phase: "detail" as const,
          article,
          savedFirstVisibleIndex: 0,
          articles: [article],
          nearbyCount: 15,
          paused: false,
          pauseReason: null,
          lastQueryPos: pos,
          scrollMode: "infinite" as const,
          infiniteScrollLimit: 200,
        },
      })),
      browseMap,
      drawer,
      drawerPanel,
    });

    const renderer = createRenderer(deps);
    renderer.renderPhase();

    expect(browseMapDestroy).not.toHaveBeenCalled();
    expect(drawerClose).not.toHaveBeenCalled();
    expect(drawerPanel.hasAttribute("hidden")).toBe(false);
  });

  it("preserves drawer state across a detail → browsing transition", () => {
    // After entering detail (drawer preserved), pressing back must not
    // re-tear down the drawer on the way back to browsing.
    const drawerClose = vi.fn();
    const drawer: MapDrawer = { ...stubDrawer(), close: drawerClose };
    const browseMapDestroy = vi.fn();
    const browseMap = stubBrowseMap({ destroy: browseMapDestroy });
    const deps = makeDeps({
      getState: vi.fn(() => tiledBrowsingState()),
      drawer,
      browseMap,
      desktopQuery: stubDesktopQuery(true),
    });

    const renderer = createRenderer(deps);
    renderer.renderBrowsingList();
    const initialDrawerCloses = drawerClose.mock.calls.length;

    renderer.renderPhase();

    // renderPhase in the browse pair does not add a drawer.close call.
    expect(drawerClose).toHaveBeenCalledTimes(initialDrawerCloses);
    expect(browseMapDestroy).not.toHaveBeenCalled();
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

// ── Viewport-list dispatch wiring ───────────────────────────

describe("renderer renderBrowsingList viewport mode dispatch", () => {
  it("dispatches selectArticle with firstVisibleIndex derived from scrollTop", () => {
    // Clicking the article must hand the state machine the user's current
    // scroll position so that, on back, the list scrolls back to where
    // they were. The renderer computes firstVisibleIndex by dividing
    // scrollTop by itemHeight — e.g., scrollTop=204 / itemHeight=68 → 3.
    const dispatch = vi.fn();
    const scrollContainer = document.createElement("div");
    Object.defineProperty(scrollContainer, "scrollTop", {
      value: 204,
      configurable: true,
    });
    const deps = makeDeps({
      dispatch,
      getState: vi.fn(() => tiledBrowsingState({}, { scrollMode: "viewport" })),
      getScrollContainer: vi.fn(() => scrollContainer),
      itemHeight: 68,
    });

    const renderer = createRenderer(deps);
    renderer.renderBrowsingList();

    const item = deps.app.querySelector<HTMLElement>(".nearby-item");
    expect(item).not.toBeNull();
    item!.click();

    expect(dispatch).toHaveBeenCalledWith({
      type: "selectArticle",
      article,
      firstVisibleIndex: 3,
    });
  });
});

// ── Scroll-pause setup ──────────────────────────────────────

describe("renderer scroll-pause detector setup", () => {
  /** A scrollable container: scrollHeight > clientHeight is required so the
   *  scroll-pause detector attaches its container listener (see
   *  scroll-pause-detector.ts). scrollTop starts at 0 and is writable. */
  function makeScrollContainer(): HTMLDivElement {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollTop", {
      value: 0,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(el, "scrollHeight", {
      value: 1000,
      configurable: true,
    });
    Object.defineProperty(el, "clientHeight", {
      value: 200,
      configurable: true,
    });
    return el;
  }

  function viewportGpsState() {
    return tiledBrowsingState(
      { positionSource: null },
      { scrollMode: "viewport", paused: false },
    );
  }

  it("dispatches scrollPause when the user scrolls past the threshold (GPS, unpaused)", () => {
    // The detector listens on the scroll container and fires once scrollTop
    // exceeds scrollPauseThreshold. Renderer must wire it up only when
    // positionSource is GPS (positionSource !== "picked") and the browse
    // phase is not paused.
    const dispatch = vi.fn();
    const scrollContainer = makeScrollContainer();
    const deps = makeDeps({
      dispatch,
      getState: vi.fn(() => viewportGpsState()),
      getScrollContainer: vi.fn(() => scrollContainer),
      scrollPauseThreshold: 50,
    });

    const renderer = createRenderer(deps);
    renderer.renderBrowsingList();

    (scrollContainer as unknown as { scrollTop: number }).scrollTop = 100;
    scrollContainer.dispatchEvent(new Event("scroll"));

    expect(dispatch).toHaveBeenCalledWith({ type: "scrollPause" });
  });

  it("does not arm the detector when position source is picked", () => {
    // Picked locations are static — no GPS drift, no scroll-pause needed.
    const dispatch = vi.fn();
    const scrollContainer = makeScrollContainer();
    const deps = makeDeps({
      dispatch,
      getState: vi.fn(() =>
        tiledBrowsingState(
          { positionSource: "picked" },
          { scrollMode: "viewport", paused: false },
        ),
      ),
      getScrollContainer: vi.fn(() => scrollContainer),
      scrollPauseThreshold: 50,
    });

    const renderer = createRenderer(deps);
    renderer.renderBrowsingList();

    (scrollContainer as unknown as { scrollTop: number }).scrollTop = 100;
    scrollContainer.dispatchEvent(new Event("scroll"));

    expect(dispatch).not.toHaveBeenCalledWith({ type: "scrollPause" });
  });

  it("does not arm the detector when the browse phase is already paused", () => {
    const dispatch = vi.fn();
    const scrollContainer = makeScrollContainer();
    const deps = makeDeps({
      dispatch,
      getState: vi.fn(() =>
        tiledBrowsingState(
          { positionSource: null },
          { scrollMode: "viewport", paused: true, pauseReason: "manual" },
        ),
      ),
      getScrollContainer: vi.fn(() => scrollContainer),
      scrollPauseThreshold: 50,
    });

    const renderer = createRenderer(deps);
    renderer.renderBrowsingList();

    (scrollContainer as unknown as { scrollTop: number }).scrollTop = 100;
    scrollContainer.dispatchEvent(new Event("scroll"));

    expect(dispatch).not.toHaveBeenCalledWith({ type: "scrollPause" });
  });
});

// ── Infinite-scroll active branch ───────────────────────────

describe("renderer renderInfiniteScrollDOM active branch", () => {
  it("updates browseMap with the articles in the virtual list's visible range", () => {
    // When an active infinite scroll re-renders, the renderer feeds
    // browseMap only the *visible* slice (range.start..range.end) so
    // map markers track what the user can see, not the whole loaded set.
    const a0 = { ...article, title: "A0" };
    const a1 = { ...article, title: "A1" };
    const a2 = { ...article, title: "A2" };
    const articles = [a0, a1, a2];

    const update = vi.fn();
    const browseMap = stubBrowseMap({ update });
    const container = document.createElement("div");
    container.className = "virtual-scroll-container";

    const infiniteScroll = stubInfiniteScroll({
      isActive: vi.fn(() => true),
      virtualList: vi.fn(() => ({
        update: vi.fn(),
        refresh: vi.fn(),
        visibleRange: () => ({ start: 1, end: 3, overscan: 0 }),
        totalCount: () => 3,
        destroy: vi.fn(),
      })),
    });

    const deps = makeDeps({
      getState: vi.fn(() => tiledBrowsingState({}, { articles })),
      browseMap,
      infiniteScroll,
      getArticleByIndex: vi.fn((i: number) => articles[i]),
    });
    deps.app.appendChild(container);

    const renderer = createRenderer(deps);
    renderer.renderBrowsingList();

    expect(update).toHaveBeenCalledWith(pos, [a1, a2]);
  });
});

// ── App-update banner ───────────────────────────────────────

describe("renderer renderAppUpdateBanner", () => {
  afterEach(() => {
    document.body
      .querySelectorAll("#app-update-banner")
      .forEach((el) => el.remove());
  });

  it("appends a single banner with a Reload button", () => {
    const renderer = createRenderer(makeDeps());

    renderer.renderAppUpdateBanner();

    const banners = document.querySelectorAll("#app-update-banner");
    expect(banners).toHaveLength(1);
    expect(banners[0].querySelector(".update-banner-accept")?.textContent).toBe(
      "Reload",
    );
  });

  it("is idempotent — calling twice still leaves a single banner", () => {
    const renderer = createRenderer(makeDeps());

    renderer.renderAppUpdateBanner();
    renderer.renderAppUpdateBanner();

    expect(document.querySelectorAll("#app-update-banner")).toHaveLength(1);
  });
});

// ── resetDrawerForMapPicker ─────────────────────────────────

describe("renderer resetDrawerForMapPicker", () => {
  it("destroys map picker, browse map, hides the drawer panel, and closes the drawer", () => {
    const mapPickerDestroy = vi.fn();
    const browseMapDestroy = vi.fn();
    const drawerClose = vi.fn();
    const drawerPanel = document.createElement("div");
    drawerPanel.removeAttribute("hidden");
    const deps = makeDeps({
      mapPicker: { show: vi.fn(), destroy: mapPickerDestroy },
      browseMap: stubBrowseMap({ destroy: browseMapDestroy }),
      drawer: { ...stubDrawer(), close: drawerClose },
      drawerPanel,
    });

    const renderer = createRenderer(deps);
    renderer.resetDrawerForMapPicker();

    expect(mapPickerDestroy).toHaveBeenCalled();
    expect(browseMapDestroy).toHaveBeenCalled();
    expect(drawerPanel.hasAttribute("hidden")).toBe(true);
    expect(drawerClose).toHaveBeenCalled();
  });

  it("forces drawerInitialized=false so the next browsing render re-runs the open/close branch", () => {
    // After resetDrawerForMapPicker, returning to browsing must re-execute
    // the desktop-vs-mobile drawer choice. We assert that by counting the
    // number of times drawer.open/close fires across the cycle.
    const drawerClose = vi.fn();
    const drawer: MapDrawer = { ...stubDrawer(), close: drawerClose };
    const deps = makeDeps({
      drawer,
      desktopQuery: stubDesktopQuery(false),
    });

    const renderer = createRenderer(deps);
    renderer.renderBrowsingList(); // drawer.close called once
    expect(drawerClose).toHaveBeenCalledTimes(1);

    renderer.resetDrawerForMapPicker(); // unconditional close — call 2
    expect(drawerClose).toHaveBeenCalledTimes(2);

    renderer.renderBrowsingList(); // re-init branch fires close — call 3
    expect(drawerClose).toHaveBeenCalledTimes(3);
  });
});

// ── renderPhase: per-phase delegation ───────────────────────

describe("renderer renderPhase delegates to status renderers", () => {
  it("renders the welcome screen for the welcome phase", () => {
    const deps = makeDeps({
      getState: vi.fn(() => ({
        ...tiledBrowsingState(),
        phase: { phase: "welcome" as const },
      })),
    });
    const renderer = createRenderer(deps);
    renderer.renderPhase();

    // renderWelcome appends a "Use my location" button.
    const startBtn = Array.from(
      deps.app.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => /use my location/i.test(b.textContent ?? ""));
    expect(startBtn).toBeDefined();
  });

  it("renders an error message for the error phase", () => {
    const deps = makeDeps({
      getState: vi.fn(() => ({
        ...tiledBrowsingState(),
        phase: {
          phase: "error" as const,
          error: {
            code: "PERMISSION_DENIED",
            message: "Permission denied",
          } as const,
        },
      })),
    });
    const renderer = createRenderer(deps);
    renderer.renderPhase();

    expect(deps.app.querySelector(".status-screen")).not.toBeNull();
  });

  it("renders the loading-progress screen for the downloading phase", () => {
    const deps = makeDeps({
      getState: vi.fn(() => ({
        ...tiledBrowsingState(),
        phase: { phase: "downloading" as const, progress: 0.5 },
      })),
    });
    const renderer = createRenderer(deps);
    renderer.renderPhase();

    const fill = deps.app.querySelector<HTMLElement>(".progress-fill");
    expect(fill?.style.width).toBe("50%");
  });
});

// ── Desktop drawer initialization ───────────────────────────

describe("renderer renderBrowsingList desktop-first render", () => {
  it("opens the drawer and schedules a browseMap.resize on desktop", async () => {
    // On desktop (matches=true) the drawer is open by default. The drawer
    // panel was hidden, so no CSS transitionend fires to trigger resize —
    // the renderer must schedule resize via rAF instead.
    const open = vi.fn();
    const drawer: MapDrawer = { ...stubDrawer(), open };
    const resize = vi.fn();
    const browseMap = stubBrowseMap({ resize });
    const deps = makeDeps({
      drawer,
      browseMap,
      desktopQuery: stubDesktopQuery(true),
    });

    const renderer = createRenderer(deps);
    renderer.renderBrowsingList();

    expect(open).toHaveBeenCalled();

    // Wait for the rAF to flush.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    expect(resize).toHaveBeenCalled();
  });
});
