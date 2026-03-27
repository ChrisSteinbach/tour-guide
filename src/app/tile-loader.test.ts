import {
  findNearestTiled,
  tilesForPosition,
  buildTileMap,
  updateLru,
  MAX_CACHED_TILES,
  loadTileIndex,
  loadTile,
} from "./tile-loader";
import type { TileLoaderDeps } from "./tile-loader";
import { NearestQuery, toFlatDelaunay } from "./query";
import type { TileIndex, TileEntry } from "../tiles";
import { GRID_DEG } from "../tiles";
import {
  toCartesian,
  convexHull,
  buildTriangulation,
  serialize,
  deserializeBinary,
} from "../geometry";
import type { ArticleMeta, FlatDelaunay } from "../geometry";

vi.mock("../geometry", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("../geometry")>();
  return { ...actual, deserializeBinary: vi.fn() };
});

// ---------- Helpers ----------

/** Build a NearestQuery from a set of lat/lon articles. */
function buildQuery(
  articles: { title: string; lat: number; lon: number }[],
): NearestQuery {
  const points = articles.map((a) => toCartesian({ lat: a.lat, lon: a.lon }));
  const hull = convexHull(points);
  const tri = buildTriangulation(hull);
  const meta: ArticleMeta[] = tri.originalIndices.map((i) => ({
    title: articles[i].title,
  }));
  const data = serialize(tri, meta);
  const fd = toFlatDelaunay(data);
  const metas = data.articles.map((title) => ({ title }));
  return new NearestQuery(fd, metas);
}

/** Create a minimal TileIndex with the given tile IDs. */
function makeIndex(tileIds: string[], hash = "abcd1234"): TileIndex {
  return {
    version: 1,
    gridDeg: GRID_DEG,
    bufferDeg: 0.5,
    generated: "2025-01-01T00:00:00Z",
    tiles: tileIds.map((id) => {
      const [rowStr, colStr] = id.split("-");
      const row = parseInt(rowStr, 10);
      const col = parseInt(colStr, 10);
      return {
        id,
        row,
        col,
        south: row * GRID_DEG - 90,
        north: row * GRID_DEG - 90 + GRID_DEG,
        west: col * GRID_DEG - 180,
        east: col * GRID_DEG - 180 + GRID_DEG,
        articles: 10,
        bytes: 1024,
        hash,
      } satisfies TileEntry;
    }),
  };
}

/** Build a tile map from tile IDs (shorthand for tests). */
function makeTileMap(tileIds: string[]): Map<string, TileEntry> {
  return buildTileMap(makeIndex(tileIds));
}

// Well-spread articles for building valid convex hulls.
// Need enough points so BFS in NearestQuery can expand to k results.
const GLOBAL_ARTICLES = [
  { title: "North Pole", lat: 85, lon: 0 },
  { title: "South Pole", lat: -85, lon: 0 },
  { title: "Pacific", lat: 0, lon: -170 },
  { title: "Indian Ocean", lat: -30, lon: 80 },
  { title: "Atlantic", lat: 30, lon: -30 },
  { title: "Arctic", lat: 80, lon: 100 },
  { title: "Antarctica", lat: -70, lon: -60 },
  { title: "Australia", lat: -25, lon: 135 },
  { title: "Brazil", lat: -15, lon: -50 },
  { title: "Canada", lat: 55, lon: -100 },
  { title: "Japan", lat: 35, lon: 140 },
  { title: "Norway", lat: 62, lon: 10 },
];

// ---------- findNearestTiled ----------

describe("findNearestTiled", () => {
  it("returns results from a single tile", () => {
    const tiles = new Map([["18-36", buildQuery(GLOBAL_ARTICLES)]]);

    const results = findNearestTiled(tiles, 0, 0, 3);
    expect(results.length).toBe(3);
    expect(results[0].title).toBe("Atlantic");
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distanceM).toBeGreaterThanOrEqual(
        results[i - 1].distanceM,
      );
    }
  });

  it("de-duplicates articles across tiles by title", () => {
    const tiles = new Map([
      ["18-36", buildQuery(GLOBAL_ARTICLES)],
      ["18-37", buildQuery(GLOBAL_ARTICLES)],
    ]);

    const results = findNearestTiled(tiles, 0, 0, 6);
    const titles = results.map((r) => r.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("returns empty array when no tiles loaded", () => {
    const tiles = new Map<string, NearestQuery>();

    const results = findNearestTiled(tiles, 0, 0, 5);
    expect(results).toEqual([]);
  });
});

// ---------- tilesForPosition ----------

describe("tilesForPosition", () => {
  it("returns only primary when position is in center of tile", () => {
    const tileMap = makeTileMap(["18-36"]);

    const { primary, adjacent } = tilesForPosition(tileMap, 2.5, 2.5);
    expect(primary).toBe("18-36");
    expect(adjacent).toEqual([]);
  });

  it("includes adjacent tiles when near south edge", () => {
    const tileMap = makeTileMap(["18-36", "17-36"]);

    const { primary, adjacent } = tilesForPosition(tileMap, 0.5, 2.5);
    expect(primary).toBe("18-36");
    expect(adjacent).toContain("17-36");
  });

  it("includes adjacent tiles when near north edge", () => {
    const tileMap = makeTileMap(["18-36", "19-36"]);

    const { primary, adjacent } = tilesForPosition(tileMap, 4.5, 2.5);
    expect(primary).toBe("18-36");
    expect(adjacent).toContain("19-36");
  });

  it("includes adjacent tiles when near west edge", () => {
    const tileMap = makeTileMap(["18-36", "18-35"]);

    const { primary, adjacent } = tilesForPosition(tileMap, 2.5, 0.5);
    expect(primary).toBe("18-36");
    expect(adjacent).toContain("18-35");
  });

  it("includes corner tiles when near corner", () => {
    const tileMap = makeTileMap(["18-36", "17-36", "18-35", "17-35"]);

    const { primary, adjacent } = tilesForPosition(tileMap, 0.5, 0.5);
    expect(primary).toBe("18-36");
    expect(adjacent).toContain("17-36");
    expect(adjacent).toContain("18-35");
    expect(adjacent).toContain("17-35");
  });

  it("wraps longitude at date line (east)", () => {
    const tileMap = makeTileMap(["18-71", "18-00"]);

    const { primary, adjacent } = tilesForPosition(tileMap, 2.5, 179.5);
    expect(primary).toBe("18-71");
    expect(adjacent).toContain("18-00");
  });

  it("wraps longitude at date line (west)", () => {
    const tileMap = makeTileMap(["18-00", "18-71"]);

    const { primary, adjacent } = tilesForPosition(tileMap, 2.5, -179.5);
    expect(primary).toBe("18-00");
    expect(adjacent).toContain("18-71");
  });

  it("clamps latitude (no adjacent south below row 0)", () => {
    const tileMap = makeTileMap(["00-36"]);

    const { primary, adjacent } = tilesForPosition(tileMap, -89.5, 2.5);
    expect(primary).toBe("00-36");
    expect(adjacent).toEqual([]);
  });

  it("clamps latitude (no adjacent north above max row)", () => {
    const tileMap = makeTileMap(["35-36"]);

    const { primary, adjacent } = tilesForPosition(tileMap, 89.5, 2.5);
    expect(primary).toBe("35-36");
    expect(adjacent).toEqual([]);
  });

  it("excludes adjacent tiles not present in the index", () => {
    const tileMap = makeTileMap(["18-36"]);

    const { primary, adjacent } = tilesForPosition(tileMap, 0.5, 2.5);
    expect(primary).toBe("18-36");
    expect(adjacent).toEqual([]);
  });
});

// ---------- updateLru ----------

describe("updateLru", () => {
  it("adds a new tile to the end of an empty list", () => {
    const { updated, evict } = updateLru([], "18-36");
    expect(updated).toEqual(["18-36"]);
    expect(evict).toEqual([]);
  });

  it("moves an existing tile to the end", () => {
    const { updated, evict } = updateLru(["18-35", "18-36", "18-37"], "18-35");
    expect(updated).toEqual(["18-36", "18-37", "18-35"]);
    expect(evict).toEqual([]);
  });

  it("evicts oldest tiles when over the cap", () => {
    const ids = Array.from({ length: 5 }, (_, i) => `tile-${i}`);
    const { updated, evict } = updateLru(ids, "tile-new", 5);
    expect(updated).toEqual([
      "tile-1",
      "tile-2",
      "tile-3",
      "tile-4",
      "tile-new",
    ]);
    expect(evict).toEqual(["tile-0"]);
  });

  it("evicts multiple tiles to get back under the cap", () => {
    // Simulate a cap reduction scenario: 6 items, cap=3, add new
    const ids = ["a", "b", "c", "d", "e", "f"];
    const { updated, evict } = updateLru(ids, "g", 3);
    expect(updated).toEqual(["e", "f", "g"]);
    expect(evict).toEqual(["a", "b", "c", "d"]);
  });

  it("does not evict when exactly at the cap", () => {
    const ids = ["a", "b", "c"];
    const { updated, evict } = updateLru(ids, "c", 3);
    expect(updated).toEqual(["a", "b", "c"]);
    expect(evict).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const ids = ["a", "b", "c"];
    updateLru(ids, "a", 3);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("defaults to MAX_CACHED_TILES", () => {
    const ids = Array.from({ length: MAX_CACHED_TILES }, (_, i) => `t-${i}`);
    const { updated, evict } = updateLru(ids, "new-tile");
    expect(updated.length).toBe(MAX_CACHED_TILES);
    expect(evict).toEqual(["t-0"]);
    expect(updated[updated.length - 1]).toBe("new-tile");
  });
});

// ---------- IDB + network integration helpers ----------

const fakeDb = {} as IDBDatabase;

const SAMPLE_INDEX = makeIndex(["18-36"], "abc123");

/** Build deps with a fake IDB backed by a Map. */
function makeDeps(
  store: Map<string, unknown> = new Map(),
  db: IDBDatabase | null = fakeDb,
): TileLoaderDeps {
  return {
    openDb: () => Promise.resolve(db),
    getAny: <T>(_db: IDBDatabase, key: string) =>
      Promise.resolve(store.get(key) as T | undefined),
    putAny: (_db: IDBDatabase, key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
    deleteKey: (_db: IDBDatabase, key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
}

/** Build deps with no IDB. */
function makeNullDeps(): TileLoaderDeps {
  return makeDeps(new Map(), null);
}

// ---------- loadTileIndex ----------

describe("loadTileIndex", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("propagates abort instead of falling back to null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")),
    );

    const controller = new AbortController();
    controller.abort();

    await expect(
      loadTileIndex("/base/", "en", controller.signal, makeNullDeps()),
    ).rejects.toThrow();
  });

  it("returns null on network error (graceful fallback)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );

    const result = await loadTileIndex(
      "/base/",
      "en",
      undefined,
      makeNullDeps(),
    );
    expect(result).toBeNull();
  });

  it("returns index on successful fetch and caches in IDB", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE_INDEX),
      }),
    );

    const store = new Map<string, unknown>();
    const deps = makeDeps(store);
    const result = await loadTileIndex("/base/", "en", undefined, deps);
    expect(result).toEqual(SAMPLE_INDEX);
    expect(store.get("tile-index-v1-en")).toEqual(SAMPLE_INDEX);
  });

  it("returns null on 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );

    const result = await loadTileIndex("/base/", "en", undefined, makeDeps());
    expect(result).toBeNull();
  });

  it("falls back to IDB cache on non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    const store = new Map<string, unknown>([
      ["tile-index-v1-en", SAMPLE_INDEX],
    ]);
    const result = await loadTileIndex(
      "/base/",
      "en",
      undefined,
      makeDeps(store),
    );
    expect(result).toEqual(SAMPLE_INDEX);
  });

  it("falls back to IDB cache on network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );

    const store = new Map<string, unknown>([
      ["tile-index-v1-en", SAMPLE_INDEX],
    ]);
    const result = await loadTileIndex(
      "/base/",
      "en",
      undefined,
      makeDeps(store),
    );
    expect(result).toEqual(SAMPLE_INDEX);
  });

  it("returns null when cached value is a corrupt object (no tiles array)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );

    const corrupt = { not: "a tile index" };
    const store = new Map<string, unknown>([["tile-index-v1-en", corrupt]]);
    const result = await loadTileIndex(
      "/base/",
      "en",
      undefined,
      makeDeps(store),
    );
    expect(result).toBeNull();
  });

  it("returns null when cached value is a legacy JSON string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );

    const store = new Map<string, unknown>([
      ["tile-index-v1-en", JSON.stringify(SAMPLE_INDEX)],
    ]);
    const result = await loadTileIndex(
      "/base/",
      "en",
      undefined,
      makeDeps(store),
    );
    expect(result).toBeNull();
  });

  it("returns null when IDB read itself throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );

    const deps = makeDeps();
    deps.getAny = () => Promise.reject(new Error("IDB read failed"));
    const result = await loadTileIndex("/base/", "en", undefined, deps);
    expect(result).toBeNull();
  });
});

// ---------- loadTile ----------

describe("loadTile", () => {
  const entry: TileEntry = SAMPLE_INDEX.tiles[0];

  const fakeFd: FlatDelaunay = {
    vertexPoints: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    vertexTriangles: new Uint32Array([0, 0, 0]),
    triangleVertices: new Uint32Array([0, 1, 2]),
    triangleNeighbors: new Uint32Array([0, 0, 0]),
  };
  const fakeArticles: ArticleMeta[] = [
    { title: "A" },
    { title: "B" },
    { title: "C" },
  ];

  const cachedTile = {
    vertexPoints: fakeFd.vertexPoints,
    vertexTriangles: fakeFd.vertexTriangles,
    triangleVertices: fakeFd.triangleVertices,
    triangleNeighbors: fakeFd.triangleNeighbors,
    articles: ["A", "B", "C"],
    hash: "abc123",
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns from IDB cache when hash matches", async () => {
    const store = new Map<string, unknown>([["tile-v1-en-18-36", cachedTile]]);

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await loadTile(
      "/base/",
      "en",
      entry,
      undefined,
      makeDeps(store),
    );
    expect(result).toBeInstanceOf(NearestQuery);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches from network on cache miss", async () => {
    vi.mocked(deserializeBinary).mockReturnValueOnce({
      fd: fakeFd,
      articles: fakeArticles,
    });

    const fakeBuf = new ArrayBuffer(8);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(fakeBuf),
      }),
    );

    const store = new Map<string, unknown>();
    const result = await loadTile(
      "/base/",
      "en",
      entry,
      undefined,
      makeDeps(store),
    );
    expect(result).toBeInstanceOf(NearestQuery);
    expect(store.has("tile-v1-en-18-36")).toBe(true);
  });

  it("fetches from network when cached hash is stale", async () => {
    const staleCache = { ...cachedTile, hash: "old-hash" };
    const store = new Map<string, unknown>([["tile-v1-en-18-36", staleCache]]);

    vi.mocked(deserializeBinary).mockReturnValueOnce({
      fd: fakeFd,
      articles: fakeArticles,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      }),
    );

    const result = await loadTile(
      "/base/",
      "en",
      entry,
      undefined,
      makeDeps(store),
    );
    expect(result).toBeInstanceOf(NearestQuery);
  });

  it("throws on non-OK HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    await expect(
      loadTile("/base/", "en", entry, undefined, makeDeps()),
    ).rejects.toThrow("HTTP 500");
  });

  it("works without IDB", async () => {
    vi.mocked(deserializeBinary).mockReturnValueOnce({
      fd: fakeFd,
      articles: fakeArticles,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      }),
    );

    const result = await loadTile(
      "/base/",
      "en",
      entry,
      undefined,
      makeNullDeps(),
    );
    expect(result).toBeInstanceOf(NearestQuery);
  });

  it("falls through to network when IDB read throws", async () => {
    vi.mocked(deserializeBinary).mockReturnValueOnce({
      fd: fakeFd,
      articles: fakeArticles,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      }),
    );

    const deps = makeDeps();
    const originalGet = deps.getAny;
    deps.getAny = <T>(_db: IDBDatabase, key: string) => {
      if (key === "tile-v1-en-18-36")
        return Promise.reject(new Error("IDB read failed"));
      return originalGet<T>(_db, key);
    };
    const result = await loadTile("/base/", "en", entry, undefined, deps);
    expect(result).toBeInstanceOf(NearestQuery);
  });

  it("returns valid NearestQuery even when LRU bookkeeping throws", async () => {
    vi.mocked(deserializeBinary).mockReturnValueOnce({
      fd: fakeFd,
      articles: fakeArticles,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      }),
    );

    const deps = makeDeps();
    const originalGet = deps.getAny;
    deps.getAny = <T>(_db: IDBDatabase, key: string) => {
      if (key === "tile-lru-v1-en")
        return Promise.reject(new Error("IDB LRU read failed"));
      return originalGet<T>(_db, key);
    };
    const result = await loadTile("/base/", "en", entry, undefined, deps);
    expect(result).toBeInstanceOf(NearestQuery);
  });

  it("propagates error when response.arrayBuffer() rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () =>
          Promise.reject(new TypeError("network error during body read")),
      }),
    );

    await expect(
      loadTile("/base/", "en", entry, undefined, makeDeps()),
    ).rejects.toThrow("network error during body read");
  });

  it("falls through to network when cached.articles contains non-string elements", async () => {
    vi.mocked(deserializeBinary).mockReturnValueOnce({
      fd: fakeFd,
      articles: fakeArticles,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      }),
    );

    const corruptArticlesCache = {
      ...cachedTile,
      articles: [null, 42, {}],
    };
    const store = new Map<string, unknown>([
      ["tile-v1-en-18-36", corruptArticlesCache],
    ]);
    const result = await loadTile(
      "/base/",
      "en",
      entry,
      undefined,
      makeDeps(store),
    );
    expect(result).toBeInstanceOf(NearestQuery);
    // Confirm it fetched from network (cache was rejected)
    expect(fetch).toHaveBeenCalled();
  });

  it("falls through to network when cached data has matching hash but corrupt arrays", async () => {
    vi.mocked(deserializeBinary).mockReturnValueOnce({
      fd: fakeFd,
      articles: fakeArticles,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      }),
    );

    // Matching hash so the cache-hit branch is entered, but vertexTriangles
    // is null — NearestQuery constructor throws accessing null.length,
    // exercising the catch path that falls through to network fetch.
    const corruptCache = {
      ...cachedTile,
      vertexTriangles: null,
    };
    const store = new Map<string, unknown>([
      ["tile-v1-en-18-36", corruptCache],
    ]);
    const result = await loadTile(
      "/base/",
      "en",
      entry,
      undefined,
      makeDeps(store),
    );
    expect(result).toBeInstanceOf(NearestQuery);
  });

  it("propagates abort instead of returning stale cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")),
    );

    const controller = new AbortController();
    controller.abort();

    await expect(
      loadTile("/base/", "en", entry, controller.signal, makeNullDeps()),
    ).rejects.toThrow();
  });

  it("returns valid NearestQuery even when cache write fails", async () => {
    vi.mocked(deserializeBinary).mockReturnValueOnce({
      fd: fakeFd,
      articles: fakeArticles,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      }),
    );

    const deps = makeDeps();
    deps.putAny = () => Promise.reject(new Error("IDB quota exceeded"));
    const result = await loadTile("/base/", "en", entry, undefined, deps);
    expect(result).toBeInstanceOf(NearestQuery);
  });

  // ---------- touchLru integration ----------

  // Flush fire-and-forget microtasks spawned by touchLru
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("updates tile-lru key in IDB after loading a tile from network", async () => {
    vi.mocked(deserializeBinary).mockReturnValueOnce({
      fd: fakeFd,
      articles: fakeArticles,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      }),
    );

    const store = new Map<string, unknown>();
    await loadTile("/base/", "en", entry, undefined, makeDeps(store));
    await flush();

    const lru = store.get("tile-lru-v1-en") as string[];
    expect(lru).toContain("18-36");
  });

  it("deletes oldest tile cache key when LRU exceeds capacity", async () => {
    vi.mocked(deserializeBinary).mockReturnValueOnce({
      fd: fakeFd,
      articles: fakeArticles,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      }),
    );

    // Pre-populate LRU at capacity with MAX_CACHED_TILES entries
    const existingIds = Array.from(
      { length: MAX_CACHED_TILES },
      (_, i) => `old-${i}`,
    );
    const store = new Map<string, unknown>();
    store.set("tile-lru-v1-en", existingIds);
    // Add a cache entry for the tile that should be evicted (oldest)
    store.set("tile-v1-en-old-0", { fake: "data" });

    await loadTile("/base/", "en", entry, undefined, makeDeps(store));
    await flush();

    // Oldest tile (old-0) should be evicted from cache
    expect(store.has("tile-v1-en-old-0")).toBe(false);
    // LRU should contain the new tile at the end, still at capacity
    const lru = store.get("tile-lru-v1-en") as string[];
    expect(lru).toHaveLength(MAX_CACHED_TILES);
    expect(lru[lru.length - 1]).toBe("18-36");
    expect(lru).not.toContain("old-0");
  });

  it("updates LRU order on cache hit without eviction", async () => {
    // Pre-populate LRU with 18-36 not at the most-recent position
    const store = new Map<string, unknown>();
    store.set("tile-lru-v1-en", ["other-1", "18-36", "other-2"]);
    store.set("tile-v1-en-18-36", cachedTile);

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await loadTile("/base/", "en", entry, undefined, makeDeps(store));
    await flush();

    expect(fetchSpy).not.toHaveBeenCalled();
    // 18-36 should be moved to the most-recent (last) position
    const lru = store.get("tile-lru-v1-en") as string[];
    expect(lru).toEqual(["other-1", "other-2", "18-36"]);
  });

  it("proceeds with fresh LRU list when getAny rejects for LRU key", async () => {
    vi.mocked(deserializeBinary).mockReturnValueOnce({
      fd: fakeFd,
      articles: fakeArticles,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      }),
    );

    const store = new Map<string, unknown>();
    // Add a stale tile that would be evicted if LRU were full
    store.set("tile-v1-en-stale-0", { fake: "data" });

    const deps = makeDeps(store);
    const originalGet = deps.getAny;
    deps.getAny = <T>(_db: IDBDatabase, key: string) => {
      if (key === "tile-lru-v1-en")
        return Promise.reject(new Error("corrupted IDB entry"));
      return originalGet<T>(_db, key);
    };

    await loadTile("/base/", "en", entry, undefined, deps);
    await flush();

    // LRU write should still proceed with a fresh list containing the new tile
    const lru = store.get("tile-lru-v1-en") as string[];
    expect(lru).toEqual(["18-36"]);
  });

  it("defaults to fresh LRU when getAny resolves with a non-array value", async () => {
    vi.mocked(deserializeBinary).mockReturnValueOnce({
      fd: fakeFd,
      articles: fakeArticles,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      }),
    );

    // Simulate IDB corruption: LRU key holds a string instead of an array
    const store = new Map<string, unknown>();
    store.set("tile-lru-v1-en", "corrupted-string-value");

    const result = await loadTile(
      "/base/",
      "en",
      entry,
      undefined,
      makeDeps(store),
    );
    await flush();

    // Tile should load successfully despite corrupted LRU
    expect(result).toBeInstanceOf(NearestQuery);
    // LRU should be reset to a fresh list containing only the new tile
    const lru = store.get("tile-lru-v1-en") as string[];
    expect(lru).toEqual(["18-36"]);
  });

  it("serializes concurrent touchLru calls so both tiles appear in LRU", async () => {
    vi.mocked(deserializeBinary).mockReturnValue({
      fd: fakeFd,
      articles: fakeArticles,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      }),
    );

    const store = new Map<string, unknown>();
    store.set("tile-lru-v1-en", ["existing-1", "existing-2"]);
    const deps = makeDeps(store);
    const entryA: TileEntry = makeIndex(["10-20"]).tiles[0];
    const entryB: TileEntry = makeIndex(["11-21"]).tiles[0];

    // Fire both loads concurrently (simulates primary + adjacent)
    const [a, b] = await Promise.all([
      loadTile("/base/", "en", entryA, undefined, deps),
      loadTile("/base/", "en", entryB, undefined, deps),
    ]);
    await flush();

    expect(a).toBeInstanceOf(NearestQuery);
    expect(b).toBeInstanceOf(NearestQuery);

    const lru = store.get("tile-lru-v1-en") as string[];
    // Both tiles must be present — without serialization the second
    // write would clobber the first, losing one of them.
    expect(lru).toContain("10-20");
    expect(lru).toContain("11-21");
    expect(lru).toContain("existing-1");
    expect(lru).toContain("existing-2");
  });

  it("queues a successful touchLru after a prior LRU write failure for the same language", async () => {
    vi.mocked(deserializeBinary).mockReturnValue({
      fd: fakeFd,
      articles: fakeArticles,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      }),
    );

    const store = new Map<string, unknown>();
    const deps = makeDeps(store);
    const originalPut = deps.putAny;
    let lruPutCount = 0;
    deps.putAny = (_db: IDBDatabase, key: string, value: unknown) => {
      if (key === "tile-lru-v1-en") {
        lruPutCount++;
        if (lruPutCount === 1) {
          return Promise.reject(new Error("IDB write failed"));
        }
      }
      return originalPut(_db, key, value);
    };

    const entryA: TileEntry = makeIndex(["10-20"]).tiles[0];
    const entryB: TileEntry = makeIndex(["11-21"]).tiles[0];

    // First load: touchLru will fail at putAny for the LRU key
    await loadTile("/base/", "en", entryA, undefined, deps);
    await flush();

    // Second load: touchLru should succeed despite prior failure
    await loadTile("/base/", "en", entryB, undefined, deps);
    await flush();

    // The second touchLru reads the LRU (empty since first write failed),
    // adds its tile, and writes successfully
    const lru = store.get("tile-lru-v1-en") as string[];
    expect(lru).toContain("11-21");
  });

  it("keeps per-language LRU lists independent", async () => {
    vi.mocked(deserializeBinary).mockReturnValue({
      fd: fakeFd,
      articles: fakeArticles,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      }),
    );

    // Pre-populate 'de' LRU at capacity so the next load evicts the oldest
    const deIds = Array.from(
      { length: MAX_CACHED_TILES },
      (_, i) => `de-tile-${i}`,
    );
    const store = new Map<string, unknown>();
    store.set("tile-lru-v1-de", [...deIds]);
    store.set("tile-v1-de-de-tile-0", { fake: "data" });

    // Load a tile in 'en' — should NOT touch the 'de' LRU
    await loadTile("/base/", "en", entry, undefined, makeDeps(store));
    await flush();

    // 'en' LRU should contain only the loaded tile
    const enLru = store.get("tile-lru-v1-en") as string[];
    expect(enLru).toEqual(["18-36"]);

    // 'de' LRU should be completely untouched
    const deLru = store.get("tile-lru-v1-de") as string[];
    expect(deLru).toEqual(deIds);

    // 'de' cache entry should NOT have been evicted
    expect(store.has("tile-v1-de-de-tile-0")).toBe(true);
  });
});
