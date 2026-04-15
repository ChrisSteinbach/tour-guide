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
    getLoadedArticles: vi.fn(() => []),
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
    aboutOpen: false,
  };
}

function makeDeps(
  overrides: Partial<ArticleWindowLifecycleDeps> = {},
): ArticleWindowLifecycleDeps {
  return {
    getState: vi.fn(() => tiledAppState()),
    createArticleWindow: vi.fn(() => stubArticleWindow()),
    renderBrowsingList: vi.fn(),
    ...overrides,
  };
}

describe("createArticleWindowLifecycle", () => {
  it("ensureArticleRange on first invocation creates a window, fetches the range, renders, and does not reset", () => {
    const aw = stubArticleWindow();
    const deps = makeDeps({
      createArticleWindow: vi.fn(() => aw),
    });

    const lifecycle = createArticleWindowLifecycle(deps);

    lifecycle.ensureArticleRange(pos, 200);

    expect(deps.createArticleWindow).toHaveBeenCalledTimes(1);
    expect(aw.ensureRange).toHaveBeenCalledWith(0, 200);
    expect(deps.renderBrowsingList).toHaveBeenCalled();
    expect(aw.reset).not.toHaveBeenCalled();
  });

  it("ensureArticleRange resets the existing window when called again with a different position", () => {
    const aw = stubArticleWindow();
    const deps = makeDeps({
      createArticleWindow: vi.fn(() => aw),
    });

    const lifecycle = createArticleWindowLifecycle(deps);

    // Prime the lifecycle so an existing window exists
    lifecycle.ensureArticleRange(pos, 200);
    expect(aw.reset).not.toHaveBeenCalled();

    lifecycle.ensureArticleRange({ lat: 60.0, lon: 19.0 }, 200);

    expect(aw.reset).toHaveBeenCalled();
  });

  it("ensureArticleRange skips reset when position unchanged (tile-load requery)", () => {
    const aw = stubArticleWindow({
      reset: vi.fn(),
      ensureRange: vi.fn(async () => {}),
    });
    const deps = makeDeps({
      createArticleWindow: vi.fn(() => aw),
    });

    const lifecycle = createArticleWindowLifecycle(deps);

    // First call creates the window
    lifecycle.ensureArticleRange(pos, 200);
    expect(deps.createArticleWindow).toHaveBeenCalledTimes(1);

    // Second call with same position: reuses window, no reset
    lifecycle.ensureArticleRange(pos, 400);
    expect(aw.reset).not.toHaveBeenCalled();
    expect(deps.createArticleWindow).toHaveBeenCalledTimes(1);
    expect(aw.ensureRange).toHaveBeenLastCalledWith(0, 400);
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
    expect(aw.reset).toHaveBeenCalled();
  });
});

describe("getArticleByIndex", () => {
  it("returns article from ArticleWindow when available", () => {
    const awArticle: NearbyArticle = {
      title: "Gamla Stan",
      lat: 59.32,
      lon: 18.07,
      distanceM: 100,
    };
    const aw = stubArticleWindow({
      getArticle: vi.fn(() => awArticle),
    });
    const deps = makeDeps({
      createArticleWindow: vi.fn(() => aw),
    });

    const lifecycle = createArticleWindowLifecycle(deps);
    lifecycle.getOrCreateArticleWindow();

    expect(lifecycle.getArticleByIndex(0)).toBe(awArticle);
  });

  it("falls back to viewport articles when ArticleWindow returns undefined", () => {
    const aw = stubArticleWindow({
      getArticle: vi.fn(() => undefined),
    });
    const deps = makeDeps({
      createArticleWindow: vi.fn(() => aw),
    });

    const lifecycle = createArticleWindowLifecycle(deps);
    lifecycle.getOrCreateArticleWindow();

    expect(lifecycle.getArticleByIndex(0)).toBe(article);
  });

  it("returns undefined when not in browsing phase", () => {
    const deps = makeDeps({
      getState: vi.fn(() => ({
        ...tiledAppState(),
        phase: { phase: "welcome" as const },
      })),
    });

    const lifecycle = createArticleWindowLifecycle(deps);

    expect(lifecycle.getArticleByIndex(0)).toBeUndefined();
  });

  it("returns viewport article when no ArticleWindow exists", () => {
    const deps = makeDeps();

    const lifecycle = createArticleWindowLifecycle(deps);

    expect(lifecycle.getArticleByIndex(0)).toBe(article);
  });

  it("returns undefined for out-of-bounds index in viewport fallback", () => {
    const deps = makeDeps();

    const lifecycle = createArticleWindowLifecycle(deps);

    // Viewport has only 1 article (index 0); index 1 is out of bounds
    expect(lifecycle.getArticleByIndex(1)).toBeUndefined();
  });
});

describe("scroll count observer", () => {
  it("notifies observer with totalKnown when it exceeds loadedCount", () => {
    let capturedOnWindowChange: (() => void) | undefined;
    const aw = stubArticleWindow({
      totalKnown: vi.fn(() => 500),
      loadedCount: vi.fn(() => 100),
    });
    const deps = makeDeps({
      createArticleWindow: vi.fn((opts) => {
        capturedOnWindowChange = opts.onWindowChange;
        return aw;
      }),
    });

    const observer = vi.fn();
    const lifecycle = createArticleWindowLifecycle(deps);
    lifecycle.attachScrollCountObserver(observer);
    lifecycle.getOrCreateArticleWindow();
    capturedOnWindowChange!();

    expect(observer).toHaveBeenCalledWith(500, 100);
  });

  it("notifies observer with loadedCount when totalKnown is not larger", () => {
    let capturedOnWindowChange: (() => void) | undefined;
    const aw = stubArticleWindow({
      totalKnown: vi.fn(() => 50),
      loadedCount: vi.fn(() => 100),
    });
    const deps = makeDeps({
      createArticleWindow: vi.fn((opts) => {
        capturedOnWindowChange = opts.onWindowChange;
        return aw;
      }),
    });

    const observer = vi.fn();
    const lifecycle = createArticleWindowLifecycle(deps);
    lifecycle.attachScrollCountObserver(observer);
    lifecycle.getOrCreateArticleWindow();
    capturedOnWindowChange!();

    expect(observer).toHaveBeenCalledWith(100, 100);
  });

  it("never shrinks the scroll count below a previous update", () => {
    let capturedOnWindowChange: (() => void) | undefined;
    const totalKnown = vi.fn(() => 500);
    const loadedCount = vi.fn(() => 100);
    const aw = stubArticleWindow({ totalKnown, loadedCount });
    const deps = makeDeps({
      createArticleWindow: vi.fn((opts) => {
        capturedOnWindowChange = opts.onWindowChange;
        return aw;
      }),
    });

    const observer = vi.fn();
    const lifecycle = createArticleWindowLifecycle(deps);
    lifecycle.attachScrollCountObserver(observer);
    lifecycle.getOrCreateArticleWindow();

    // First callback: count goes up to 500
    capturedOnWindowChange!();
    expect(observer).toHaveBeenLastCalledWith(500, 100);

    // Second callback with lower values: scroll count stays at 500
    totalKnown.mockReturnValue(30);
    loadedCount.mockReturnValue(30);
    capturedOnWindowChange!();
    expect(observer).toHaveBeenLastCalledWith(500, 30);
  });

  it("resets scroll count floor after resetArticleWindow", () => {
    let capturedOnWindowChange: (() => void) | undefined;
    const totalKnown = vi.fn(() => 500);
    const loadedCount = vi.fn(() => 100);
    const aw = stubArticleWindow({ totalKnown, loadedCount });
    const deps = makeDeps({
      createArticleWindow: vi.fn((opts) => {
        capturedOnWindowChange = opts.onWindowChange;
        return aw;
      }),
    });

    const observer = vi.fn();
    const lifecycle = createArticleWindowLifecycle(deps);
    lifecycle.attachScrollCountObserver(observer);
    lifecycle.getOrCreateArticleWindow();

    // Push count to 500
    capturedOnWindowChange!();
    expect(observer).toHaveBeenLastCalledWith(500, 100);

    // Reset clears the floor
    lifecycle.resetArticleWindow();

    // Re-create with lower values — count is now allowed to be lower
    totalKnown.mockReturnValue(30);
    loadedCount.mockReturnValue(30);
    lifecycle.getOrCreateArticleWindow();
    capturedOnWindowChange!();
    expect(observer).toHaveBeenLastCalledWith(30, 30);
  });

  it("never shrinks below an optimistic count set via applyOptimisticCount", () => {
    let capturedOnWindowChange: (() => void) | undefined;
    const totalKnown = vi.fn(() => 0);
    const loadedCount = vi.fn(() => 100);
    const aw = stubArticleWindow({ totalKnown, loadedCount });
    const deps = makeDeps({
      createArticleWindow: vi.fn((opts) => {
        capturedOnWindowChange = opts.onWindowChange;
        return aw;
      }),
    });

    const observer = vi.fn();
    const lifecycle = createArticleWindowLifecycle(deps);
    lifecycle.attachScrollCountObserver(observer);
    lifecycle.getOrCreateArticleWindow();

    // Simulate onNearEnd: optimistic count = 300
    lifecycle.applyOptimisticCount(300);
    expect(observer).toHaveBeenLastCalledWith(300, 100);

    // Simulate onWindowChange after fetch: realCount = 250 < 300
    totalKnown.mockReturnValue(250);
    loadedCount.mockReturnValue(200);
    capturedOnWindowChange!();

    // Scroll count must NOT shrink from 300 to 250, but loadedCount reflects reality
    expect(observer).toHaveBeenLastCalledWith(300, 200);
  });

  it("suppresses scroll count when onWindowChange fires with loadedCount 0 and totalKnown > 0", () => {
    let capturedOnWindowChange: (() => void) | undefined;
    const aw = stubArticleWindow({
      totalKnown: vi.fn(() => 200),
      loadedCount: vi.fn(() => 0),
      getLoadedArticles: vi.fn(() => []),
    });
    const deps = makeDeps({
      createArticleWindow: vi.fn((opts) => {
        capturedOnWindowChange = opts.onWindowChange;
        return aw;
      }),
    });

    const observer = vi.fn();
    const lifecycle = createArticleWindowLifecycle(deps);
    lifecycle.attachScrollCountObserver(observer);
    lifecycle.getOrCreateArticleWindow();
    capturedOnWindowChange!();

    // Should suppress count (return 0) to avoid empty-list jump,
    // matching computeOptimisticCount's loaded===0 guard.
    expect(observer).toHaveBeenCalledWith(0, 0);
  });

  it("applyOptimisticCount passes undefined loadedCount when no ArticleWindow exists", () => {
    const observer = vi.fn();
    const lifecycle = createArticleWindowLifecycle(makeDeps());
    lifecycle.attachScrollCountObserver(observer);
    lifecycle.applyOptimisticCount(300);

    expect(observer).toHaveBeenCalledWith(300, undefined);
  });

  it("throws on double-attach", () => {
    const deps = makeDeps();
    const lifecycle = createArticleWindowLifecycle(deps);
    lifecycle.attachScrollCountObserver(() => {});
    expect(() => lifecycle.attachScrollCountObserver(() => {})).toThrow(
      /already attached/,
    );
  });

  it("allows re-attach after detach", () => {
    const deps = makeDeps();
    const lifecycle = createArticleWindowLifecycle(deps);
    lifecycle.attachScrollCountObserver(() => {});
    lifecycle.attachScrollCountObserver(null);
    expect(() => lifecycle.attachScrollCountObserver(() => {})).not.toThrow();
  });
});

describe("articles observer", () => {
  it("notifies observer with loaded articles on window change", () => {
    let capturedOnWindowChange: (() => void) | undefined;
    const loadedArticles: NearbyArticle[] = [
      { title: "A", lat: 1, lon: 2, distanceM: 10 },
      { title: "B", lat: 3, lon: 4, distanceM: 20 },
    ];
    const aw = stubArticleWindow({
      totalKnown: vi.fn(() => 100),
      loadedCount: vi.fn(() => 2),
      getLoadedArticles: vi.fn(() => loadedArticles),
    });
    const deps = makeDeps({
      createArticleWindow: vi.fn((opts) => {
        capturedOnWindowChange = opts.onWindowChange;
        return aw;
      }),
    });

    const observer = vi.fn();
    const lifecycle = createArticleWindowLifecycle(deps);
    lifecycle.attachArticlesObserver(observer);
    lifecycle.getOrCreateArticleWindow();
    capturedOnWindowChange!();

    expect(observer).toHaveBeenCalledWith(loadedArticles);
  });

  it("does not notify when no articles are loaded", () => {
    let capturedOnWindowChange: (() => void) | undefined;
    const aw = stubArticleWindow({
      totalKnown: vi.fn(() => 0),
      loadedCount: vi.fn(() => 0),
      getLoadedArticles: vi.fn(() => []),
    });
    const deps = makeDeps({
      createArticleWindow: vi.fn((opts) => {
        capturedOnWindowChange = opts.onWindowChange;
        return aw;
      }),
    });

    const observer = vi.fn();
    const lifecycle = createArticleWindowLifecycle(deps);
    lifecycle.attachArticlesObserver(observer);
    lifecycle.getOrCreateArticleWindow();
    capturedOnWindowChange!();

    expect(observer).not.toHaveBeenCalled();
  });

  it("throws on double-attach", () => {
    const lifecycle = createArticleWindowLifecycle(makeDeps());
    lifecycle.attachArticlesObserver(() => {});
    expect(() => lifecycle.attachArticlesObserver(() => {})).toThrow(
      /already attached/,
    );
  });

  it("allows re-attach after detach", () => {
    const lifecycle = createArticleWindowLifecycle(makeDeps());
    lifecycle.attachArticlesObserver(() => {});
    lifecycle.attachArticlesObserver(null);
    expect(() => lifecycle.attachArticlesObserver(() => {})).not.toThrow();
  });
});

describe("computeOptimisticCount", () => {
  it("returns known when known > loaded", () => {
    expect(computeOptimisticCount(500, 100)).toBe(500);
  });

  it("returns loaded when known equals loaded (no phantom buffer)", () => {
    expect(computeOptimisticCount(100, 100)).toBe(100);
  });

  it("returns loaded when known is 0 but loaded > 0", () => {
    expect(computeOptimisticCount(0, 50)).toBe(50);
  });

  it("suppresses count before first batch loads to avoid empty-list jump", () => {
    expect(computeOptimisticCount(50, 0)).toBe(0);
  });

  it("returns 0 when both known and loaded are 0", () => {
    expect(computeOptimisticCount(0, 0)).toBe(0);
  });
});

describe("onWindowChange stale-window guard", () => {
  it("ignores onWindowChange fired from an orphaned AW after the lifecycle replaced it", () => {
    // Regression for tour-guide-hzqi. The lifecycle's onWindowChange closure
    // captures `articleWindow` by reference. If a deferred onWindowChange from
    // an AW that was already replaced fires, the callback would read
    // loadedCount() / getLoadedArticles() from the NEW AW (which has 0 loaded
    // immediately after creation) and pipe stale (0, 0) through the observers,
    // visually nuking the rendered list to the empty state.
    //
    // Drive both AWs through the lifecycle so we can fire onWindowChange on
    // the FIRST AW *after* the second one has taken its place.
    let firstOnChange: (() => void) | undefined;
    let secondOnChange: (() => void) | undefined;
    const firstAw = stubArticleWindow({
      // The orphaned AW carries real loaded data — if its callback ever
      // mutates lifecycle state it would push (50, 50) through. We don't
      // want it to push anything at all.
      loadedCount: vi.fn(() => 50),
      getLoadedArticles: vi.fn(() => [
        { title: "Old", lat: 1, lon: 2, distanceM: 10 },
      ]),
    });
    const secondAw = stubArticleWindow({
      loadedCount: vi.fn(() => 0),
      getLoadedArticles: vi.fn(() => []),
    });

    let createCount = 0;
    const deps = makeDeps({
      createArticleWindow: vi.fn((opts) => {
        createCount++;
        if (createCount === 1) {
          firstOnChange = opts.onWindowChange;
          return firstAw;
        }
        secondOnChange = opts.onWindowChange;
        return secondAw;
      }),
    });

    const scrollObserver = vi.fn();
    const articlesObserver = vi.fn();
    const lifecycle = createArticleWindowLifecycle(deps);
    lifecycle.attachScrollCountObserver(scrollObserver);
    lifecycle.attachArticlesObserver(articlesObserver);

    // Create AW #1 and replace it before its onWindowChange has fired.
    lifecycle.getOrCreateArticleWindow();
    lifecycle.resetArticleWindow();
    lifecycle.getOrCreateArticleWindow();

    // Sanity: the lifecycle has two distinct AWs and two distinct callbacks.
    expect(createCount).toBe(2);
    expect(firstOnChange).toBeDefined();
    expect(secondOnChange).toBeDefined();
    expect(firstOnChange).not.toBe(secondOnChange);

    // Now fire the orphaned callback. The lifecycle's current AW is the
    // SECOND one — the orphan's callback must not push the first AW's
    // (50, [Old]) data, AND must not pipe the second AW's empty (0, []) data
    // either. Either way is wrong: the only correct behavior is to ignore
    // the call entirely.
    scrollObserver.mockClear();
    articlesObserver.mockClear();
    firstOnChange!();

    expect(scrollObserver).not.toHaveBeenCalled();
    expect(articlesObserver).not.toHaveBeenCalled();

    // The second AW's own callback still works — only orphans are ignored.
    secondOnChange!();
    expect(scrollObserver).toHaveBeenCalledWith(0, 0);
    // Empty articles list — articlesObserver should not fire (existing
    // behavior: notifies only when loadedArticles.length > 0).
    expect(articlesObserver).not.toHaveBeenCalled();
  });
});
