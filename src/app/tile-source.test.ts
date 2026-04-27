import { createTileSource } from "./tile-source";
import { NearestQuery, toFlatDelaunay } from "./query";
import { buildTriangulation, convexHull, serialize } from "spherical-delaunay";
import { GRID_DEG, tileFor, tileId, type TileEntry } from "../tiles";

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

describe("createTileSource", () => {
  it("treats state-machine tiles as already loaded without invoking loadTile", async () => {
    const center = makeEntryAt(1, 2);
    const smTiles = new Map<string, NearestQuery>([
      [center.id, makeNearestQuery("sm")],
    ]);
    const loadTile = vi.fn(async () => makeNearestQuery("network"));

    const source = createTileSource({
      position: { lat: 1, lon: 2 },
      tileMap: new Map([[center.id, center]]),
      getStateMachineTiles: () => smTiles,
      loadTile,
    });

    expect(source.isLoaded(center.id)).toBe(true);
    await source.load(center.id, new AbortController().signal);
    expect(loadTile).not.toHaveBeenCalled();
    // The source's merged view exposes the state-machine entry — local
    // cache stays empty, but loaded() reports the union.
    expect(source.loaded().has(center.id)).toBe(true);
  });

  it("caches a fetched tile and does not re-fetch on subsequent loads", async () => {
    const center = makeEntryAt(1, 2);
    const loadTile = vi.fn(async () => makeNearestQuery("first"));

    const source = createTileSource({
      position: { lat: 1, lon: 2 },
      tileMap: new Map([[center.id, center]]),
      getStateMachineTiles: () => new Map(),
      loadTile,
    });

    await source.load(center.id, new AbortController().signal);
    await source.load(center.id, new AbortController().signal);

    expect(loadTile).toHaveBeenCalledTimes(1);
    expect(source.isLoaded(center.id)).toBe(true);
  });

  it("does not cache the tile if abort fires while loadTile is in flight", async () => {
    const center = makeEntryAt(1, 2);
    const ac = new AbortController();
    const loadTile = vi.fn(async () => {
      // Simulate the abort racing the network response.
      ac.abort();
      return makeNearestQuery("late");
    });

    const source = createTileSource({
      position: { lat: 1, lon: 2 },
      tileMap: new Map([[center.id, center]]),
      getStateMachineTiles: () => new Map(),
      loadTile,
    });

    await source.load(center.id, ac.signal);

    // loadTile resolved, but the post-await abort check kept its result
    // out of the cache — the caller asked us to forget about this tile.
    expect(source.isLoaded(center.id)).toBe(false);
    expect([...source.loaded().keys()]).toEqual([]);
  });

  it("reports hasEntry only for tiles that exist in the index", () => {
    const known = makeEntryAt(1, 2);
    const source = createTileSource({
      position: { lat: 1, lon: 2 },
      tileMap: new Map([[known.id, known]]),
      getStateMachineTiles: () => new Map(),
      loadTile: vi.fn(),
    });

    expect(source.hasEntry(known.id)).toBe(true);
    expect(source.hasEntry("nonexistent-tile-id")).toBe(false);
  });

  it("merges loaded() with local taking precedence over state-machine entries", async () => {
    const center = makeEntryAt(1, 2);
    const smQuery = makeNearestQuery("sm-version");
    const localQuery = makeNearestQuery("local-version");
    const smTiles = new Map<string, NearestQuery>([[center.id, smQuery]]);

    // Pretend the state machine had this tile, but the source also loaded
    // its own copy. The source's local cache must win on collision so the
    // ordering matches the original `providerTiles.get(id) ?? smTiles.get(id)`
    // semantics from before the refactor.
    const source = createTileSource({
      position: { lat: 1, lon: 2 },
      tileMap: new Map([[center.id, center]]),
      getStateMachineTiles: () => smTiles,
      loadTile: vi.fn(async () => localQuery),
    });

    // Force a local cache entry by calling the underlying loadTile directly
    // through the source (the SM-skip would normally bail). To do that, we
    // need the SM map empty during load, then non-empty afterwards — model
    // the race by toggling the getter.
    let smActive = false;
    const togglingSource = createTileSource({
      position: { lat: 1, lon: 2 },
      tileMap: new Map([[center.id, center]]),
      getStateMachineTiles: () =>
        smActive ? smTiles : new Map<string, NearestQuery>(),
      loadTile: vi.fn(async () => localQuery),
    });
    await togglingSource.load(center.id, new AbortController().signal);
    smActive = true;

    expect(togglingSource.loaded().get(center.id)).toBe(localQuery);
    // Avoid the unused-binding lint by referencing the un-toggled source.
    expect(source.loaded().get(center.id)).toBe(smQuery);
  });
});
