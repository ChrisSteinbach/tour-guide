import {
  tilesAtRing,
  tilesWithinRadius,
  createTileRadiusProvider,
  MAX_RING,
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
      queryAllTiles: async () => articles,
      loadRing: async () => true,
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
      queryAllTiles: async () => {
        // Each ring adds 5 articles
        return Array.from({ length: ringsLoaded * 5 }, (_, i) => ({
          title: `Article ${i}`,
          lat: 0,
          lon: 0,
          distanceM: i * 100,
        }));
      },
      loadRing: async () => {
        ringsLoaded++;
        return true; // new tiles were loaded
      },
      centerRow: 18,
      centerCol: 36,
    });

    const result = await provider.fetchRange(0, 12);

    // Should have loaded 3 rings (5, 10, 15 articles)
    expect(ringsLoaded).toBe(3);
    expect(result.articles.length).toBe(12);
  });

  it("continues past empty rings to find articles in later rings", async () => {
    let lastRing = -1;

    const provider = createTileRadiusProvider({
      queryAllTiles: async () => {
        // No articles until ring 3 is loaded
        if (lastRing < 3) return [];
        return [{ title: "Coastal", lat: 0, lon: 0, distanceM: 8000 }];
      },
      loadRing: async (ring) => {
        lastRing = ring;
        return ring >= 3; // rings 0–2 are empty ocean, ring 3 has tiles
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
      queryAllTiles: async () => [],
      loadRing: async (ring) => {
        lastRing = ring;
        return false; // no tiles anywhere
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
      queryAllTiles: async () => sparseArticles,
      loadRing: async (ring) => {
        lastRing = ring;
        return ring === 0; // only ring 0 has tiles
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

    const provider = createTileRadiusProvider({
      queryAllTiles: async () => {
        // Each ring adds 5 articles
        return Array.from({ length: ringsLoaded.length * 5 }, (_, i) => ({
          title: `Article ${i}`,
          lat: 0,
          lon: 0,
          distanceM: i * 100,
        }));
      },
      loadRing: async (ring) => {
        ringsLoaded.push(ring);
        return true;
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
      queryAllTiles: async () => articles,
      loadRing: async () => true,
      centerRow: 18,
      centerCol: 36,
    });

    const result = await provider.fetchRange(2, 4);

    expect(result.articles.map((a) => a.title)).toEqual(["C", "D"]);
    expect(result.totalAvailable).toBe(5);
  });
});
