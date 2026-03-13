import type { ArticleWindow } from "./article-window";
import type { NearbyArticle, UserPosition } from "./types";
import type { AppState, QueryState } from "./state-machine";
import {
  createArticleWindowLifecycle,
  computeOptimisticCount,
  type ArticleWindowLifecycleDeps,
} from "./article-window-lifecycle";

const pos: UserPosition = { lat: 59.33, lon: 18.07 };
const article: NearbyArticle = {
  title: "Stockholm",
  lat: 59.33,
  lon: 18.07,
  distanceM: 42,
};

function stubArticleWindow(
  overrides: Partial<ArticleWindow> = {},
): ArticleWindow {
  return {
    getArticle: vi.fn(),
    ensureRange: vi.fn(async () => {}),
    totalKnown: vi.fn(() => 0),
    loadedCount: vi.fn(() => 0),
    reset: vi.fn(),
    ...overrides,
  };
}

function tiledAppState(): AppState {
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
  };
}

function makeDeps(
  overrides: Partial<ArticleWindowLifecycleDeps> = {},
): ArticleWindowLifecycleDeps {
  return {
    getState: vi.fn(() => tiledAppState()),
    createArticleWindow: vi.fn(() => stubArticleWindow()),
    renderBrowsingList: vi.fn(),
    infiniteScroll: {
      isActive: vi.fn(() => true),
      update: vi.fn(),
    },
    ...overrides,
  };
}

describe("createArticleWindowLifecycle", () => {
  it("ensureArticleRange follows reset→create→ensureRange→render sequence", () => {
    const callOrder: string[] = [];
    const aw = stubArticleWindow({
      reset: vi.fn(() => callOrder.push("reset")),
      ensureRange: vi.fn(async () => {
        callOrder.push("ensureRange");
      }),
    });
    const deps = makeDeps({
      createArticleWindow: vi.fn(() => {
        callOrder.push("create");
        return aw;
      }),
      renderBrowsingList: vi.fn(() => callOrder.push("render")),
    });

    const lifecycle = createArticleWindowLifecycle(deps);

    // First call: no existing window, so no reset step
    lifecycle.ensureArticleRange(pos, 200);
    expect(callOrder).toEqual(["create", "ensureRange", "render"]);

    // Second call: existing window is reset first
    callOrder.length = 0;
    lifecycle.ensureArticleRange(pos, 200);
    expect(callOrder[0]).toBe("reset");
  });

  it("getOrCreateArticleWindow reuses existing window on second call", () => {
    const aw = stubArticleWindow();
    const deps = makeDeps({
      createArticleWindow: vi.fn(() => aw),
    });

    const lifecycle = createArticleWindowLifecycle(deps);
    const first = lifecycle.getOrCreateArticleWindow();
    const second = lifecycle.getOrCreateArticleWindow();

    expect(first).toBe(second);
    expect(deps.createArticleWindow).toHaveBeenCalledTimes(1);
  });

  it("getOrCreateArticleWindow throws when state lacks tiled query", () => {
    const deps = makeDeps({
      getState: vi.fn(() => ({
        ...tiledAppState(),
        query: { mode: "none" as const },
      })),
    });

    const lifecycle = createArticleWindowLifecycle(deps);
    expect(() => lifecycle.getOrCreateArticleWindow()).toThrow(
      /Cannot create ArticleWindow/,
    );
  });

  it("getArticleByIndex returns undefined for out-of-bounds index", () => {
    const aw = stubArticleWindow({
      getArticle: vi.fn(() => undefined),
    });
    const state = tiledAppState();
    if (state.phase.phase === "browsing") {
      // Only one article in viewport list (index 0)
      state.phase.articles = [article];
    }
    const deps = makeDeps({
      getState: vi.fn(() => state),
      createArticleWindow: vi.fn(() => aw),
    });

    const lifecycle = createArticleWindowLifecycle(deps);

    // Before ArticleWindow is created, falls back to viewport articles
    expect(lifecycle.getArticleByIndex(0)?.title).toBe("Stockholm");
    expect(lifecycle.getArticleByIndex(999)).toBeUndefined();

    // After creating ArticleWindow, delegates to it
    lifecycle.getOrCreateArticleWindow();
    expect(lifecycle.getArticleByIndex(999)).toBeUndefined();
  });

  it("resetArticleWindow aborts the controller", () => {
    let capturedSignal: AbortSignal | undefined;
    const aw = stubArticleWindow();
    const deps = makeDeps({
      createArticleWindow: vi.fn((opts) => {
        capturedSignal = opts.signal;
        return aw;
      }),
    });

    const lifecycle = createArticleWindowLifecycle(deps);
    lifecycle.getOrCreateArticleWindow();

    expect(capturedSignal!.aborted).toBe(false);
    lifecycle.resetArticleWindow();
    expect(capturedSignal!.aborted).toBe(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(aw.reset).toHaveBeenCalled();
  });
});

describe("computeOptimisticCount", () => {
  const BUFFER = 200;
  const MAX = 5000;

  it("caps at known when known > loaded", () => {
    expect(computeOptimisticCount(500, 100, BUFFER, MAX)).toBe(500);
  });

  it("uses loaded + buffer (capped) when known <= loaded", () => {
    expect(computeOptimisticCount(100, 100, BUFFER, MAX)).toBe(300);
    expect(computeOptimisticCount(50, 200, BUFFER, MAX)).toBe(400);
  });

  it("respects maxLimit when known <= loaded", () => {
    expect(computeOptimisticCount(100, 4900, BUFFER, MAX)).toBe(MAX);
  });

  it("returns 0 when both known and loaded are 0", () => {
    expect(computeOptimisticCount(0, 0, BUFFER, MAX)).toBe(0);
  });

  it("caps at maxLimit when known is 0 but loaded > 0", () => {
    expect(computeOptimisticCount(0, 100, BUFFER, MAX)).toBe(300);
    expect(computeOptimisticCount(0, 4900, BUFFER, MAX)).toBe(MAX);
  });
});
