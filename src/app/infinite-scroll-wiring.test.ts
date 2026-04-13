// @vitest-environment jsdom
import { createInfiniteScrollWiring } from "./infinite-scroll-wiring";
import type { InfiniteScrollWiringDeps } from "./infinite-scroll-wiring";
import type {
  InfiniteScrollDeps,
  InfiniteScrollLifecycle,
} from "./infinite-scroll-lifecycle";
import type { AppState, Event, QueryState } from "./state-machine";
import type { ArticleWindow } from "./article-window";
import type { BrowseMapLifecycle } from "./browse-map-lifecycle";
import type { SummaryLoader } from "./summary-loader";
import type { NearbyArticle, UserPosition } from "./types";
import type { ArticleSummary } from "./wiki-api";
import type { VirtualList } from "./virtual-scroll";

// Mock createInfiniteScrollLifecycle so we can capture the deps (the closure
// callbacks under test) and invoke them directly. The wiring factory is all
// closure configuration — asserting on the captured deps is the cleanest way
// to test it without spinning up a full scroll lifecycle.
let capturedDeps: InfiniteScrollDeps | null = null;
let lifecycleStub: InfiniteScrollLifecycle;

vi.mock("./infinite-scroll-lifecycle", () => ({
  createInfiniteScrollLifecycle: (deps: InfiniteScrollDeps) => {
    capturedDeps = deps;
    return lifecycleStub;
  },
}));

const pos: UserPosition = { lat: 59.33, lon: 18.07 };
const stockholm: NearbyArticle = {
  title: "Stockholm",
  lat: 59.33,
  lon: 18.07,
  distanceM: 42,
};
const uppsala: NearbyArticle = {
  title: "Uppsala",
  lat: 59.86,
  lon: 17.64,
  distanceM: 6400,
};

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

function makeBrowsingState(overrides: Partial<AppState> = {}): AppState {
  return {
    phase: {
      phase: "browsing",
      articles: [stockholm, uppsala],
      nearbyCount: 15,
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
    ...overrides,
  };
}

function makeNonBrowsingState(): AppState {
  return {
    ...makeBrowsingState(),
    phase: { phase: "locating" },
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

function stubSummaryLoader(
  overrides: Partial<SummaryLoader> = {},
): SummaryLoader {
  return {
    load: vi.fn(),
    request: vi.fn(),
    get: vi.fn(() => undefined),
    cancel: vi.fn(),
    ...overrides,
  };
}

function stubVirtualList(range: { start: number; end: number }): VirtualList {
  return {
    update: vi.fn(),
    refresh: vi.fn(),
    visibleRange: () => ({ start: range.start, end: range.end }),
    totalCount: vi.fn(() => 0),
    isCompressed: vi.fn(() => false),
    destroy: vi.fn(),
  };
}

function stubLifecycle(
  overrides: Partial<InfiniteScrollLifecycle> = {},
): InfiniteScrollLifecycle {
  return {
    init: vi.fn(),
    update: vi.fn(),
    updateHeader: vi.fn(),
    destroy: vi.fn(),
    isActive: vi.fn(() => true),
    virtualList: vi.fn(() => null),
    scrollElement: vi.fn(() => null),
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<InfiniteScrollWiringDeps> = {},
): InfiniteScrollWiringDeps {
  const app = document.createElement("div");
  document.body.appendChild(app);
  const scrollContainer = document.createElement("div");
  document.body.appendChild(scrollContainer);
  return {
    getState: vi.fn(() => makeBrowsingState()),
    dispatch: vi.fn(),
    app,
    itemHeight: 68,
    browseMap: stubBrowseMap(),
    summaryLoader: stubSummaryLoader(),
    onHoverArticle: vi.fn(),
    getArticleByIndex: vi.fn(() => undefined),
    getScrollContainer: vi.fn(() => scrollContainer),
    getCurrentWindow: vi.fn(() => null),
    applyOptimisticCount: vi.fn(),
    ...overrides,
  };
}

describe("createInfiniteScrollWiring", () => {
  beforeEach(() => {
    capturedDeps = null;
    lifecycleStub = stubLifecycle();
  });

  afterEach(() => {
    document.body.textContent = "";
  });

  it("returns the lifecycle built by createInfiniteScrollLifecycle", () => {
    const deps = makeDeps();
    const lifecycle = createInfiniteScrollWiring(deps);
    expect(lifecycle).toBe(lifecycleStub);
    expect(capturedDeps).not.toBeNull();
  });

  it("passes the injected app container and item height to the lifecycle", () => {
    const deps = makeDeps();
    createInfiniteScrollWiring(deps);
    expect(capturedDeps!.container).toBe(deps.app);
    expect(capturedDeps!.itemHeight).toBe(68);
  });

  describe("getTitle", () => {
    it("returns the article title at the given index", () => {
      const deps = makeDeps({
        getArticleByIndex: vi.fn((i) => (i === 3 ? stockholm : undefined)),
      });
      createInfiniteScrollWiring(deps);
      expect(capturedDeps!.getTitle(3)).toBe("Stockholm");
    });

    it("returns null when the index has no article", () => {
      const deps = makeDeps({ getArticleByIndex: () => undefined });
      createInfiniteScrollWiring(deps);
      expect(capturedDeps!.getTitle(99)).toBeNull();
    });
  });

  describe("enrich", () => {
    it("delegates to summaryLoader.request with the current language", () => {
      const loader = stubSummaryLoader();
      const deps = makeDeps({
        summaryLoader: loader,
        getState: () => makeBrowsingState({ currentLang: "de" }),
      });
      createInfiniteScrollWiring(deps);

      capturedDeps!.enrich("Berlin");

      expect(loader.request).toHaveBeenCalledWith("Berlin", "de");
    });
  });

  describe("getVisibleArticles", () => {
    it("returns null outside browsing phase", () => {
      const deps = makeDeps({ getState: () => makeNonBrowsingState() });
      createInfiniteScrollWiring(deps);

      const result = capturedDeps!.getVisibleArticles({ start: 0, end: 10 });

      expect(result).toBeNull();
    });

    it("returns null when position is missing", () => {
      const deps = makeDeps({
        getState: () => makeBrowsingState({ position: null }),
      });
      createInfiniteScrollWiring(deps);

      const result = capturedDeps!.getVisibleArticles({ start: 0, end: 10 });

      expect(result).toBeNull();
    });

    it("returns the articles within the requested range during browsing", () => {
      const deps = makeDeps({
        getArticleByIndex: (i) => {
          if (i === 0) return stockholm;
          if (i === 1) return uppsala;
          return undefined;
        },
      });
      createInfiniteScrollWiring(deps);

      const result = capturedDeps!.getVisibleArticles({ start: 0, end: 3 });

      // Skips the undefined at index 2 rather than including holes.
      expect(result).toEqual([stockholm, uppsala]);
    });
  });

  describe("syncMapMarkers", () => {
    it("updates the browse map with the current position and articles", () => {
      const browseMap = stubBrowseMap();
      const deps = makeDeps({ browseMap });
      createInfiniteScrollWiring(deps);

      capturedDeps!.syncMapMarkers([stockholm, uppsala]);

      expect(browseMap.update).toHaveBeenCalledWith(pos, [stockholm, uppsala]);
    });

    it("is a no-op when no position is set", () => {
      const browseMap = stubBrowseMap();
      const deps = makeDeps({
        browseMap,
        getState: () => makeBrowsingState({ position: null }),
      });
      createInfiniteScrollWiring(deps);

      capturedDeps!.syncMapMarkers([stockholm]);

      expect(browseMap.update).not.toHaveBeenCalled();
    });
  });

  describe("renderItem", () => {
    it("returns null outside browsing phase", () => {
      const deps = makeDeps({ getState: () => makeNonBrowsingState() });
      createInfiniteScrollWiring(deps);

      const el = capturedDeps!.renderItem(0);

      expect(el).toBeNull();
    });

    it("returns null when the index has no article", () => {
      const deps = makeDeps({ getArticleByIndex: () => undefined });
      createInfiniteScrollWiring(deps);

      const el = capturedDeps!.renderItem(999);

      expect(el).toBeNull();
    });

    it("renders the article item with the article's title", () => {
      const deps = makeDeps({ getArticleByIndex: () => stockholm });
      createInfiniteScrollWiring(deps);

      const el = capturedDeps!.renderItem(0);

      expect(el).not.toBeNull();
      expect(el!.querySelector(".nearby-name")?.textContent).toBe("Stockholm");
    });

    it("applies cached enrichment when the summary loader has one", () => {
      const summary: ArticleSummary = {
        title: "Stockholm",
        description: "Capital of Sweden",
        thumbnailUrl: "https://example.com/s.jpg",
        thumbnailWidth: 320,
        thumbnailHeight: 240,
        pageUrl: "https://example.com/s",
        extract: "x",
      };
      const loader = stubSummaryLoader({
        get: vi.fn((title) => (title === "Stockholm" ? summary : undefined)),
      });
      const deps = makeDeps({
        getArticleByIndex: () => stockholm,
        summaryLoader: loader,
      });
      createInfiniteScrollWiring(deps);

      const el = capturedDeps!.renderItem(0);

      expect(el!.querySelector(".nearby-desc")?.textContent).toBe(
        "Capital of Sweden",
      );
    });

    it("does not apply enrichment when loader has no cached summary", () => {
      const deps = makeDeps({ getArticleByIndex: () => stockholm });
      createInfiniteScrollWiring(deps);

      const el = capturedDeps!.renderItem(0);

      // No enrichment means the description span is empty.
      expect(el!.querySelector(".nearby-desc")?.textContent).toBe("");
    });

    it("dispatches selectArticle with firstVisibleIndex derived from scrollTop", () => {
      const scrollContainer = document.createElement("div");
      document.body.appendChild(scrollContainer);
      Object.defineProperty(scrollContainer, "scrollTop", {
        value: 68 * 3,
        configurable: true,
      });
      const dispatch = vi.fn();
      const deps = makeDeps({
        dispatch,
        getArticleByIndex: () => stockholm,
        getScrollContainer: () => scrollContainer,
        itemHeight: 68,
      });
      createInfiniteScrollWiring(deps);

      const el = capturedDeps!.renderItem(0)!;
      el.dispatchEvent(new Event("click", { bubbles: true }));

      expect(dispatch).toHaveBeenCalledWith({
        type: "selectArticle",
        article: stockholm,
        firstVisibleIndex: 3,
      });
    });
  });

  describe("renderHeader", () => {
    it("returns a bare header placeholder outside browsing phase", () => {
      const deps = makeDeps({ getState: () => makeNonBrowsingState() });
      createInfiniteScrollWiring(deps);

      const header = capturedDeps!.renderHeader();

      expect(header.tagName).toBe("HEADER");
      expect(header.className).toBe("app-header");
      // Placeholder has no nearby header controls.
      expect(header.querySelector(".header-controls")).toBeNull();
    });

    it("derives articleCount from ArticleWindow.totalKnown() when available", () => {
      const aw = stubArticleWindow({ totalKnown: vi.fn(() => 42) });
      const deps = makeDeps({ getCurrentWindow: () => aw });
      createInfiniteScrollWiring(deps);

      const header = capturedDeps!.renderHeader();

      expect(header.textContent).toContain("42 attractions");
    });

    it("falls back to phase.articles.length when ArticleWindow is absent", () => {
      const deps = makeDeps({ getCurrentWindow: () => null });
      createInfiniteScrollWiring(deps);

      const header = capturedDeps!.renderHeader();

      // makeBrowsingState gives 2 articles.
      expect(header.textContent).toContain("2 attractions");
    });

    it("falls back to phase.articles.length when totalKnown is zero", () => {
      const aw = stubArticleWindow({ totalKnown: vi.fn(() => 0) });
      const deps = makeDeps({ getCurrentWindow: () => aw });
      createInfiniteScrollWiring(deps);

      const header = capturedDeps!.renderHeader();

      expect(header.textContent).toContain("2 attractions");
    });

    it("dispatches langChanged when the language selector fires onLangChange", () => {
      const dispatch = vi.fn();
      const deps = makeDeps({ dispatch });
      createInfiniteScrollWiring(deps);

      const header = capturedDeps!.renderHeader();
      // Click the German option in the real dropdown. The dropdown's listbox
      // click handler calls onLangChange, which the wiring forwards as a
      // langChanged dispatch.
      const option = header.querySelector<HTMLElement>(
        '.lang-listbox [data-lang="de"]',
      );
      expect(option).not.toBeNull();
      option!.click();

      expect(dispatch).toHaveBeenCalledWith({
        type: "langChanged",
        lang: "de",
      });
    });

    it("dispatches showAbout when the about button is clicked", () => {
      const dispatch = vi.fn();
      const deps = makeDeps({ dispatch });
      createInfiniteScrollWiring(deps);

      const header = capturedDeps!.renderHeader();
      const about = header.querySelector<HTMLButtonElement>(".about-btn");
      about?.click();

      expect(dispatch).toHaveBeenCalledWith({ type: "showAbout" });
    });
  });

  describe("initBrowseMap / destroyBrowseMap", () => {
    it("initBrowseMap updates the browse map with an empty article list", () => {
      const browseMap = stubBrowseMap();
      const deps = makeDeps({ browseMap });
      createInfiniteScrollWiring(deps);

      capturedDeps!.initBrowseMap();

      expect(browseMap.update).toHaveBeenCalledWith(pos, []);
    });

    it("initBrowseMap is a no-op when no position is set", () => {
      const browseMap = stubBrowseMap();
      const deps = makeDeps({
        browseMap,
        getState: () => makeBrowsingState({ position: null }),
      });
      createInfiniteScrollWiring(deps);

      capturedDeps!.initBrowseMap();

      expect(browseMap.update).not.toHaveBeenCalled();
    });

    it("destroyBrowseMap delegates to browseMap.destroy", () => {
      const browseMap = stubBrowseMap();
      const deps = makeDeps({ browseMap });
      createInfiniteScrollWiring(deps);

      capturedDeps!.destroyBrowseMap();

      expect(browseMap.destroy).toHaveBeenCalled();
    });
  });

  describe("onVisibleRangeChange", () => {
    it("calls ensureRange on the current ArticleWindow with the given range on first event", () => {
      const aw = stubArticleWindow();
      const deps = makeDeps({ getCurrentWindow: () => aw });
      createInfiniteScrollWiring(deps);

      capturedDeps!.onVisibleRangeChange!({ start: 10, end: 25 });

      // First event has no prior direction; no backward buffer applied.
      expect(aw.ensureRange).toHaveBeenCalledWith(10, 25);
    });

    it("does not pad on forward scrolls (onNearEnd owns forward prefetch)", () => {
      const aw = stubArticleWindow();
      const deps = makeDeps({ getCurrentWindow: () => aw });
      createInfiniteScrollWiring(deps);

      capturedDeps!.onVisibleRangeChange!({ start: 10, end: 25 });
      capturedDeps!.onVisibleRangeChange!({ start: 40, end: 55 });

      expect(aw.ensureRange).toHaveBeenLastCalledWith(40, 55);
    });

    it("prefetches below the visible range on backward scrolls", () => {
      const aw = stubArticleWindow();
      const deps = makeDeps({ getCurrentWindow: () => aw });
      createInfiniteScrollWiring(deps);

      // Forward to establish a baseline, then scroll backward.
      capturedDeps!.onVisibleRangeChange!({ start: 500, end: 515 });
      capturedDeps!.onVisibleRangeChange!({ start: 480, end: 495 });

      // 200-article backward prefetch buffer: fetch from 480 - 200 = 280.
      expect(aw.ensureRange).toHaveBeenLastCalledWith(280, 495);
    });

    it("clamps the backward prefetch start at zero", () => {
      const aw = stubArticleWindow();
      const deps = makeDeps({ getCurrentWindow: () => aw });
      createInfiniteScrollWiring(deps);

      capturedDeps!.onVisibleRangeChange!({ start: 100, end: 115 });
      capturedDeps!.onVisibleRangeChange!({ start: 50, end: 65 });

      expect(aw.ensureRange).toHaveBeenLastCalledWith(0, 65);
    });

    it("is a no-op when no ArticleWindow exists", () => {
      const deps = makeDeps({ getCurrentWindow: () => null });
      createInfiniteScrollWiring(deps);

      // Should not throw
      capturedDeps!.onVisibleRangeChange!({ start: 0, end: 10 });

      // Nothing to assert on — just verifying it doesn't blow up
      expect(deps.getCurrentWindow()).toBeNull();
    });

    it("resets direction tracking when a new ArticleWindow becomes active", () => {
      // The wiring outlives individual ArticleWindows: when the user's
      // position changes, a fresh window replaces the old one but the
      // wiring closure stays put. Without a reset, the previous window's
      // lastVisibleStart leaks into the new window's first range event
      // and gets misread as a backward scroll.
      const aw1 = stubArticleWindow();
      const aw2 = stubArticleWindow();
      let currentAw: ArticleWindow = aw1;
      const deps = makeDeps({ getCurrentWindow: () => currentAw });
      createInfiniteScrollWiring(deps);

      // Forward scroll on window 1 — remembers start=500 as lastVisibleStart.
      capturedDeps!.onVisibleRangeChange!({ start: 500, end: 515 });
      expect(aw1.ensureRange).toHaveBeenLastCalledWith(500, 515);

      // Position change: a fresh window replaces the old one.
      currentAw = aw2;

      // The new window's first range event is at start=100 (well below
      // the previous 500). Without a reset, this would be misread as a
      // backward scroll and fetch (max(0, 100-200), 115) = (0, 115). With
      // a reset, lastVisibleStart is null on this window, so no direction
      // is inferred and the fetch starts at 100 with no backward buffer.
      capturedDeps!.onVisibleRangeChange!({ start: 100, end: 115 });

      expect(aw2.ensureRange).toHaveBeenCalledWith(100, 115);
      expect(aw2.ensureRange).toHaveBeenCalledTimes(1);
    });
  });

  describe("onNearEnd", () => {
    it("dispatches expandInfiniteScroll when no ArticleWindow exists", () => {
      const dispatch = vi.fn();
      const deps = makeDeps({
        dispatch,
        getCurrentWindow: () => null,
      });
      createInfiniteScrollWiring(deps);

      capturedDeps!.onNearEnd!();

      expect(dispatch).toHaveBeenCalledWith({ type: "expandInfiniteScroll" });
    });

    it("applies optimistic count and grows the window when ArticleWindow exists", () => {
      const aw = stubArticleWindow({
        totalKnown: vi.fn(() => 300),
        loadedCount: vi.fn(() => 120),
        ensureRange: vi.fn(async () => {}),
      });
      const applyOptimisticCount = vi.fn();
      const dispatch = vi.fn();
      // Install a virtualList stub on the lifecycle stub before the wiring
      // captures onNearEnd.
      lifecycleStub = stubLifecycle({
        virtualList: () => stubVirtualList({ start: 50, end: 100 }),
      });
      const deps = makeDeps({
        dispatch,
        getCurrentWindow: () => aw,
        applyOptimisticCount,
      });
      createInfiniteScrollWiring(deps);

      capturedDeps!.onNearEnd!();

      // optimistic = loaded = 120 (uses loadedCount, not totalKnown)
      expect(applyOptimisticCount).toHaveBeenCalledWith(120);
      // Regression pin: applyOptimisticCount must NOT be called with
      // totalKnown (300). Removing computeOptimisticCount made this the
      // only source of truth, and a future refactor back to totalKnown
      // would silently regress the "list never extends past last real
      // article" guarantee. toHaveBeenCalledWith(120) would still catch
      // it today, but this assertion pins intent against numeric drift.
      expect(applyOptimisticCount).not.toHaveBeenCalledWith(300);
      expect(aw.ensureRange).toHaveBeenCalledWith(50, 100 + 200);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("bails out when virtualList is not yet available", () => {
      const aw = stubArticleWindow({
        totalKnown: vi.fn(() => 300),
        loadedCount: vi.fn(() => 120),
      });
      const applyOptimisticCount = vi.fn();
      lifecycleStub = stubLifecycle({ virtualList: () => null });
      const deps = makeDeps({
        getCurrentWindow: () => aw,
        applyOptimisticCount,
      });
      createInfiniteScrollWiring(deps);

      capturedDeps!.onNearEnd!();

      expect(applyOptimisticCount).not.toHaveBeenCalled();
      expect(aw.ensureRange).not.toHaveBeenCalled();
    });
  });
});
