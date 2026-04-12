import { createArticleWindowFactory } from "./article-window-factory";
import type { ArticleWindowFactoryDeps } from "./article-window-factory";
import { NearestQuery } from "./query";
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

/** Empty NearestQuery — valid instance with no articles. */
function fakeQuery(): NearestQuery {
  const empty = {
    vertexPoints: new Float64Array(0),
    vertexTriangles: new Uint32Array(0),
    triangleVertices: new Uint32Array(0),
    triangleNeighbors: new Uint32Array(0),
  };
  return new NearestQuery(empty, []);
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
  it("queries both state machine and provider tiles via queryTiles", async () => {
    const smTile = fakeQuery();
    const providerTile = fakeQuery();

    const smTiles = new Map<string, NearestQuery>([["sm-t0", smTile]]);
    const tileMap = new Map<string, TileEntry>([
      ["sm-t0", makeEntry("sm-t0")],
      ["ring-t1", makeEntry("ring-t1")],
    ]);

    const allTilesSeen: Map<string, NearestQuery>[] = [];

    const deps = makeDeps({
      tileMap,
      getStateMachineTiles: () => smTiles,
      tilesAtRing: vi.fn((_row, _col, ring) => {
        if (ring === 0) return ["sm-t0", "ring-t1"];
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

    // queryTiles should have been called with both sm-t0 and ring-t1
    // and findNearestTiled should see both tiles in the query
    const allSeenIds = allTilesSeen.flatMap((m) => [...m.keys()]);
    expect(allSeenIds).toContain("sm-t0");
    expect(allSeenIds).toContain("ring-t1");
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

  it("skips loading tiles already in state machine but reports them for querying", async () => {
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

    // sm-tile should NOT be loaded (it's already in SM), only new-tile loaded
    expect(loadedIds).toEqual(["new-tile"]);
  });

  it("continues loading remaining tiles after one tile fails to load", async () => {
    const tileMap = new Map<string, TileEntry>([
      ["t0", makeEntry("t0")],
      ["t1", makeEntry("t1")],
      ["t2", makeEntry("t2")],
    ]);

    const deps = makeDeps({
      tileMap,
      tilesAtRing: vi.fn((_row, _col, ring) =>
        ring === 0 ? ["t0", "t1", "t2"] : [],
      ),
      getTileEntry: vi.fn((_map, id) => makeEntry(id)),
      loadTile: vi.fn(async (_basePath, _lang, entry) => {
        if (entry.id === "t1") throw new Error("network failure");
        return fakeQuery();
      }),
    });

    const { providerTiles, articleWindow } = createArticleWindowFactory(deps);
    await articleWindow.ensureRange(0, 10);

    expect(providerTiles.has("t0")).toBe(true);
    expect(providerTiles.has("t1")).toBe(false);
    expect(providerTiles.has("t2")).toBe(true);
  });
});
