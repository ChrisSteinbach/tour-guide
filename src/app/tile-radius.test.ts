import { tilesAtRing, tilesWithinRadius } from "./tile-radius";
import type { TileEntry } from "../tiles";
import { tileId } from "../tiles";

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
