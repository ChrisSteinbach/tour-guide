import { createArticleWindowFactory } from "./article-window-factory";
import type { ArticleWindowFactoryDeps } from "./article-window-factory";
import type { NearestQuery } from "./query";
import type { TileEntry } from "../tiles";
import type { NearbyArticle } from "./types";

function makeEntry(id: string): TileEntry {
  return {
    id,
    row: 0,
    col: 0,
    south: 0,
    north: 5,
    west: 0,
    east: 5,
    articles: 1,
    bytes: 100,
    hash: "abc",
  };
}

/** Minimal stub that satisfies the NearestQuery class shape for test purposes. */
function fakeQuery(): NearestQuery {
  return { nearest: () => [] } as unknown as NearestQuery;
}

function makeDeps(
  overrides: Partial<ArticleWindowFactoryDeps> = {},
): ArticleWindowFactoryDeps {
  return {
    position: { lat: 1, lon: 2 },
    tileMap: new Map([["t0", makeEntry("t0")]]),
    lang: "en",
    signal: new AbortController().signal,
    getStateMachineTiles: () => new Map(),
    loadTile: vi.fn(async () => fakeQuery()),
    getTileEntry: vi.fn((_map, id) => _map.get(id) as TileEntry | undefined),
    findNearestTiled: vi.fn(
      (
        _tiles: ReadonlyMap<string, NearestQuery>,
        _lat: number,
        _lon: number,
        _count: number,
      ) => [] as NearbyArticle[],
    ),
    tilesAtRing: vi.fn(() => []),
    tileFor: vi.fn(() => ({ row: 0, col: 0 })),
    ...overrides,
  };
}

describe("createArticleWindowFactory", () => {
  it("merges state machine tiles and provider tiles in queries", async () => {
    const smTile = fakeQuery();
    const providerTile = fakeQuery();

    const smTiles = new Map<string, NearestQuery>([["sm-t0", smTile]]);
    const tileMap = new Map<string, TileEntry>([
      ["ring-t1", makeEntry("ring-t1")],
    ]);

    const allTilesSeen: Map<string, NearestQuery>[] = [];

    const deps = makeDeps({
      tileMap,
      getStateMachineTiles: () => smTiles,
      tilesAtRing: vi.fn((_row, _col, ring) => {
        if (ring === 0) return ["ring-t1"];
        return [];
      }),
      loadTile: vi.fn(async () => providerTile),
      getTileEntry: vi.fn((_map, id) => makeEntry(id)),
      findNearestTiled: vi.fn((tiles: ReadonlyMap<string, NearestQuery>) => {
        allTilesSeen.push(new Map(tiles));
        return [];
      }),
    });

    const { articleWindow } = createArticleWindowFactory(deps);
    await articleWindow.ensureRange(0, 10);

    // After loading ring-t1, findNearestTiled should see both sm-t0 and ring-t1
    const lastSeen = allTilesSeen[allTilesSeen.length - 1];
    expect(lastSeen.has("sm-t0")).toBe(true);
    expect(lastSeen.has("ring-t1")).toBe(true);
  });

  it("stops loading tiles when signal is aborted", async () => {
    const ac = new AbortController();
    const tileMap = new Map<string, TileEntry>([
      ["t0", makeEntry("t0")],
      ["t1", makeEntry("t1")],
    ]);

    let loadCount = 0;
    const deps = makeDeps({
      tileMap,
      signal: ac.signal,
      tilesAtRing: vi.fn((_row, _col, ring) =>
        ring === 0 ? ["t0", "t1"] : [],
      ),
      getTileEntry: vi.fn((_map, id) => makeEntry(id)),
      loadTile: vi.fn(async () => {
        loadCount++;
        // Abort after first tile load
        ac.abort();
        return fakeQuery();
      }),
    });

    const { articleWindow } = createArticleWindowFactory(deps);
    await articleWindow.ensureRange(0, 10);

    // Only the first tile should have been loaded before abort stopped the loop
    expect(loadCount).toBe(1);
  });

  it("skips tiles already in state machine or provider map", async () => {
    const existingTile = fakeQuery();
    const smTiles = new Map<string, NearestQuery>([["sm-tile", existingTile]]);
    const tileMap = new Map<string, TileEntry>([
      ["sm-tile", makeEntry("sm-tile")],
      ["new-tile", makeEntry("new-tile")],
    ]);

    const loadedIds: string[] = [];

    const deps = makeDeps({
      tileMap,
      getStateMachineTiles: () => smTiles,
      tilesAtRing: vi.fn((_row, _col, ring) =>
        ring === 0 ? ["sm-tile", "new-tile"] : [],
      ),
      getTileEntry: vi.fn((_map, id) => makeEntry(id)),
      loadTile: vi.fn(async (_basePath, _lang, entry) => {
        loadedIds.push(entry.id);
        return fakeQuery();
      }),
    });

    const { articleWindow } = createArticleWindowFactory(deps);
    await articleWindow.ensureRange(0, 10);

    // sm-tile should be skipped, only new-tile loaded
    expect(loadedIds).toEqual(["new-tile"]);
  });
});
