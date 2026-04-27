import { createArticleWindowFactory } from "./article-window-factory";
import { createTileSource } from "./tile-source";
import type { CreateTileSourceOpts } from "./tile-source";
import { NearestQuery, toFlatDelaunay } from "./query";
import { buildTriangulation, convexHull, serialize } from "spherical-delaunay";
import { GRID_DEG, tileFor, tileId, type TileEntry } from "../tiles";
import type { UserPosition } from "./types";

/**
 * Build a tile entry at the row/col the production tileFor() helper would
 * pick for (lat, lon). Tests share the real grid so their tileMap keys
 * line up with what the source's tilesAtRing emits.
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

/**
 * Construct a real TileSource and wire it to a fresh factory. Callers
 * override tile-loading concerns through `sourceOverrides` (which feed
 * createTileSource) and abort behavior through `signal`. The single
 * test seam that matters is `loadTile` — everything else is real.
 */
function buildFactory(
  opts: {
    position?: UserPosition;
    signal?: AbortSignal;
    sourceOverrides?: Partial<CreateTileSourceOpts>;
  } = {},
) {
  const position = opts.position ?? { lat: 1, lon: 2 };
  const center = makeEntryAt(position.lat, position.lon);
  const source = createTileSource({
    position,
    tileMap: new Map([[center.id, center]]),
    getStateMachineTiles: () => new Map(),
    loadTile: vi.fn(async () => makeNearestQuery("default")),
    ...opts.sourceOverrides,
  });
  const articleWindow = createArticleWindowFactory({
    position,
    signal: opts.signal ?? new AbortController().signal,
    source,
  });
  return { source, articleWindow };
}

describe("createArticleWindowFactory", () => {
  it("skips tiles already in the state machine and only loads the rest", async () => {
    // The state machine already holds smEntry; the factory must not invoke
    // loadTile for it. The radius provider's queryTiles closure pulls from
    // the source's merged loaded() view, so the smEntry is still consumed
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
    const loadTile = vi.fn(async (entry: TileEntry) => {
      loadedIds.push(entry.id);
      return makeNearestQuery(entry.id);
    });

    const { source, articleWindow } = buildFactory({
      position: { lat: 1, lon: 2 },
      sourceOverrides: {
        tileMap,
        getStateMachineTiles: () => smTiles,
        loadTile,
      },
    });
    await articleWindow.ensureRange(0, 10);

    expect(loadedIds).not.toContain(smEntry.id);
    // The state-machine tile is visible to queries via the source's merged
    // view but never duplicated into the source's local cache.
    expect(source.loaded().has(smEntry.id)).toBe(true);
  });

  it("stops loading tiles when signal is aborted mid-ring", async () => {
    const ac = new AbortController();
    const centerEntry = makeEntryAt(1, 2);
    const tileMap = new Map<string, TileEntry>([
      [centerEntry.id, centerEntry],
      [makeEntryAt(1, 6).id, makeEntryAt(1, 6)],
      [makeEntryAt(1, 10).id, makeEntryAt(1, 10)],
    ]);

    let loadCount = 0;
    const loadTile = vi.fn(async () => {
      loadCount++;
      // Abort while the first load is mid-flight.
      ac.abort();
      return makeNearestQuery("loaded");
    });

    const { source, articleWindow } = buildFactory({
      position: { lat: 1, lon: 2 },
      signal: ac.signal,
      sourceOverrides: {
        tileMap,
        loadTile,
      },
    });
    await articleWindow.ensureRange(0, 10);

    // At most one tile load was issued before the loop bailed on the abort.
    expect(loadCount).toBeLessThanOrEqual(1);
    // The in-flight tile resolved after the abort — the source must not
    // have cached its data, or downstream queries would include a tile the
    // caller explicitly abandoned.
    expect([...source.loaded().keys()]).toEqual([]);
  });

  it("continues loading remaining tiles after one tile fails to load", async () => {
    // Three tiles in ring 0/1; force the middle one to throw and assert
    // the others still land in the source.
    const t0 = makeEntryAt(1, 2);
    const t1 = makeEntryAt(1, 6);
    const t2 = makeEntryAt(1, 10);
    const tileMap = new Map<string, TileEntry>([
      [t0.id, t0],
      [t1.id, t1],
      [t2.id, t2],
    ]);

    const loadTile = vi.fn(async (entry: TileEntry): Promise<NearestQuery> => {
      if (entry.id === t1.id) throw new Error("network failure");
      return makeNearestQuery(entry.id);
    });

    const { source, articleWindow } = buildFactory({
      position: { lat: 1, lon: 2 },
      sourceOverrides: {
        tileMap,
        loadTile,
      },
    });
    await articleWindow.ensureRange(0, 10);

    expect(source.loaded().has(t0.id)).toBe(true);
    expect(source.loaded().has(t1.id)).toBe(false);
    expect(source.loaded().has(t2.id)).toBe(true);
  });
});
