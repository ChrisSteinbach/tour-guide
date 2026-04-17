import type { Mock } from "vitest";
import type { NearbyArticle, UserPosition } from "./types";
import type { AppState, QueryState } from "./state-machine";
import type {
  EffectDeps,
  RenderDeps,
  DataDeps,
  StorageDeps,
} from "./effect-executor";
import type { TileEntry } from "../tiles";
import { createEffectExecutor, STARTED_STORAGE_KEY } from "./effect-executor";
import { LANG_STORAGE_KEY } from "./stored-lang";
import type { SummaryLoader } from "./summary-loader";
import { NearestQuery } from "./query";

// ── Helpers ──────────────────────────────────────────────────
//
// makeDeps() provides inert defaults so each test only overrides
// the dep group it exercises.

const pos: UserPosition = { lat: 59.33, lon: 18.07 };
const stubNearestQuery = new NearestQuery(
  {
    vertexPoints: new Float64Array(0),
    vertexTriangles: new Uint32Array(0),
    triangleVertices: new Uint32Array(0),
    triangleNeighbors: new Uint32Array(0),
  },
  [],
);

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
      nearbyCount: 15,
      paused: false,
      pauseReason: null,
      lastQueryPos: pos,
      scrollMode: "viewport",
      infiniteScrollLimit: 200,
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
    gpsSignalLost: false,
    viewportFillCount: 15,
    aboutOpen: false,
    ...overrides,
  };
}

function detailState(overrides: Partial<AppState> = {}): AppState {
  return {
    phase: {
      phase: "detail",
      article,
      articles: [article],
      nearbyCount: 15,
      paused: false,
      pauseReason: null,
      lastQueryPos: pos,
      scrollMode: "viewport",
      infiniteScrollLimit: 200,
      savedFirstVisibleIndex: 0,
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
    gpsSignalLost: false,
    viewportFillCount: 15,
    aboutOpen: false,
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

function makeUi(overrides: Partial<RenderDeps> = {}): RenderDeps {
  return {
    render: vi.fn(),
    renderBrowsingList: vi.fn(),
    renderBrowsingHeader: vi.fn(),
    updateDistances: vi.fn(),
    showAbout: vi.fn(),
    hideAbout: vi.fn(),
    renderDetailLoading: vi.fn(),
    renderDetailReady: vi.fn(),
    renderDetailError: vi.fn(),
    renderAppUpdateBanner: vi.fn(),
    showMapPicker: vi.fn(),
    scrollToTop: vi.fn(),
    restoreScrollTop: vi.fn(),
    ...overrides,
  };
}

function makeData(overrides: Partial<DataDeps> = {}): DataDeps {
  return {
    loadTileIndex: vi.fn(async () => null),
    loadTile: vi.fn(async () => stubNearestQuery),
    tilesForPosition: vi.fn(() => ({ primary: "t1", adjacent: [] })),
    getTileEntry: vi.fn(),
    nearestExistingTiles: vi.fn(() => []),
    ...overrides,
  };
}

function makeStorage(overrides: Partial<StorageDeps> = {}): StorageDeps {
  return {
    setItem: vi.fn(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<EffectDeps> = {}): EffectDeps & {
  getState: Mock;
  dispatch: Mock;
} {
  const deps: EffectDeps = {
    getState: vi.fn(() => browsingState()),
    dispatch: vi.fn(),
    watchLocation: vi.fn(() => vi.fn()),
    pushState: vi.fn(),
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
    ui: makeUi(),
    data: makeData(),
    storage: makeStorage(),
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
      data: makeData({ loadTileIndex: vi.fn(async () => index) }),
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
      data: makeData({
        loadTileIndex: vi.fn(async (_lang, signal) => {
          signalFromFirst ??= signal;
          return null;
        }),
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
      data: makeData({
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
      }),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "loadData", lang: "en" });
    // Wait for the promise to settle
    await vi.waitFor(() => {
      expect(deps.data.loadTileIndex).toHaveBeenCalled();
    });
    // Flush the .then handler chained on loadTileIndex
    await (deps.data.loadTileIndex as Mock).mock.results[0]?.value;

    // dispatch should NOT have been called because generation was stale
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "tileIndexLoaded" }),
    );
  });

  it("loadData dispatches null index on fetch failure", async () => {
    const deps = makeDeps({
      getState: vi.fn(() => browsingState({ loadGeneration: 1 })),
      data: makeData({
        loadTileIndex: vi.fn(async () => {
          throw new Error("network error");
        }),
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

  it("loadTiles aborts previous in-flight tile loads on re-pick", async () => {
    let signalFromFirst: AbortSignal | undefined;
    const entry = makeTileEntry("t1");
    const tileMap = new Map([["t1", entry]]);
    const deps = makeDeps({
      getState: vi.fn(() => tiledState(tileMap)),
      data: makeData({
        tilesForPosition: vi.fn(() => ({ primary: "t1", adjacent: [] })),
        getTileEntry: vi.fn((_map, id) => (id === "t1" ? entry : undefined)),
        loadTile: vi.fn(async (_lang, _entry, signal) => {
          signalFromFirst ??= signal;
          return stubNearestQuery;
        }),
      }),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "loadTiles", lang: "en" });
    exec({ type: "loadTiles", lang: "en" });

    expect(signalFromFirst!.aborted).toBe(true);
  });

  it("loadTiles dispatches tileLoadStarted then tileLoaded", async () => {
    const entry = makeTileEntry("t1");
    const tileMap = new Map([["t1", entry]]);
    const deps = makeDeps({
      getState: vi.fn(() => tiledState(tileMap)),
      data: makeData({
        tilesForPosition: vi.fn(() => ({ primary: "t1", adjacent: [] })),
        getTileEntry: vi.fn((_map, id) => (id === "t1" ? entry : undefined)),
        loadTile: vi.fn(async () => stubNearestQuery),
      }),
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

  it("loadTiles loads adjacent tiles concurrently without awaiting each one", async () => {
    const entryP = makeTileEntry("tp");
    const entryA1 = makeTileEntry("ta1", "h2");
    const entryA2 = makeTileEntry("ta2", "h3");
    const tileMap = new Map<string, TileEntry>([
      ["tp", entryP],
      ["ta1", entryA1],
      ["ta2", entryA2],
    ]);

    // Track the order of loadTile calls and when they resolve
    const loadOrder: string[] = [];
    const resolvers: Array<() => void> = [];
    const deps = makeDeps({
      getState: vi.fn(() => tiledState(tileMap)),
      data: makeData({
        tilesForPosition: vi.fn(() => ({
          primary: "tp",
          adjacent: ["ta1", "ta2"],
        })),
        getTileEntry: vi.fn((_map, id) => tileMap.get(id as string)),
        loadTile: vi.fn((_lang, entry: TileEntry) => {
          loadOrder.push(entry.id);
          return new Promise<NearestQuery>((resolve) => {
            resolvers.push(() => resolve(stubNearestQuery));
          });
        }),
      }),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "loadTiles", lang: "en" });

    // Primary tile must be loaded first and awaited before adjacent tiles start
    expect(loadOrder).toEqual(["tp"]);

    // Resolve primary tile — this unblocks adjacent tile loading
    resolvers[0]();
    await vi.waitFor(() => {
      expect(loadOrder).toHaveLength(3);
    });

    // Both adjacent tiles were initiated before either resolved
    expect(loadOrder).toEqual(["tp", "ta1", "ta2"]);
    expect(resolvers).toHaveLength(3);
    // Neither adjacent promise has been resolved yet, confirming concurrency
  });

  it("loadTiles skips already-loaded and in-progress tiles", async () => {
    const entry1 = makeTileEntry("t1");
    const entry2 = makeTileEntry("t2", "h2");
    const tileMap = new Map<string, TileEntry>([
      ["t1", entry1],
      ["t2", entry2],
    ]);
    const existingTiles = new Map([["t1", stubNearestQuery]]);
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
      data: makeData({
        tilesForPosition: vi.fn(() => ({ primary: "t1", adjacent: ["t2"] })),
        getTileEntry: vi.fn((_map, id) => tileMap.get(id)),
      }),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "loadTiles", lang: "en" });
    // All tiles are skipped synchronously; flush async function completion
    await Promise.resolve();

    // Neither tile should trigger tileLoadStarted
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "tileLoadStarted" }),
    );
  });

  it("loadTiles ignores stale generation after await", async () => {
    const entry = makeTileEntry("t1");
    const tileMap = new Map([["t1", entry]]);
    let loadResolved = false;
    const deps = makeDeps({
      getState: vi.fn(() => {
        // After loadTile resolves, generation has advanced
        return tiledState(tileMap, {
          loadGeneration: loadResolved ? 99 : 1,
        });
      }),
      data: makeData({
        tilesForPosition: vi.fn(() => ({ primary: "t1", adjacent: [] })),
        getTileEntry: vi.fn((_map, id) => (id === "t1" ? entry : undefined)),
        loadTile: vi.fn(async () => {
          loadResolved = true;
          return stubNearestQuery;
        }),
      }),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "loadTiles", lang: "en" });
    // Await loadTile's promise to flush its .then handler
    await vi.waitFor(() => {
      expect(deps.data.loadTile).toHaveBeenCalled();
    });
    await (deps.data.loadTile as Mock).mock.results[0]?.value;

    // tileLoadStarted fires before the await, but tileLoaded should NOT
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tileLoadStarted" }),
    );
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "tileLoaded" }),
    );
  });

  it("loadTiles dispatches noTilesNearby when no tiles exist for position", async () => {
    const tileMap = new Map<string, TileEntry>();
    const deps = makeDeps({
      getState: vi.fn(() =>
        tiledState(tileMap, { phase: { phase: "loadingTiles" } }),
      ),
      data: makeData({
        tilesForPosition: vi.fn(() => ({ primary: "28-38", adjacent: [] })),
        getTileEntry: vi.fn(() => undefined),
      }),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "loadTiles", lang: "de" });
    await Promise.resolve();

    expect(deps.dispatch).toHaveBeenCalledWith({ type: "noTilesNearby" });
  });

  it("loadTiles does not dispatch noTilesNearby when tiles are in progress", async () => {
    const tileMap = new Map<string, TileEntry>();
    const deps = makeDeps({
      getState: vi.fn(() =>
        tiledState(tileMap, {
          phase: { phase: "loadingTiles" },
          loadingTiles: new Set(["28-38"]),
        }),
      ),
      data: makeData({
        tilesForPosition: vi.fn(() => ({ primary: "28-38", adjacent: [] })),
        getTileEntry: vi.fn(() => undefined),
      }),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "loadTiles", lang: "de" });
    await Promise.resolve();

    expect(deps.dispatch).not.toHaveBeenCalledWith({ type: "noTilesNearby" });
  });

  it("loadTiles does not dispatch noTilesNearby when tiles are loaded", async () => {
    const entry = makeTileEntry("t1");
    const tileMap = new Map([["t1", entry]]);
    const deps = makeDeps({
      getState: vi.fn(() => tiledState(tileMap)),
      data: makeData({
        tilesForPosition: vi.fn(() => ({ primary: "t1", adjacent: [] })),
        getTileEntry: vi.fn((_map, id) => (id === "t1" ? entry : undefined)),
        loadTile: vi.fn(async () => stubNearestQuery),
      }),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "loadTiles", lang: "en" });
    await vi.waitFor(() => {
      expect(deps.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "tileLoaded" }),
      );
    });

    expect(deps.dispatch).not.toHaveBeenCalledWith({ type: "noTilesNearby" });
  });

  it("loadTiles falls back to nearestExistingTiles when no tiles exist at position", async () => {
    const entryNearby1 = makeTileEntry("t-nearby1", "h1");
    const entryNearby2 = makeTileEntry("t-nearby2", "h2");
    const tileMap = new Map<string, TileEntry>([
      ["t-nearby1", entryNearby1],
      ["t-nearby2", entryNearby2],
    ]);

    // Track load order to verify primary-first behavior
    const loadOrder: string[] = [];
    const resolvers: Array<() => void> = [];
    const deps = makeDeps({
      getState: vi.fn(() => tiledState(tileMap)),
      data: makeData({
        // tilesForPosition returns a tile that doesn't exist in the map
        tilesForPosition: vi.fn(() => ({
          primary: "t-nonexistent",
          adjacent: [],
        })),
        // getTileEntry returns undefined for the nonexistent tile,
        // but returns entries for the fallback tiles
        getTileEntry: vi.fn((_map, id) => tileMap.get(id as string)),
        // Ring expansion finds nearby tiles
        nearestExistingTiles: vi.fn(() => ["t-nearby1", "t-nearby2"]),
        loadTile: vi.fn((_lang, entry: TileEntry) => {
          loadOrder.push(entry.id);
          return new Promise<NearestQuery>((resolve) => {
            resolvers.push(() => resolve(stubNearestQuery));
          });
        }),
      }),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "loadTiles", lang: "en" });

    // nearestExistingTiles should have been called
    expect(deps.data.nearestExistingTiles).toHaveBeenCalledWith(
      tileMap,
      pos.lat,
      pos.lon,
    );

    // First fallback tile is primary — loaded first and awaited
    expect(loadOrder).toEqual(["t-nearby1"]);

    // Resolve the primary tile to unblock the rest
    resolvers[0]();
    await vi.waitFor(() => {
      expect(loadOrder).toHaveLength(2);
    });

    // Second tile loaded concurrently after primary resolved
    expect(loadOrder).toEqual(["t-nearby1", "t-nearby2"]);

    // Both tiles dispatched tileLoadStarted
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tileLoadStarted", id: "t-nearby1" }),
    );
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tileLoadStarted", id: "t-nearby2" }),
    );

    // Resolve second tile and verify tileLoaded dispatched for both tiles
    resolvers[1]();
    await vi.waitFor(() => {
      expect(deps.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "tileLoaded", id: "t-nearby1" }),
      );
      expect(deps.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "tileLoaded", id: "t-nearby2" }),
      );
    });

    // Fallback path should NOT dispatch noTilesNearby — tiles were found
    expect(deps.dispatch).not.toHaveBeenCalledWith({ type: "noTilesNearby" });
  });

  it("loadTiles falls back to ring expansion when primary tile is absent but adjacent exists", async () => {
    const entryAdj = makeTileEntry("t-adj", "h1");
    const entryRing = makeTileEntry("t-ring", "h2");
    const tileMap = new Map<string, TileEntry>([
      ["t-adj", entryAdj],
      ["t-ring", entryRing],
    ]);

    const loadOrder: string[] = [];
    const resolvers: Array<() => void> = [];
    const deps = makeDeps({
      getState: vi.fn(() => tiledState(tileMap)),
      data: makeData({
        // Primary tile doesn't exist, but adjacent does
        tilesForPosition: vi.fn(() => ({
          primary: "t-empty",
          adjacent: ["t-adj"],
        })),
        getTileEntry: vi.fn((_map, id) => tileMap.get(id as string)),
        // Ring expansion returns the nearest existing tiles
        nearestExistingTiles: vi.fn(() => ["t-ring", "t-adj"]),
        loadTile: vi.fn((_lang, entry: TileEntry) => {
          loadOrder.push(entry.id);
          return new Promise<NearestQuery>((resolve) => {
            resolvers.push(() => resolve(stubNearestQuery));
          });
        }),
      }),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "loadTiles", lang: "en" });

    // Fallback should trigger even though adjacent tile exists
    expect(deps.data.nearestExistingTiles).toHaveBeenCalledWith(
      tileMap,
      pos.lat,
      pos.lon,
    );

    // First ring-expansion tile is primary — loaded first and awaited
    expect(loadOrder).toEqual(["t-ring"]);

    // Resolve the primary to unblock adjacent tiles
    resolvers[0]();
    await vi.waitFor(() => {
      expect(loadOrder).toHaveLength(2);
    });

    expect(loadOrder).toEqual(["t-ring", "t-adj"]);
  });

  it("loadTiles skips already-loaded tiles from nearestExistingTiles fallback (GPS into ocean)", async () => {
    const entryA = makeTileEntry("t-coast1", "h1");
    const entryB = makeTileEntry("t-coast2", "h2");
    const tileMap = new Map<string, TileEntry>([
      ["t-coast1", entryA],
      ["t-coast2", entryB],
    ]);
    // Both fallback tiles are already loaded in query.tiles
    const existingTiles = new Map<string, NearestQuery>([
      ["t-coast1", stubNearestQuery],
      ["t-coast2", stubNearestQuery],
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
      getState: vi.fn(() => browsingState({ query })),
      data: makeData({
        // Ocean position — no tiles exist here
        tilesForPosition: vi.fn(() => ({
          primary: "t-ocean",
          adjacent: [],
        })),
        getTileEntry: vi.fn((_map, id) => tileMap.get(id as string)),
        // Ring expansion finds the coastal tiles that are already loaded
        nearestExistingTiles: vi.fn(() => ["t-coast1", "t-coast2"]),
        loadTile: vi.fn(async () => stubNearestQuery),
      }),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "loadTiles", lang: "en" });
    // All tiles are skipped synchronously; flush async function completion
    await Promise.resolve();

    // nearestExistingTiles should have been called (ocean fallback triggered)
    expect(deps.data.nearestExistingTiles).toHaveBeenCalledWith(
      tileMap,
      pos.lat,
      pos.lon,
    );

    // Already-loaded tiles should not trigger any fetch
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "tileLoadStarted" }),
    );
    expect(deps.data.loadTile).not.toHaveBeenCalled();
  });

  it("loadTiles dispatches tileLoadFailed when a tile fetch rejects", async () => {
    const entry = makeTileEntry("t1");
    const tileMap = new Map([["t1", entry]]);
    const deps = makeDeps({
      getState: vi.fn(() => tiledState(tileMap)),
      data: makeData({
        tilesForPosition: vi.fn(() => ({ primary: "t1", adjacent: [] })),
        getTileEntry: vi.fn((_map, id) => (id === "t1" ? entry : undefined)),
        loadTile: vi.fn(async () => {
          throw new Error("network error");
        }),
      }),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "loadTiles", lang: "en" });
    await vi.waitFor(() => {
      expect(deps.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "tileLoadFailed", id: "t1" }),
      );
    });
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
    expect(deps.ui.renderDetailLoading).toHaveBeenCalledWith(article);

    await vi.waitFor(() => {
      expect(deps.ui.renderDetailReady).toHaveBeenCalledWith(article, summary);
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
    // Await fetchArticleSummary's promise to flush its .then handler
    await vi.waitFor(() => {
      expect(deps.fetchArticleSummary).toHaveBeenCalled();
    });
    await (deps.fetchArticleSummary as Mock).mock.results[0]?.value;

    expect(deps.ui.renderDetailReady).not.toHaveBeenCalled();
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
      expect(deps.ui.renderDetailError).toHaveBeenCalled();
    });

    // Extract and call the retry callback
    const errorCall = (deps.ui.renderDetailError as Mock).mock.calls[0];
    const retryFn = errorCall[2]; // onRetry is the 3rd argument
    retryFn();

    await vi.waitFor(() => {
      expect(deps.ui.renderDetailReady).toHaveBeenCalledWith(article, summary);
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

  it("startGps stops previous watcher before creating a new one", () => {
    const callOrder: string[] = [];
    const firstStop = vi.fn(() => callOrder.push("stopFirst"));
    const secondStop = vi.fn();
    const deps = makeDeps({
      watchLocation: vi
        .fn()
        .mockImplementationOnce((_callbacks) => {
          callOrder.push("watchFirst");
          return firstStop;
        })
        .mockImplementationOnce((_callbacks) => {
          callOrder.push("watchSecond");
          return secondStop;
        }),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "startGps" });
    exec({ type: "startGps" });

    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(deps.watchLocation).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(["watchFirst", "stopFirst", "watchSecond"]);
  });

  it("startGps onPosition callback dispatches position event", () => {
    const deps = makeDeps({
      watchLocation: vi.fn((callbacks) => {
        callbacks.onPosition({ lat: 48.85, lon: 2.35 });
        return vi.fn();
      }),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "startGps" });
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "position",
      pos: { lat: 48.85, lon: 2.35 },
    });
  });

  it("startGps onError callback dispatches gpsError event", () => {
    const error = { code: "TIMEOUT" as const, message: "timed out" };
    const deps = makeDeps({
      watchLocation: vi.fn((callbacks) => {
        callbacks.onError(error);
        return vi.fn();
      }),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "startGps" });
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "gpsError",
      error,
    });
  });

  // ── Wiring correctness ────────────────────────────────────

  it("storeLang writes correct key", () => {
    const deps = makeDeps();
    const exec = createEffectExecutor(deps);

    exec({ type: "storeLang", lang: "sv" });
    expect(deps.storage.setItem).toHaveBeenCalledWith(LANG_STORAGE_KEY, "sv");
  });

  it("storeStarted writes timestamp to localStorage", () => {
    const deps = makeDeps();
    const exec = createEffectExecutor(deps);

    const before = Date.now();
    exec({ type: "storeStarted" });
    const after = Date.now();

    const call = (deps.storage.setItem as Mock).mock.calls.find(
      (args: unknown[]) => args[0] === STARTED_STORAGE_KEY,
    );
    expect(call).toBeDefined();
    const storedTime = Number(call![1]);
    expect(storedTime).toBeGreaterThanOrEqual(before);
    expect(storedTime).toBeLessThanOrEqual(after);
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

  it("requery in infinite scroll mode calls ensureArticleRange then dispatches queryResult", () => {
    const callOrder: string[] = [];
    const ensureArticleRange = vi.fn(() =>
      callOrder.push("ensureArticleRange"),
    );
    const deps = makeDeps({
      getState: vi.fn(() =>
        browsingState({
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
        }),
      ),
      getNearby: vi.fn(() => [article]),
      ensureArticleRange,
      dispatch: vi.fn(() => callOrder.push("dispatch")),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "requery", pos, count: 20 });

    expect(deps.getNearby).toHaveBeenCalled();
    expect(ensureArticleRange).toHaveBeenCalledWith(pos, 20);
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "queryResult",
        articles: [article],
        queryPos: pos,
        count: 20,
      }),
    );
    // ensureArticleRange must run BEFORE queryResult dispatch so the
    // ArticleWindow exists when onNearEnd fires during rendering.
    expect(callOrder).toEqual(["ensureArticleRange", "dispatch"]);
  });

  it("requery in viewport scroll mode uses getNearby even when ensureArticleRange is provided", () => {
    const ensureArticleRange = vi.fn();
    const deps = makeDeps({
      getState: vi.fn(() => browsingState()), // scrollMode defaults to "viewport"
      getNearby: vi.fn(() => [article]),
      ensureArticleRange,
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "requery", pos, count: 10 });

    expect(ensureArticleRange).not.toHaveBeenCalled();
    expect(deps.getNearby).toHaveBeenCalledWith({ mode: "none" }, pos, 10);
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "queryResult",
        articles: [article],
        queryPos: pos,
        count: 10,
      }),
    );
  });

  it("pushHistory calls pushState with the provided state payload", () => {
    const deps = makeDeps();
    const exec = createEffectExecutor(deps);

    exec({
      type: "pushHistory",
      state: { view: "detail", title: "Eiffel Tower" },
    });
    expect(deps.pushState).toHaveBeenCalledWith(
      { view: "detail", title: "Eiffel Tower" },
      "",
    );
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

  it("scrollToTop calls deps.ui.scrollToTop", () => {
    const deps = makeDeps();
    const exec = createEffectExecutor(deps);

    exec({ type: "scrollToTop" });
    expect(deps.ui.scrollToTop).toHaveBeenCalledTimes(1);
  });

  it("restoreScrollTop calls deps.ui.restoreScrollTop with firstVisibleIndex", () => {
    const deps = makeDeps();
    const exec = createEffectExecutor(deps);

    exec({ type: "restoreScrollTop", firstVisibleIndex: 5 });
    expect(deps.ui.restoreScrollTop).toHaveBeenCalledWith(5);
  });

  it("updateDistances guards on browsing phase", () => {
    const deps = makeDeps({
      getState: vi.fn(() => detailState()),
    });
    const exec = createEffectExecutor(deps);

    exec({ type: "updateDistances" });
    expect(deps.ui.updateDistances).not.toHaveBeenCalled();
  });

  it("hideAbout calls deps.ui.hideAbout", () => {
    const deps = makeDeps();
    const exec = createEffectExecutor(deps);

    exec({ type: "hideAbout" });
    expect(deps.ui.hideAbout).toHaveBeenCalled();
  });
});
