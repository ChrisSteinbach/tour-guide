import { TiledQuery } from "./tile-loader";
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

// ---------- TiledQuery.findNearest ----------

describe("TiledQuery.findNearest", () => {
  it("returns results from a single tile", () => {
    const index = makeIndex(["18-36"]);
    const tq = new TiledQuery(index);

    const q = buildQuery(GLOBAL_ARTICLES);
    tq.addTile("18-36", q);

    const results = tq.findNearest(0, 0, 3);
    expect(results.length).toBe(3);
    expect(results[0].title).toBeDefined();
    // Results should be sorted by distance
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distanceM).toBeGreaterThanOrEqual(
        results[i - 1].distanceM,
      );
    }
  });

  it("de-duplicates articles across tiles by title", () => {
    const index = makeIndex(["18-36", "18-37"]);
    const tq = new TiledQuery(index);

    // Both tiles contain the same global articles (simulating buffer overlap)
    const q1 = buildQuery(GLOBAL_ARTICLES);
    const q2 = buildQuery(GLOBAL_ARTICLES);
    tq.addTile("18-36", q1);
    tq.addTile("18-37", q2);

    const results = tq.findNearest(0, 0, 6);
    const titles = results.map((r) => r.title);
    // No duplicates
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("returns empty array when no tiles loaded", () => {
    const index = makeIndex(["18-36"]);
    const tq = new TiledQuery(index);

    const results = tq.findNearest(0, 0, 5);
    expect(results).toEqual([]);
  });
});

// ---------- TiledQuery.tilesForPosition ----------

describe("TiledQuery.tilesForPosition", () => {
  it("returns only primary when position is in center of tile", () => {
    // Center of tile 18-36 (lat=0-5, lon=0-5) → center ≈ 2.5, 2.5
    const index = makeIndex(["18-36"]);
    const tq = new TiledQuery(index);

    const { primary, adjacent } = tq.tilesForPosition(2.5, 2.5);
    expect(primary).toBe("18-36");
    expect(adjacent).toEqual([]);
  });

  it("includes adjacent tiles when near south edge", () => {
    // Tile 18-36: south=0, north=5. Position at lat=0.5 is 0.5° from south edge
    const index = makeIndex(["18-36", "17-36"]);
    const tq = new TiledQuery(index);

    const { primary, adjacent } = tq.tilesForPosition(0.5, 2.5);
    expect(primary).toBe("18-36");
    expect(adjacent).toContain("17-36");
  });

  it("includes adjacent tiles when near north edge", () => {
    // Tile 18-36: north=5. Position at lat=4.5 is 0.5° from north edge
    const index = makeIndex(["18-36", "19-36"]);
    const tq = new TiledQuery(index);

    const { primary, adjacent } = tq.tilesForPosition(4.5, 2.5);
    expect(primary).toBe("18-36");
    expect(adjacent).toContain("19-36");
  });

  it("includes adjacent tiles when near west edge", () => {
    // Tile 18-36: west=0. Position at lon=0.5 is 0.5° from west edge
    const index = makeIndex(["18-36", "18-35"]);
    const tq = new TiledQuery(index);

    const { primary, adjacent } = tq.tilesForPosition(2.5, 0.5);
    expect(primary).toBe("18-36");
    expect(adjacent).toContain("18-35");
  });

  it("includes corner tiles when near corner", () => {
    // Near south-west corner of tile 18-36: lat=0.5, lon=0.5
    const index = makeIndex(["18-36", "17-36", "18-35", "17-35"]);
    const tq = new TiledQuery(index);

    const { primary, adjacent } = tq.tilesForPosition(0.5, 0.5);
    expect(primary).toBe("18-36");
    expect(adjacent).toContain("17-36"); // south
    expect(adjacent).toContain("18-35"); // west
    expect(adjacent).toContain("17-35"); // south-west corner
  });

  it("wraps longitude at date line (east)", () => {
    // Tile at col=71 (east=180). Position near east edge should wrap to col=0
    const index = makeIndex(["18-71", "18-00"]);
    const tq = new TiledQuery(index);

    // Tile 18-71: west=175, east=180. Position at lon=179.5 → near east edge
    const { primary, adjacent } = tq.tilesForPosition(2.5, 179.5);
    expect(primary).toBe("18-71");
    expect(adjacent).toContain("18-00");
  });

  it("wraps longitude at date line (west)", () => {
    // Tile at col=0 (west=-180). Position near west edge should wrap to col=71
    const index = makeIndex(["18-00", "18-71"]);
    const tq = new TiledQuery(index);

    // Tile 18-00: west=-180, east=-175. Position at lon=-179.5 → near west edge
    const { primary, adjacent } = tq.tilesForPosition(2.5, -179.5);
    expect(primary).toBe("18-00");
    expect(adjacent).toContain("18-71");
  });

  it("clamps latitude (no adjacent south below row 0)", () => {
    // Row 0: south=-90. Position near south edge has no row below
    const index = makeIndex(["00-36"]);
    const tq = new TiledQuery(index);

    const { primary, adjacent } = tq.tilesForPosition(-89.5, 2.5);
    expect(primary).toBe("00-36");
    // No south neighbor (row -1 doesn't exist)
    expect(adjacent).toEqual([]);
  });

  it("clamps latitude (no adjacent north above max row)", () => {
    // Row 35: north=90. Position near north edge has no row above
    const index = makeIndex(["35-36"]);
    const tq = new TiledQuery(index);

    const { primary, adjacent } = tq.tilesForPosition(89.5, 2.5);
    expect(primary).toBe("35-36");
    expect(adjacent).toEqual([]);
  });

  it("excludes adjacent tiles not present in the index", () => {
    // Near south edge but south tile doesn't exist in index
    const index = makeIndex(["18-36"]);
    const tq = new TiledQuery(index);

    const { primary, adjacent } = tq.tilesForPosition(0.5, 2.5);
    expect(primary).toBe("18-36");
    // 17-36 would be adjacent but isn't in the index
    expect(adjacent).toEqual([]);
  });
});

// ---------- TiledQuery metadata ----------

describe("TiledQuery metadata", () => {
  it("reports size from index", () => {
    const index = makeIndex(["18-36", "18-37", "19-36"]);
    const tq = new TiledQuery(index);
    expect(tq.size).toBe(3);
  });

  it("reports loaded tile count", () => {
    const index = makeIndex(["18-36", "18-37"]);
    const tq = new TiledQuery(index);
    expect(tq.loadedTileCount).toBe(0);

    tq.addTile("18-36", buildQuery(GLOBAL_ARTICLES));
    expect(tq.loadedTileCount).toBe(1);
  });

  it("hasTile returns correct state", () => {
    const index = makeIndex(["18-36"]);
    const tq = new TiledQuery(index);
    expect(tq.hasTile("18-36")).toBe(false);

    tq.addTile("18-36", buildQuery(GLOBAL_ARTICLES));
    expect(tq.hasTile("18-36")).toBe(true);
  });

  it("tileExists checks the index", () => {
    const index = makeIndex(["18-36", "18-37"]);
    const tq = new TiledQuery(index);
    expect(tq.tileExists("18-36")).toBe(true);
    expect(tq.tileExists("99-99")).toBe(false);
  });

  it("getTileEntry returns entry or undefined", () => {
    const index = makeIndex(["18-36"]);
    const tq = new TiledQuery(index);
    expect(tq.getTileEntry("18-36")?.id).toBe("18-36");
    expect(tq.getTileEntry("99-99")).toBeUndefined();
  });
});
