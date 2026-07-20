// @vitest-environment jsdom
import { createInfiniteScrollWiring } from "./infinite-scroll-wiring";
import type { InfiniteScrollWiringDeps } from "./infinite-scroll-wiring";
import type {
  InfiniteScrollDeps,
  InfiniteScrollLifecycle,
} from "./infinite-scroll-lifecycle";
import type { AppState, Event, QueryState } from "./state-machine";
import type { SpatialPanelLifecycle } from "./spatial-panel-lifecycle";
import type { SummaryLoader } from "./summary-loader";
import type { NearbyArticle, UserPosition } from "./types";
import type { ArticleSummary } from "./wiki-api";
import type { GroupView } from "./grouped-articles";

function stubGroupView(
  byIndex: (i: number) => NearbyArticle | undefined,
): GroupView {
  const groupAt = (i: number) => {
    const a = byIndex(i);
    return a
      ? {
          representative: a,
          members: [a],
          lat: a.lat,
          lon: a.lon,
          distanceM: a.distanceM,
        }
      : undefined;
  };
  return {
    getGroup: groupAt,
    loadedGroupCount: () => 0,
    titleAt: (i) => byIndex(i)?.title ?? null,
    membersInRange: (s, e) => {
      const out: NearbyArticle[] = [];
      for (let i = s; i < e; i++) {
        const a = byIndex(i);
        if (a) out.push(a);
      }
      return out;
    },
    articleBoundsForGroupRange: (s, e) => ({ start: s, end: e }),
    groupCountForArticleCount: (n) => n,
  };
}

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
    },
    query: makeQueryState(),
    position: pos,
    positionSource: "gps",
    currentLang: "en",
    filter: "highlights",
    loadGeneration: 1,
    loadingTiles: new Set(),
    downloadProgress: -1,
    pendingReload: false,
    hasGeolocation: true,
    gpsSignalLost: false,
    primaryTileFailed: false,
    tileFailureDismissed: false,
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

function stubSpatialPanel(
  overrides: Partial<SpatialPanelLifecycle> = {},
): SpatialPanelLifecycle {
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
    spatialPanel: stubSpatialPanel(),
    summaryLoader: stubSummaryLoader(),
    onHoverArticle: vi.fn(),
    groupView: stubGroupView(() => undefined),
    getScrollContainer: vi.fn(() => scrollContainer),
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
        groupView: stubGroupView((i) => (i === 3 ? stockholm : undefined)),
      });
      createInfiniteScrollWiring(deps);
      expect(capturedDeps!.getTitle(3)).toBe("Stockholm");
    });

    it("returns null when the index has no article", () => {
      const deps = makeDeps({ groupView: stubGroupView(() => undefined) });
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
        groupView: stubGroupView((i) => {
          if (i === 0) return stockholm;
          if (i === 1) return uppsala;
          return undefined;
        }),
      });
      createInfiniteScrollWiring(deps);

      const result = capturedDeps!.getVisibleArticles({ start: 0, end: 3 });

      // Skips the undefined at index 2 rather than including holes.
      expect(result).toEqual([stockholm, uppsala]);
    });
  });

  describe("syncMapMarkers", () => {
    it("updates the browse map with the current position and articles", () => {
      const spatialPanel = stubSpatialPanel();
      const deps = makeDeps({ spatialPanel });
      createInfiniteScrollWiring(deps);

      capturedDeps!.syncMapMarkers([stockholm, uppsala]);

      expect(spatialPanel.update).toHaveBeenCalledWith(
        pos,
        [stockholm, uppsala],
        "gps",
        false,
      );
    });

    it("is a no-op when no position is set", () => {
      const spatialPanel = stubSpatialPanel();
      const deps = makeDeps({
        spatialPanel,
        getState: () => makeBrowsingState({ position: null }),
      });
      createInfiniteScrollWiring(deps);

      capturedDeps!.syncMapMarkers([stockholm]);

      expect(spatialPanel.update).not.toHaveBeenCalled();
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
      const deps = makeDeps({ groupView: stubGroupView(() => undefined) });
      createInfiniteScrollWiring(deps);

      const el = capturedDeps!.renderItem(999);

      expect(el).toBeNull();
    });

    it("renders the article item with the article's title", () => {
      const deps = makeDeps({ groupView: stubGroupView(() => stockholm) });
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
        groupView: stubGroupView(() => stockholm),
        summaryLoader: loader,
      });
      createInfiniteScrollWiring(deps);

      const el = capturedDeps!.renderItem(0);

      expect(el!.querySelector(".nearby-desc")?.textContent).toBe(
        "Capital of Sweden",
      );
    });

    it("does not apply enrichment when loader has no cached summary", () => {
      const deps = makeDeps({ groupView: stubGroupView(() => stockholm) });
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
        groupView: stubGroupView(() => stockholm),
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

  describe("renderItem coincident cluster", () => {
    const rep: NearbyArticle = {
      title: "Court Building",
      lat: 1,
      lon: 1,
      distanceM: 50,
      weight: 9,
    };
    const memberA: NearbyArticle = {
      title: "Court A",
      lat: 1,
      lon: 1,
      distanceM: 50,
      weight: 2,
    };
    const memberB: NearbyArticle = {
      title: "Court B",
      lat: 1,
      lon: 1,
      distanceM: 50,
      weight: 1,
    };
    const clusterGroup = {
      representative: rep,
      members: [rep, memberA, memberB],
      lat: 1,
      lon: 1,
      distanceM: 50,
    };

    // A GroupView with one three-member cluster at group index 0.
    function clusterGroupView(): GroupView {
      return {
        getGroup: (i) => (i === 0 ? clusterGroup : undefined),
        loadedGroupCount: () => 1,
        titleAt: (i) => (i === 0 ? rep.title : null),
        membersInRange: (s, e) =>
          s <= 0 && e > 0 ? [rep, memberA, memberB] : [],
        articleBoundsForGroupRange: (s, e) => ({ start: s, end: e }),
        groupCountForArticleCount: (n) => n,
      };
    }

    // Close any popover a test left open before body is cleared.
    afterEach(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    it("renders the representative row with a +N chip for the other members", () => {
      const deps = makeDeps({ groupView: clusterGroupView() });
      createInfiniteScrollWiring(deps);

      const el = capturedDeps!.renderItem(0)!;

      expect(el.querySelector(".nearby-name")?.textContent).toBe(
        "Court Building",
      );
      expect(el.classList.contains("has-cluster")).toBe(true);
      // The chip counts the OTHER members (members − representative).
      expect(el.querySelector(".nearby-cluster-more")?.textContent).toBe("+2");
    });

    it("opens a popover listing the other co-located members when the chip is clicked", () => {
      const deps = makeDeps({ groupView: clusterGroupView() });
      createInfiniteScrollWiring(deps);
      const el = capturedDeps!.renderItem(0)!;
      document.body.appendChild(el);

      el.querySelector<HTMLButtonElement>(".nearby-cluster-more")!.click();

      const rows = document.querySelectorAll(
        ".cluster-popover .cluster-member-row",
      );
      expect(Array.from(rows).map((r) => r.textContent)).toEqual([
        "Court A",
        "Court B",
      ]);
    });

    it("dispatches selectArticle for a member chosen from the popover", () => {
      const dispatch = vi.fn();
      const deps = makeDeps({ dispatch, groupView: clusterGroupView() });
      createInfiniteScrollWiring(deps);
      const el = capturedDeps!.renderItem(0)!;
      document.body.appendChild(el);
      el.querySelector<HTMLButtonElement>(".nearby-cluster-more")!.click();

      document
        .querySelectorAll<HTMLButtonElement>(
          ".cluster-popover .cluster-member-row",
        )[0]
        .click();

      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "selectArticle", article: memberA }),
      );
    });

    it("does not add a cluster chip to a lone article", () => {
      const deps = makeDeps({ groupView: stubGroupView(() => stockholm) });
      createInfiniteScrollWiring(deps);

      const el = capturedDeps!.renderItem(0)!;

      expect(el.classList.contains("has-cluster")).toBe(false);
      expect(el.querySelector(".nearby-cluster-more")).toBeNull();
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

  describe("initSpatialView / destroySpatialView", () => {
    it("initSpatialView updates the browse map with an empty article list", () => {
      const spatialPanel = stubSpatialPanel();
      const deps = makeDeps({ spatialPanel });
      createInfiniteScrollWiring(deps);

      capturedDeps!.initSpatialView();

      expect(spatialPanel.update).toHaveBeenCalledWith(pos, [], "gps", false);
    });

    it("initSpatialView is a no-op when no position is set", () => {
      const spatialPanel = stubSpatialPanel();
      const deps = makeDeps({
        spatialPanel,
        getState: () => makeBrowsingState({ position: null }),
      });
      createInfiniteScrollWiring(deps);

      capturedDeps!.initSpatialView();

      expect(spatialPanel.update).not.toHaveBeenCalled();
    });

    it("destroySpatialView delegates to spatialPanel.destroy", () => {
      const spatialPanel = stubSpatialPanel();
      const deps = makeDeps({ spatialPanel });
      createInfiniteScrollWiring(deps);

      capturedDeps!.destroySpatialView();

      expect(spatialPanel.destroy).toHaveBeenCalled();
    });
  });
});
