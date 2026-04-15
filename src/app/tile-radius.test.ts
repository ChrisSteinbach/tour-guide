import {
  tilesAtRing,
  tilesWithinRadius,
  createTileRadiusProvider,
  MAX_RING,
  MERGE_TAIL_SIZE,
} from "./tile-radius";
import type { TileEntry } from "../tiles";
import { tileId } from "../tiles";
import type { NearbyArticle } from "./types";

// ── Helper: build a tile map covering a region ────────────────

function buildTileMap(rows: number[], cols: number[]): Map<string, TileEntry> {
  const map = new Map<string, TileEntry>();
  for (const row of rows) {
    for (const col of cols) {
      const id = tileId(row, col);
      map.set(id, {
        id,
        row,
        col,
        south: row * 5 - 90,
        north: row * 5 - 90 + 5,
        west: col * 5 - 180,
        east: col * 5 - 180 + 5,
        articles: 10,
        bytes: 1000,
        hash: "abc",
      });
    }
  }
  return map;
}

describe("tilesAtRing", () => {
  const tileMap = buildTileMap([16, 17, 18, 19, 20], [34, 35, 36, 37, 38]);

  it("ring 0 returns only the center tile", () => {
    const tiles = tilesAtRing(18, 36, 0, tileMap);
    expect(tiles).toEqual([tileId(18, 36)]);
  });

  it("ring 1 returns the 8 surrounding tiles", () => {
    const tiles = tilesAtRing(18, 36, 1, tileMap);
    expect(tiles.length).toBe(8);
    expect(tiles).toContain(tileId(17, 35));
    expect(tiles).toContain(tileId(17, 36));
    expect(tiles).toContain(tileId(17, 37));
    expect(tiles).toContain(tileId(18, 35));
    expect(tiles).toContain(tileId(18, 37));
    expect(tiles).toContain(tileId(19, 35));
    expect(tiles).toContain(tileId(19, 36));
    expect(tiles).toContain(tileId(19, 37));
    expect(tiles).not.toContain(tileId(18, 36)); // center excluded
  });

  it("ring 2 returns the 16 tiles in the outer ring", () => {
    const tiles = tilesAtRing(18, 36, 2, tileMap);
    expect(tiles.length).toBe(16);
    expect(tiles).toContain(tileId(16, 34));
    expect(tiles).toContain(tileId(20, 38));
  });

  it("excludes tiles not in the tile map", () => {
    const smallMap = buildTileMap([18, 19], [36, 37]);
    const tiles = tilesAtRing(18, 36, 1, smallMap);
    // Only tiles that exist in the map (3 of 8 ring-1 neighbors)
    expect(tiles.sort()).toEqual(
      [tileId(18, 37), tileId(19, 36), tileId(19, 37)].sort(),
    );
  });

  it("wraps longitude at map boundaries", () => {
    const wrapMap = buildTileMap([18], [0, 1, 71]);
    const tiles = tilesAtRing(18, 0, 1, wrapMap);
    expect(tiles).toContain(tileId(18, 71)); // wrapped west
    expect(tiles).toContain(tileId(18, 1)); // east neighbor
  });

  it("clamps latitude at poles", () => {
    const poleMap = buildTileMap([0, 1], [36]);
    const tiles = tilesAtRing(0, 36, 1, poleMap);
    // row -1 doesn't exist; only row 1 should appear
    expect(tiles).toContain(tileId(1, 36));
    expect(tiles.every((id) => !id.startsWith("-"))).toBe(true);
  });
});

describe("tilesWithinRadius", () => {
  const tileMap = buildTileMap([16, 17, 18, 19, 20], [34, 35, 36, 37, 38]);

  it("radius 0 returns the center tile", () => {
    const tiles = tilesWithinRadius(18, 36, 0, tileMap);
    expect(tiles).toEqual([tileId(18, 36)]);
  });

  it("radius 1 returns center + ring 1 (up to 9 tiles)", () => {
    const tiles = tilesWithinRadius(18, 36, 1, tileMap);
    expect(tiles.length).toBe(9);
    expect(tiles).toContain(tileId(18, 36));
    expect(tiles).toContain(tileId(17, 35));
  });
});

describe("createTileRadiusProvider", () => {
  it("provides articles sorted by distance from loaded tiles", async () => {
    const articles: NearbyArticle[] = [
      { title: "Near", lat: 0, lon: 0, distanceM: 100 },
      { title: "Far", lat: 1, lon: 1, distanceM: 5000 },
      { title: "Mid", lat: 0.5, lon: 0.5, distanceM: 2000 },
    ];

    const provider = createTileRadiusProvider({
      queryTiles: async () => articles,
      loadRing: async () => ["ring0"],
      centerRow: 18,
      centerCol: 36,
    });

    const result = await provider.fetchRange(0, 3);

    expect(result.articles.map((a) => a.title)).toEqual(["Near", "Mid", "Far"]);
    expect(result.totalAvailable).toBe(3);
  });

  it("expands rings until enough articles are available", async () => {
    let ringsLoaded = 0;

    const provider = createTileRadiusProvider({
      queryTiles: async () => {
        // Each ring adds 5 NEW articles
        return Array.from({ length: 5 }, (_, i) => ({
          title: `Ring${ringsLoaded}-Article${i}`,
          lat: 0,
          lon: 0,
          distanceM: (ringsLoaded - 1) * 500 + i * 100,
        }));
      },
      loadRing: async () => {
        ringsLoaded++;
        return [`ring-${ringsLoaded}`];
      },
      centerRow: 18,
      centerCol: 36,
    });

    const result = await provider.fetchRange(0, 12);

    // Should have loaded 3 rings (5, 10, 15 articles cumulative)
    expect(ringsLoaded).toBe(3);
    expect(result.articles.length).toBe(12);
  });

  it("continues past empty rings to find articles in later rings", async () => {
    let lastRing = -1;

    const provider = createTileRadiusProvider({
      queryTiles: async () => {
        return [{ title: "Coastal", lat: 0, lon: 0, distanceM: 8000 }];
      },
      loadRing: async (ring) => {
        lastRing = ring;
        // Rings 0–2 have no tiles, ring 3 has one
        return ring >= 3 ? ["tile-3"] : [];
      },
      centerRow: 18,
      centerCol: 36,
    });

    const result = await provider.fetchRange(0, 1);

    expect(lastRing).toBe(3); // expanded through rings 0, 1, 2, 3
    expect(result.articles).toEqual([
      { title: "Coastal", lat: 0, lon: 0, distanceM: 8000 },
    ]);
  });

  it("stops expanding at MAX_RING when grid is exhausted", async () => {
    let lastRing = -1;

    const provider = createTileRadiusProvider({
      queryTiles: async () => [],
      loadRing: async (ring) => {
        lastRing = ring;
        return []; // no tiles anywhere
      },
      centerRow: 18,
      centerCol: 36,
    });

    const result = await provider.fetchRange(0, 10);

    expect(lastRing).toBe(MAX_RING);
    expect(result.articles).toEqual([]);
  });

  it("returns partial results sorted by distance when grid exhausts before satisfying range", async () => {
    const sparseArticles: NearbyArticle[] = [
      { title: "Lighthouse", lat: 1, lon: 1, distanceM: 9000 },
      { title: "Reef", lat: 0.5, lon: 0.5, distanceM: 3000 },
      { title: "Buoy", lat: 0.2, lon: 0.2, distanceM: 500 },
    ];
    let lastRing = -1;

    const provider = createTileRadiusProvider({
      queryTiles: async () => sparseArticles,
      loadRing: async (ring) => {
        lastRing = ring;
        return ring === 0 ? ["tile-0"] : []; // only ring 0 has tiles
      },
      centerRow: 18,
      centerCol: 36,
    });

    const result = await provider.fetchRange(0, 10);

    expect(lastRing).toBe(MAX_RING);
    expect(result.articles).toEqual([
      { title: "Buoy", lat: 0.2, lon: 0.2, distanceM: 500 },
      { title: "Reef", lat: 0.5, lon: 0.5, distanceM: 3000 },
      { title: "Lighthouse", lat: 1, lon: 1, distanceM: 9000 },
    ]);
    expect(result.totalAvailable).toBe(3);
  });

  it("does not re-load rings already loaded by a previous call", async () => {
    const ringsLoaded: number[] = [];
    let ringCount = 0;

    const provider = createTileRadiusProvider({
      queryTiles: async () => {
        // Each call returns 5 new articles
        return Array.from({ length: 5 }, (_, i) => ({
          title: `Batch${ringCount}-Art${i}`,
          lat: 0,
          lon: 0,
          distanceM: (ringCount - 1) * 500 + i * 100,
        }));
      },
      loadRing: async (ring) => {
        ringsLoaded.push(ring);
        ringCount++;
        return [`ring-${ring}`];
      },
      centerRow: 18,
      centerCol: 36,
    });

    // First call: needs 12 articles → loads rings 0, 1, 2 (5, 10, 15 articles)
    await provider.fetchRange(0, 12);
    expect(ringsLoaded).toEqual([0, 1, 2]);

    // Second call: needs 20 articles → should continue from ring 3, not re-load 0-2
    await provider.fetchRange(0, 20);
    expect(ringsLoaded).toEqual([0, 1, 2, 3]);
  });

  it("returns the correct slice for a non-zero start parameter", async () => {
    const articles: NearbyArticle[] = [
      { title: "A", lat: 0, lon: 0, distanceM: 100 },
      { title: "B", lat: 0, lon: 0, distanceM: 200 },
      { title: "C", lat: 0, lon: 0, distanceM: 300 },
      { title: "D", lat: 0, lon: 0, distanceM: 400 },
      { title: "E", lat: 0, lon: 0, distanceM: 500 },
    ];

    const provider = createTileRadiusProvider({
      queryTiles: async () => articles,
      loadRing: async () => ["ring-0"],
      centerRow: 18,
      centerCol: 36,
    });

    const result = await provider.fetchRange(2, 4);

    expect(result.articles.map((a) => a.title)).toEqual(["C", "D"]);
    expect(result.totalAvailable).toBe(5);
  });

  // ── Incremental / resumable behavior ──────────────────────────

  it("deduplicates articles across rings by title", async () => {
    let ringNum = -1;

    const provider = createTileRadiusProvider({
      queryTiles: async () => {
        if (ringNum === 0) {
          return [
            { title: "Shared", lat: 0, lon: 0, distanceM: 100 },
            { title: "Ring0Only", lat: 0, lon: 0, distanceM: 200 },
          ];
        }
        // Ring 1 returns "Shared" again (cross-tile duplicate) plus a new one
        return [
          { title: "Shared", lat: 0, lon: 0, distanceM: 100 },
          { title: "Ring1Only", lat: 0, lon: 0, distanceM: 150 },
        ];
      },
      loadRing: async (ring) => {
        ringNum = ring;
        return [`tile-${ring}`];
      },
      centerRow: 18,
      centerCol: 36,
    });

    const result = await provider.fetchRange(0, 10);

    const titles = result.articles.map((a) => a.title);
    expect(titles).toEqual(["Shared", "Ring1Only", "Ring0Only"]);
    expect(result.totalAvailable).toBe(3);
  });

  it("maintains correct distance ordering across ring boundaries", async () => {
    let ringNum = -1;

    const provider = createTileRadiusProvider({
      queryTiles: async () => {
        if (ringNum === 0) {
          return [
            { title: "A", lat: 0, lon: 0, distanceM: 100 },
            { title: "C", lat: 0, lon: 0, distanceM: 300 },
            { title: "E", lat: 0, lon: 0, distanceM: 500 },
          ];
        }
        // Ring 1 articles interleave with ring 0
        return [
          { title: "B", lat: 0, lon: 0, distanceM: 200 },
          { title: "D", lat: 0, lon: 0, distanceM: 400 },
        ];
      },
      loadRing: async (ring) => {
        ringNum = ring;
        return [`tile-${ring}`];
      },
      centerRow: 18,
      centerCol: 36,
    });

    const result = await provider.fetchRange(0, 10);

    expect(result.articles.map((a) => a.title)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
    ]);
  });

  it("does not re-query tiles when range is already satisfied", async () => {
    let queryCalls = 0;

    const provider = createTileRadiusProvider({
      queryTiles: async () => {
        queryCalls++;
        return Array.from({ length: 20 }, (_, i) => ({
          title: `Art-${i}`,
          lat: 0,
          lon: 0,
          distanceM: i * 100,
        }));
      },
      loadRing: async () => ["ring-0"],
      centerRow: 18,
      centerCol: 36,
    });

    await provider.fetchRange(0, 10);
    expect(queryCalls).toBe(1);

    // Second call with a smaller range — should use cached articles
    await provider.fetchRange(0, 5);
    expect(queryCalls).toBe(1);
  });

  it("passes only newly loaded tile IDs to queryTiles", async () => {
    const queriedIds: string[][] = [];

    const provider = createTileRadiusProvider({
      queryTiles: async (tileIds) => {
        queriedIds.push([...tileIds]);
        return tileIds.map((id, i) => ({
          title: `${id}-art-${i}`,
          lat: 0,
          lon: 0,
          distanceM: queriedIds.length * 1000 + i * 100,
        }));
      },
      loadRing: async (ring) => {
        return [`tile-r${ring}-a`, `tile-r${ring}-b`];
      },
      centerRow: 18,
      centerCol: 36,
    });

    // First fetch — needs to expand rings 0 and 1 (2 articles per ring isn't enough for 5)
    await provider.fetchRange(0, 5);

    // Ring 0 tiles queried, then ring 1 tiles queried — each call gets only that ring's tiles
    expect(queriedIds[0]).toEqual(["tile-r0-a", "tile-r0-b"]);
    expect(queriedIds[1]).toEqual(["tile-r1-a", "tile-r1-b"]);
  });

  it("merge-tail keeps finalized prefix stable while re-sorting the tail with new-ring articles", async () => {
    // Ring 0 returns 600 articles (exceeds MERGE_TAIL_SIZE = 500).
    // Ring 1 returns articles whose distances interleave with the tail portion.
    // The first 100 articles (finalized prefix) must remain in their original
    // distance order, while the tail (last 500) gets re-sorted with ring 1's articles.

    const ring0Count = MERGE_TAIL_SIZE + 100; // 600
    let ringNum = -1;

    const provider = createTileRadiusProvider({
      queryTiles: async () => {
        if (ringNum === 0) {
          // 600 articles at distances 10, 20, 30, ... 6000
          return Array.from({ length: ring0Count }, (_, i) => ({
            title: `R0-${i}`,
            lat: 0,
            lon: 0,
            distanceM: (i + 1) * 10,
          }));
        }
        // Ring 1: 5 articles whose distances interleave with the tail
        // (the tail spans distances 1010..6000). Place these at 1015, 2025,
        // 3035, 4045, 5055 — between existing tail articles.
        return [
          { title: "R1-A", lat: 0, lon: 0, distanceM: 1015 },
          { title: "R1-B", lat: 0, lon: 0, distanceM: 2025 },
          { title: "R1-C", lat: 0, lon: 0, distanceM: 3035 },
          { title: "R1-D", lat: 0, lon: 0, distanceM: 4045 },
          { title: "R1-E", lat: 0, lon: 0, distanceM: 5055 },
        ];
      },
      loadRing: async (ring) => {
        ringNum = ring;
        return [`tile-${ring}`];
      },
      centerRow: 18,
      centerCol: 36,
    });

    // Request enough to trigger ring 0 + ring 1 loading
    const result = await provider.fetchRange(0, ring0Count + 5);

    const articles = result.articles;
    const totalExpected = ring0Count + 5; // 605 (600 from ring 0 + 5 from ring 1)
    expect(result.totalAvailable).toBe(totalExpected);
    expect(articles.length).toBe(totalExpected);

    // The finalized prefix (first 100 articles) must be the original ring-0
    // articles at distances 10, 20, ... 1000 in exact order.
    const prefixEnd = ring0Count - MERGE_TAIL_SIZE; // 100
    const prefix = articles.slice(0, prefixEnd);
    for (let i = 0; i < prefixEnd; i++) {
      expect(prefix[i].title).toBe(`R0-${i}`);
      expect(prefix[i].distanceM).toBe((i + 1) * 10);
    }

    // The tail portion (after the prefix) must be in distance order,
    // with ring-1 articles correctly interleaved among ring-0 tail articles.
    const tail = articles.slice(prefixEnd);
    for (let i = 1; i < tail.length; i++) {
      expect(tail[i].distanceM).toBeGreaterThanOrEqual(tail[i - 1].distanceM);
    }

    // Verify ring-1 articles are present in the tail
    const tailTitles = new Set(tail.map((a) => a.title));
    expect(tailTitles.has("R1-A")).toBe(true);
    expect(tailTitles.has("R1-B")).toBe(true);
    expect(tailTitles.has("R1-C")).toBe(true);
    expect(tailTitles.has("R1-D")).toBe(true);
    expect(tailTitles.has("R1-E")).toBe(true);
  });

  it("preserves global sort order when a new-ring article is closer than the finalized prefix's last entry", async () => {
    // Ring 0 returns 600 articles at distances 10, 20, ..., 6000.
    // With MERGE_TAIL_SIZE = 500, tailStart = 100 and the finalized prefix
    // ends at distance 1000. Ring 1 returns an article at distance 985 —
    // strictly INSIDE the finalized prefix's range. A naive merge-tail would
    // place 985 into the sorted tail but leave it after the prefix's 1000,
    // breaking global ordering. The merge must widen the tail (or otherwise
    // handle the case) so the final array is globally sorted.
    const ring0Count = MERGE_TAIL_SIZE + 100; // 600
    let ringNum = -1;

    const provider = createTileRadiusProvider({
      queryTiles: async () => {
        if (ringNum === 0) {
          return Array.from({ length: ring0Count }, (_, i) => ({
            title: `R0-${i}`,
            lat: 0,
            lon: 0,
            distanceM: (i + 1) * 10,
          }));
        }
        return [{ title: "R1-Closer", lat: 0, lon: 0, distanceM: 985 }];
      },
      loadRing: async (ring) => {
        ringNum = ring;
        return [`tile-${ring}`];
      },
      centerRow: 18,
      centerCol: 36,
    });

    const result = await provider.fetchRange(0, ring0Count + 1);
    const articles = result.articles;

    expect(articles.length).toBe(ring0Count + 1);

    // Global sort invariant: every adjacent pair must be non-decreasing.
    for (let i = 1; i < articles.length; i++) {
      expect(articles[i].distanceM).toBeGreaterThanOrEqual(
        articles[i - 1].distanceM,
      );
    }

    // R1-Closer (985) should land between R0-97 (980) and R0-98 (990).
    const idx = articles.findIndex((a) => a.title === "R1-Closer");
    expect(idx).toBe(98);
    expect(articles[idx - 1].title).toBe("R0-97");
    expect(articles[idx + 1].title).toBe("R0-98");
  });
});
