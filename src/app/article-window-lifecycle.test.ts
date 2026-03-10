import type { ArticleWindow } from "./article-window";
import type { NearbyArticle, UserPosition } from "./types";
import type { AppState, QueryState } from "./state-machine";
import {
  createArticleWindowLifecycle,
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
