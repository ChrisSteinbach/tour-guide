import type { Mock } from "vitest";
import type { NearbyArticle, UserPosition } from "./types";
import type { AppState, QueryState } from "./state-machine";
import type { EffectDeps } from "./effect-executor";
import type { TileEntry } from "../tiles";
import { createEffectExecutor, LANG_STORAGE_KEY } from "./effect-executor";
import type { SummaryLoader } from "./summary-loader";
import { NearestQuery } from "./query";

// ── Helpers ──────────────────────────────────────────────────

const pos: UserPosition = { lat: 59.33, lon: 18.07 };

function makeTileEntry(id: string, hash = "h1"): TileEntry {
  return {
    id,
    row: 0,
    col: 0,
    south: 55,
    north: 60,
    west: 15,
    east: 20,
    articles: 100,
    bytes: 1024,
    hash,
  };
}

const article: NearbyArticle = {
  title: "Stockholm",
  lat: 59.33,
  lon: 18.07,
  distanceM: 42,
};

function browsingState(overrides: Partial<AppState> = {}): AppState {
  return {
    phase: {
      phase: "browsing",
      articles: [article],
      nearbyCount: 10,
      paused: false,
      lastQueryPos: pos,
    },
    query: { mode: "none" },
    position: pos,
    positionSource: null,
    currentLang: "en",
    loadGeneration: 1,
    loadingTiles: new Set(),
    downloadProgress: -1,
    updateBanner: null,
    hasGeolocation: true,
    ...overrides,
  };
}

function detailState(overrides: Partial<AppState> = {}): AppState {
  return {
    phase: {
      phase: "detail",
      article,
      articles: [article],
      nearbyCount: 10,
      paused: false,
      lastQueryPos: pos,
    },
    query: { mode: "none" },
    position: pos,
    positionSource: null,
    currentLang: "en",
    loadGeneration: 1,
    loadingTiles: new Set(),
    downloadProgress: -1,
    updateBanner: null,
    hasGeolocation: true,
    ...overrides,
  };
}

function tiledState(
  tileMap: Map<string, TileEntry>,
  overrides: Partial<AppState> = {},
): AppState {
  const query: QueryState = {
    mode: "tiled",
    index: { version: 1, gridDeg: 5, bufferDeg: 0.5, generated: "", tiles: [] },
    tileMap,
    tiles: new Map(),
  };
  return browsingState({ query, ...overrides });
}

function makeDeps(overrides: Partial<EffectDeps> = {}): EffectDeps & {
  getState: Mock;
  dispatch: Mock;
} {
  const deps: EffectDeps = {
    getState: vi.fn(() => browsingState()),
    dispatch: vi.fn(),
    watchLocation: vi.fn(() => vi.fn()),
    setItem: vi.fn(),
    setSessionItem: vi.fn(),
    pushState: vi.fn(),
    loadTileIndex: vi.fn(async () => null),
    loadTile: vi.fn(
      async () =>
        new NearestQuery(
          {
            vertexPoints: new Float64Array(),
            vertexTriangles: new Uint32Array(),
            triangleVertices: new Uint32Array(),
            triangleNeighbors: new Uint32Array(),
          },
          [],
        ),
    ),
    tilesForPosition: vi.fn(() => ({ primary: "t1", adjacent: [] })),
    getTileEntry: vi.fn(),
    fetchArticleSummary: vi.fn(async () => ({
      title: "Stockholm",
      extract: "Capital of Sweden",
      description: "",
      thumbnailUrl: null,
      thumbnailWidth: null,
      thumbnailHeight: null,
      pageUrl: "https://en.wikipedia.org/wiki/Stockholm",
    })),
    getNearby: vi.fn(() => [article]),
    summaryLoader: {
      load: vi.fn(),
      request: vi.fn(),
      get: vi.fn(),
      cancel: vi.fn(),
    } satisfies SummaryLoader,
    render: vi.fn(),
    renderBrowsingList: vi.fn(),
    updateDistances: vi.fn(),
    renderDetailLoading: vi.fn(),
    renderDetailReady: vi.fn(),
    renderDetailError: vi.fn(),
    renderAppUpdateBanner: vi.fn(),
    showMapPicker: vi.fn(),
    ...overrides,
  };
  return deps as EffectDeps & { getState: Mock; dispatch: Mock };
}

// ── Tests ────────────────────────────────────────────────────

describe("createEffectExecutor", () => {
  // ── Async orchestration: loadData ──────────────────────────

  it("loadData calls loadTileIndex and dispatches tileIndexLoaded", async () => {
    const index = {
      version: 1,
      gridDeg: 5,
      bufferDeg: 0.5,
      generated: "",
      tiles: [],
    };
    const deps = makeDeps({
      getState: vi.fn(() => browsingState({ loadGeneration: 1 })),
      loadTileIndex: vi.fn(async () => index),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "loadData", lang: "en" });
    await vi.waitFor(() => {
      expect(deps.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "tileIndexLoaded",
          index,
          lang: "en",
          gen: 1,
        }),
      );
    });
  });

  it("loadData aborts previous load on second call", async () => {
    let signalFromFirst: AbortSignal | undefined;
    const deps = makeDeps({
      getState: vi.fn(() => browsingState({ loadGeneration: 1 })),
      loadTileIndex: vi.fn(async (_lang, signal) => {
        signalFromFirst ??= signal;
        return null;
      }),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "loadData", lang: "en" });
    exec({ type: "loadData", lang: "sv" });

    expect(signalFromFirst!.aborted).toBe(true);
  });

  it("loadData ignores stale generation results", async () => {
    let callCount = 0;
    const deps = makeDeps({
      getState: vi.fn(() => {
        // After first loadTileIndex resolves, generation has advanced
        return browsingState({ loadGeneration: callCount > 0 ? 2 : 1 });
      }),
      loadTileIndex: vi.fn(async () => {
        callCount++;
        return {
          version: 1,
          gridDeg: 5,
          bufferDeg: 0.5,
          generated: "",
          tiles: [],
        };
      }),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "loadData", lang: "en" });
    // Wait for the promise to settle
    await vi.waitFor(() => {
      expect(deps.loadTileIndex).toHaveBeenCalled();
    });
    // Give the .then handler time to run
    await new Promise((r) => setTimeout(r, 0));

    // dispatch should NOT have been called because generation was stale
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "tileIndexLoaded" }),
    );
  });

  it("loadData dispatches null index on fetch failure", async () => {
    const deps = makeDeps({
      getState: vi.fn(() => browsingState({ loadGeneration: 1 })),
      loadTileIndex: vi.fn(async () => {
        throw new Error("network error");
      }),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "loadData", lang: "en" });
    await vi.waitFor(() => {
      expect(deps.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "tileIndexLoaded", index: null }),
      );
    });
  });

  // ── Async orchestration: loadTiles ─────────────────────────

  it("loadTiles dispatches tileLoadStarted then tileLoaded", async () => {
    const entry = makeTileEntry("t1");
    const tileMap = new Map([["t1", entry]]);
    const mockQuery = new NearestQuery(
      {
        vertexPoints: new Float64Array(),
        vertexTriangles: new Uint32Array(),
        triangleVertices: new Uint32Array(),
        triangleNeighbors: new Uint32Array(),
      },
      [],
    );
    const deps = makeDeps({
      getState: vi.fn(() => tiledState(tileMap)),
      tilesForPosition: vi.fn(() => ({ primary: "t1", adjacent: [] })),
      getTileEntry: vi.fn((_map, id) => (id === "t1" ? entry : undefined)),
      loadTile: vi.fn(async () => mockQuery),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "loadTiles", lang: "en" });
    await vi.waitFor(() => {
      expect(deps.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "tileLoadStarted", id: "t1" }),
      );
      expect(deps.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "tileLoaded", id: "t1" }),
      );
    });
  });

  it("loadTiles skips already-loaded and in-progress tiles", async () => {
    const entry1 = makeTileEntry("t1");
    const entry2 = makeTileEntry("t2", "h2");
    const tileMap = new Map<string, TileEntry>([
      ["t1", entry1],
      ["t2", entry2],
    ]);
    const existingTiles = new Map([
      [
        "t1",
        new NearestQuery(
          {
            vertexPoints: new Float64Array(),
            vertexTriangles: new Uint32Array(),
            triangleVertices: new Uint32Array(),
            triangleNeighbors: new Uint32Array(),
          },
          [],
        ),
      ],
    ]);
    const query: QueryState = {
      mode: "tiled",
      index: {
        version: 1,
        gridDeg: 5,
        bufferDeg: 0.5,
        generated: "",
        tiles: [],
      },
      tileMap,
      tiles: existingTiles,
    };
    const deps = makeDeps({
      getState: vi.fn(() =>
        browsingState({
          query,
          loadingTiles: new Set(["t2"]),
        }),
      ),
      tilesForPosition: vi.fn(() => ({ primary: "t1", adjacent: ["t2"] })),
      getTileEntry: vi.fn((_map, id) => tileMap.get(id)),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "loadTiles", lang: "en" });
    await new Promise((r) => setTimeout(r, 10));

    // Neither tile should trigger tileLoadStarted
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "tileLoadStarted" }),
    );
  });

  it("loadTiles ignores stale generation after await", async () => {
    const entry = makeTileEntry("t1");
    const tileMap = new Map([["t1", entry]]);
    let loadResolved = false;
    const mockQuery = new NearestQuery(
      {
        vertexPoints: new Float64Array(),
        vertexTriangles: new Uint32Array(),
        triangleVertices: new Uint32Array(),
        triangleNeighbors: new Uint32Array(),
      },
      [],
    );
    const deps = makeDeps({
      getState: vi.fn(() => {
        // After loadTile resolves, generation has advanced
        return tiledState(tileMap, {
          loadGeneration: loadResolved ? 99 : 1,
        });
      }),
      tilesForPosition: vi.fn(() => ({ primary: "t1", adjacent: [] })),
      getTileEntry: vi.fn((_map, id) => (id === "t1" ? entry : undefined)),
      loadTile: vi.fn(async () => {
        loadResolved = true;
        return mockQuery;
      }),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "loadTiles", lang: "en" });
    await vi.waitFor(() => {
      expect(deps.loadTile).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 0));

    // tileLoadStarted fires before the await, but tileLoaded should NOT
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tileLoadStarted" }),
    );
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "tileLoaded" }),
    );
  });

  // ── Async orchestration: fetchSummary ──────────────────────

  it("fetchSummary renders loading then ready on success", async () => {
    const summary = {
      title: "Stockholm",
      extract: "Capital of Sweden",
      description: "",
      thumbnailUrl: null,
      thumbnailWidth: null,
      thumbnailHeight: null,
      pageUrl: "https://en.wikipedia.org/wiki/Stockholm",
    };
    const deps = makeDeps({
      getState: vi.fn(() => detailState()),
      fetchArticleSummary: vi.fn(async () => summary),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "fetchSummary", article });
    expect(deps.renderDetailLoading).toHaveBeenCalledWith(article);

    await vi.waitFor(() => {
      expect(deps.renderDetailReady).toHaveBeenCalledWith(article, summary);
    });
  });

  it("fetchSummary abandons render if navigated away during fetch", async () => {
    const deps = makeDeps({
      getState: vi
        .fn()
        .mockReturnValueOnce(detailState()) // initial currentLang read
        .mockReturnValue(browsingState()), // after await — navigated away
      fetchArticleSummary: vi.fn(async () => ({
        title: "Stockholm",
        extract: "",
        description: "",
        thumbnailUrl: null,
        thumbnailWidth: null,
        thumbnailHeight: null,
        pageUrl: "",
      })),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "fetchSummary", article });
    await vi.waitFor(() => {
      expect(deps.fetchArticleSummary).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(deps.renderDetailReady).not.toHaveBeenCalled();
  });

  it("fetchSummary provides working retry on error", async () => {
    const summary = {
      title: "Stockholm",
      extract: "Capital of Sweden",
      description: "",
      thumbnailUrl: null,
      thumbnailWidth: null,
      thumbnailHeight: null,
      pageUrl: "https://en.wikipedia.org/wiki/Stockholm",
    };
    const deps = makeDeps({
      getState: vi.fn(() => detailState()),
      fetchArticleSummary: vi
        .fn()
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValueOnce(summary),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "fetchSummary", article });
    await vi.waitFor(() => {
      expect(deps.renderDetailError).toHaveBeenCalled();
    });

    // Extract and call the retry callback
    const errorCall = (deps.renderDetailError as Mock).mock.calls[0];
    const retryFn = errorCall[2]; // onRetry is the 3rd argument
    retryFn();

    await vi.waitFor(() => {
      expect(deps.renderDetailReady).toHaveBeenCalledWith(article, summary);
    });
  });

  // ── GPS lifecycle ──────────────────────────────────────────

  it("startGps stores watcher; stopGps calls cleanup; second stop is idempotent", () => {
    const stopFn = vi.fn();
    const deps = makeDeps({
      watchLocation: vi.fn(() => stopFn),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "startGps" });
    expect(deps.watchLocation).toHaveBeenCalledTimes(1);

    exec({ type: "stopGps" });
    expect(stopFn).toHaveBeenCalledTimes(1);

    // Second stop is a no-op
    exec({ type: "stopGps" });
    expect(stopFn).toHaveBeenCalledTimes(1);
  });

  // ── Wiring correctness ────────────────────────────────────

  it("storeLang writes correct key", () => {
    const deps = makeDeps();
    const exec = createEffectExecutor(deps);

    exec({ type: "storeLang", lang: "sv" });
    expect(deps.setItem).toHaveBeenCalledWith(LANG_STORAGE_KEY, "sv");
  });

  it("storeStarted writes session flag", () => {
    const deps = makeDeps();
    const exec = createEffectExecutor(deps);

    exec({ type: "storeStarted" });
    expect(deps.setSessionItem).toHaveBeenCalledWith("tour-guide-started", "1");
  });

  it("requery dispatches queryResult", () => {
    const deps = makeDeps({
      getNearby: vi.fn(() => [article]),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "requery", pos, count: 10 });
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "queryResult",
        articles: [article],
        queryPos: pos,
        count: 10,
      }),
    );
  });

  it("pushHistory calls pushState", () => {
    const deps = makeDeps();
    const exec = createEffectExecutor(deps);

    exec({ type: "pushHistory" });
    expect(deps.pushState).toHaveBeenCalledWith({ view: "detail" }, "");
  });

  it("fetchListSummaries calls summaryLoader.load with article titles", () => {
    const summaryLoader: SummaryLoader = {
      load: vi.fn(),
      request: vi.fn(),
      get: vi.fn(),
      cancel: vi.fn(),
    };
    const deps = makeDeps({
      getState: vi.fn(() => browsingState()),
      summaryLoader,
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "fetchListSummaries" });
    expect(summaryLoader.load).toHaveBeenCalledWith(["Stockholm"], "en");
  });

  it("fetchListSummaries is a no-op when not browsing", () => {
    const summaryLoader: SummaryLoader = {
      load: vi.fn(),
      request: vi.fn(),
      get: vi.fn(),
      cancel: vi.fn(),
    };
    const deps = makeDeps({
      getState: vi.fn(() => detailState()),
      summaryLoader,
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "fetchListSummaries" });
    expect(summaryLoader.load).not.toHaveBeenCalled();
  });

  it("updateDistances guards on browsing phase", () => {
    const deps = makeDeps({
      getState: vi.fn(() => detailState()),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "updateDistances" });
    expect(deps.updateDistances).not.toHaveBeenCalled();
  });
});
