import {
  findNearestTiled,
  tilesForPosition,
  tileExistsInIndex,
  getTileEntry,
  updateLru,
  MAX_CACHED_TILES,
  loadTileIndex,
} from "./tile-loader";
import { NearestQuery, toFlatDelaunay } from "./query";
import type { TileIndex, TileEntry } from "../tiles";
import { GRID_DEG } from "../tiles";
import {
  toCartesian,
  convexHull,
  buildTriangulation,
  serialize,
} from "../geometry";
import type { ArticleMeta } from "../geometry";

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
function makeIndex(tileIds: string[]): TileIndex {
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
        hash: "abcd1234",
      } satisfies TileEntry;
    }),
  };
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
    expect(results[0].title).toBeDefined();
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
    const index = makeIndex(["18-36"]);

    const { primary, adjacent } = tilesForPosition(index, 2.5, 2.5);
    expect(primary).toBe("18-36");
    expect(adjacent).toEqual([]);
  });

  it("includes adjacent tiles when near south edge", () => {
    const index = makeIndex(["18-36", "17-36"]);

    const { primary, adjacent } = tilesForPosition(index, 0.5, 2.5);
    expect(primary).toBe("18-36");
    expect(adjacent).toContain("17-36");
  });

  it("includes adjacent tiles when near north edge", () => {
    const index = makeIndex(["18-36", "19-36"]);

    const { primary, adjacent } = tilesForPosition(index, 4.5, 2.5);
    expect(primary).toBe("18-36");
    expect(adjacent).toContain("19-36");
  });

  it("includes adjacent tiles when near west edge", () => {
    const index = makeIndex(["18-36", "18-35"]);

    const { primary, adjacent } = tilesForPosition(index, 2.5, 0.5);
    expect(primary).toBe("18-36");
    expect(adjacent).toContain("18-35");
  });

  it("includes corner tiles when near corner", () => {
    const index = makeIndex(["18-36", "17-36", "18-35", "17-35"]);

    const { primary, adjacent } = tilesForPosition(index, 0.5, 0.5);
    expect(primary).toBe("18-36");
    expect(adjacent).toContain("17-36");
    expect(adjacent).toContain("18-35");
    expect(adjacent).toContain("17-35");
  });

  it("wraps longitude at date line (east)", () => {
    const index = makeIndex(["18-71", "18-00"]);

    const { primary, adjacent } = tilesForPosition(index, 2.5, 179.5);
    expect(primary).toBe("18-71");
    expect(adjacent).toContain("18-00");
  });

  it("wraps longitude at date line (west)", () => {
    const index = makeIndex(["18-00", "18-71"]);

    const { primary, adjacent } = tilesForPosition(index, 2.5, -179.5);
    expect(primary).toBe("18-00");
    expect(adjacent).toContain("18-71");
  });

  it("clamps latitude (no adjacent south below row 0)", () => {
    const index = makeIndex(["00-36"]);

    const { primary, adjacent } = tilesForPosition(index, -89.5, 2.5);
    expect(primary).toBe("00-36");
    expect(adjacent).toEqual([]);
  });

  it("clamps latitude (no adjacent north above max row)", () => {
    const index = makeIndex(["35-36"]);

    const { primary, adjacent } = tilesForPosition(index, 89.5, 2.5);
    expect(primary).toBe("35-36");
    expect(adjacent).toEqual([]);
  });

  it("excludes adjacent tiles not present in the index", () => {
    const index = makeIndex(["18-36"]);

    const { primary, adjacent } = tilesForPosition(index, 0.5, 2.5);
    expect(primary).toBe("18-36");
    expect(adjacent).toEqual([]);
  });
});

// ---------- Tile index helpers ----------

describe("tileExistsInIndex", () => {
  it("returns true for tiles in the index", () => {
    const index = makeIndex(["18-36", "18-37"]);
    expect(tileExistsInIndex(index, "18-36")).toBe(true);
  });

  it("returns false for tiles not in the index", () => {
    const index = makeIndex(["18-36"]);
    expect(tileExistsInIndex(index, "99-99")).toBe(false);
  });
});

describe("getTileEntry", () => {
  it("returns entry when tile exists", () => {
    const index = makeIndex(["18-36"]);
    expect(getTileEntry(index, "18-36")?.id).toBe("18-36");
  });

  it("returns undefined when tile does not exist", () => {
    const index = makeIndex(["18-36"]);
    expect(getTileEntry(index, "99-99")).toBeUndefined();
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

// ---------- loadTileIndex abort vs network error ----------

describe("loadTileIndex", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("propagates abort instead of falling back to null", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new DOMException("aborted", "AbortError"));

    const controller = new AbortController();
    controller.abort();

    await expect(
      loadTileIndex("/base/", "en", controller.signal),
    ).rejects.toThrow();
  });

  it("returns null on network error (graceful fallback)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    const result = await loadTileIndex("/base/", "en");
    expect(result).toBeNull();
  });
});
