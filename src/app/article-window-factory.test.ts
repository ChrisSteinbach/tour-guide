import { createArticleWindowFactory } from "./article-window-factory";
import type { ArticleWindowFactoryDeps } from "./article-window-factory";
import { NearestQuery, toFlatDelaunay } from "./query";
import { buildTriangulation, convexHull, serialize } from "../geometry";
import { GRID_DEG, tileFor, tileId, type TileEntry } from "../tiles";

/**
 * Build a tile entry at the row/col the production tileFor() helper would
 * pick for (lat, lon). The factory now imports tileFor and tilesAtRing
 * directly, so the test must mirror the real grid layout — its tileMap
 * keys must match the IDs tilesAtRing emits.
 */
function makeEntryAt(lat: number, lon: number): TileEntry {
  const { row, col } = tileFor(lat, lon);
  return {
    id: tileId(row, col),
    row,
    col,
    south: row * GRID_DEG - 90,
    north: (row + 1) * GRID_DEG - 90,
    west: col * GRID_DEG - 180,
    east: (col + 1) * GRID_DEG - 180,
    articles: 1,
    bytes: 100,
    hash: "abc",
  };
}

/**
 * Build a real NearestQuery from a tiny octahedron — enough vertices for the
 * triangulation to satisfy findNearest without crashing on the underlying
 * empty-array edge cases. Each tile in the test gets a unique title so the
 * deduplication and merge logic stays observable.
 */
function makeNearestQuery(title: string): NearestQuery {
  const points: [number, number, number][] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  const articles = points.map((_, i) => ({ title: `${title}-${i}` }));
  const hull = convexHull(points);
  const tri = buildTriangulation(hull);
  const data = serialize(tri, articles);
  const fd = toFlatDelaunay(data);
  return new NearestQuery(
    fd,
    data.articles.map((t) => ({ title: t })),
  );
}

function makeDeps(
  overrides: Partial<ArticleWindowFactoryDeps> = {},
): ArticleWindowFactoryDeps {
  const center = makeEntryAt(1, 2);
  return {
    position: { lat: 1, lon: 2 },
    tileMap: new Map([[center.id, center]]),
    lang: "en",
    signal: new AbortController().signal,
    getStateMachineTiles: () => new Map(),
    loadTile: vi.fn(async () => makeNearestQuery("default")),
    ...overrides,
  };
}

describe("createArticleWindowFactory", () => {
  it("skips tiles already in the state machine and only loads the rest", async () => {
    // The state machine already holds smEntry; the factory must not invoke
    // loadTile for it. The radius provider's queryTiles closure merges
    // providerTiles + state-machine tiles, so the smEntry is still consumed
    // when computing nearest articles — just without a redundant fetch.
    const centerEntry = makeEntryAt(1, 2);
    const smEntry = makeEntryAt(1, 6);
    const otherEntry = makeEntryAt(1, 10);

    const smTiles = new Map<string, NearestQuery>([
      [smEntry.id, makeNearestQuery("sm")],
    ]);

    const tileMap = new Map<string, TileEntry>([
      [centerEntry.id, centerEntry],
      [smEntry.id, smEntry],
      [otherEntry.id, otherEntry],
    ]);

    const loadedIds: string[] = [];
    const loadTile = vi.fn(async (_base: string, _lang, entry: TileEntry) => {
      loadedIds.push(entry.id);
      return makeNearestQuery(entry.id);
    });

    const deps = makeDeps({
      position: { lat: 1, lon: 2 },
      tileMap,
      getStateMachineTiles: () => smTiles,
      loadTile,
    });

    const { articleWindow, providerTiles } = createArticleWindowFactory(deps);
    await articleWindow.ensureRange(0, 10);

    expect(loadedIds).not.toContain(smEntry.id);
    // smEntry stays in the state machine map — it was never moved into
    // providerTiles, so the factory hasn't duplicated it.
    expect(providerTiles.has(smEntry.id)).toBe(false);
  });

  it("stops loading tiles when signal is aborted mid-ring", async () => {
    const ac = new AbortController();
    const centerEntry = makeEntryAt(1, 2);
    // Two adjacent tiles in the same column-row pattern so they sit in ring 0/1.
    const tileMap = new Map<string, TileEntry>([
      [centerEntry.id, centerEntry],
      [makeEntryAt(1, 6).id, makeEntryAt(1, 6)],
      [makeEntryAt(1, 10).id, makeEntryAt(1, 10)],
    ]);

    let loadCount = 0;
    const loadTile = vi.fn(async () => {
      loadCount++;
      // Abort after first tile load.
      ac.abort();
      return makeNearestQuery("loaded");
    });

    const deps = makeDeps({
      position: { lat: 1, lon: 2 },
      tileMap,
      signal: ac.signal,
      loadTile,
    });

    const { articleWindow, providerTiles } = createArticleWindowFactory(deps);
    await articleWindow.ensureRange(0, 10);

    // At most one tile should have been loaded — the abort fires inside the
    // first loadTile call's continuation, and the loop bails before issuing
    // any further loads.
    expect(loadCount).toBeLessThanOrEqual(1);
    // The in-flight tile resolved after the abort — its data must not be
    // recorded in providerTiles, or downstream queries would include a tile
    // the caller explicitly abandoned.
    expect([...providerTiles.keys()]).toEqual([]);
  });

  it("continues loading remaining tiles after one tile fails to load", async () => {
    // Three tiles in ring 0 (the center plus two neighbors). Make the second
    // load throw and assert the third still lands.
    const t0 = makeEntryAt(1, 2);
    const t1 = makeEntryAt(1, 6);
    const t2 = makeEntryAt(1, 10);
    const tileMap = new Map<string, TileEntry>([
      [t0.id, t0],
      [t1.id, t1],
      [t2.id, t2],
    ]);

    const loadTile = vi.fn(
      async (_base: string, _lang, entry: TileEntry): Promise<NearestQuery> => {
        if (entry.id === t1.id) throw new Error("network failure");
        return makeNearestQuery(entry.id);
      },
    );

    const deps = makeDeps({
      position: { lat: 1, lon: 2 },
      tileMap,
      loadTile,
    });

    const { providerTiles, articleWindow } = createArticleWindowFactory(deps);
    // Ring 1+ contains 8 more tiles; the radius provider expands until the
    // requested count is met. With only 3 tiles in the map, the loader will
    // keep trying t1 but skip past on every retry path.
    await articleWindow.ensureRange(0, 10);

    expect(providerTiles.has(t0.id)).toBe(true);
    expect(providerTiles.has(t1.id)).toBe(false);
    expect(providerTiles.has(t2.id)).toBe(true);
  });
});
