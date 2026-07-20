import { createBrowseListLifecycle } from "./browse-list-lifecycle";
import type { BrowseListLifecycleDeps } from "./browse-list-lifecycle";
import type { FarFieldEntry } from "../farfield";
import type { AppState } from "./state-machine";
import type { SampledTierMeta, TileEntry } from "../tiles";
import type { NearbyArticle } from "./types";

const position = { lat: 0, lon: 0 }; // sits in tile 18-36

/** A cell's tile-index entry; carries a mid-field digest when `digest` is given. */
function tileEntry(id: string, digest?: SampledTierMeta): TileEntry {
  const [row, col] = id.split("-").map(Number);
  const south = row * 5 - 90;
  const west = col * 5 - 180;
  return {
    id,
    row,
    col,
    south,
    north: south + 5,
    west,
    east: west + 5,
    articles: 100,
    bytes: 1000,
    hash: "abcd1234",
    ...(digest ? { digest } : {}),
  };
}

const DIGEST_META: SampledTierMeta = {
  count: 250,
  bytes: 2048,
  hash: "aabbccdd",
};

/**
 * `tileMap` defaults to empty: every existing tile is loaded, so coverage is
 * unbounded and the far field is never cut off by the radius. Pass a
 * populated map (see `tileEntry`) for tests that exercise the mid-field
 * tier, which reads cells' `digest` metadata straight off `tileMap`.
 */
function tiledState(tileMap: Map<string, TileEntry> = new Map()): AppState {
  return {
    query: {
      mode: "tiled",
      index: {
        version: 1,
        gridDeg: 5,
        bufferDeg: 0.5,
        generated: "2026-01-01",
        tiles: [],
      },
      tileMap,
      tiles: new Map(),
    },
    currentLang: "en",
    filter: "all",
  } as unknown as AppState;
}

function makeDeps(
  overrides: Partial<BrowseListLifecycleDeps> = {},
): BrowseListLifecycleDeps {
  return {
    getState: () => tiledState(),
    queryLocal: () => [],
    loadFarField: async () => [],
    loadDigest: async () => [],
    renderBrowsingList: vi.fn(),
    ...overrides,
  };
}

describe("createBrowseListLifecycle", () => {
  it("builds a list from the loaded tiles without waiting on the far field", () => {
    const local: NearbyArticle[] = [
      { title: "Nearby", lat: 0.01, lon: 0, distanceM: 1_100 },
    ];
    const observed: NearbyArticle[][] = [];
    const lifecycle = createBrowseListLifecycle(
      makeDeps({
        queryLocal: () => local,
        // Never resolves — the first build must not depend on it.
        loadFarField: () => new Promise(() => {}),
      }),
    );
    lifecycle.attachObserver((a) => observed.push(a));

    lifecycle.rebuild(position);

    expect(observed).toHaveLength(1);
    expect(observed[0].map((a) => a.title)).toEqual(["Nearby"]);
  });

  it("extends the list and re-renders once the far field arrives", async () => {
    const renderBrowsingList = vi.fn();
    const farField: FarFieldEntry[] = [
      { title: "Far away", lat: 50, lon: 0, weight: 200 },
    ];
    const observed: NearbyArticle[][] = [];
    const lifecycle = createBrowseListLifecycle(
      makeDeps({
        queryLocal: () => [
          { title: "Nearby", lat: 0.01, lon: 0, distanceM: 1_100 },
        ],
        loadFarField: () => Promise.resolve(farField),
        renderBrowsingList,
      }),
    );
    lifecycle.attachObserver((a) => observed.push(a));

    lifecycle.rebuild(position);
    await vi.waitFor(() => expect(observed).toHaveLength(2));

    expect(observed[1].map((a) => a.title)).toEqual(["Nearby", "Far away"]);
    expect(renderBrowsingList).toHaveBeenCalled();
  });

  it("fetches the far field once per language, not once per rebuild", () => {
    const loadFarField = vi.fn(async () => []);
    const lifecycle = createBrowseListLifecycle(makeDeps({ loadFarField }));

    lifecycle.rebuild(position);
    lifecycle.rebuild({ lat: 1, lon: 1 });
    lifecycle.rebuild({ lat: 2, lon: 2 });

    expect(loadFarField).toHaveBeenCalledTimes(1);
  });

  it("refetches the far field when the language changes", () => {
    const loadFarField: BrowseListLifecycleDeps["loadFarField"] = vi.fn(
      async () => [],
    );
    let lang = "en";
    const lifecycle = createBrowseListLifecycle(
      makeDeps({
        getState: () => ({ ...tiledState(), currentLang: lang }) as AppState,
        loadFarField,
      }),
    );

    lifecycle.rebuild(position);
    lang = "sv";
    lifecycle.rebuild(position);

    expect(loadFarField).toHaveBeenCalledTimes(2);
    expect(vi.mocked(loadFarField).mock.calls[1][0]).toBe("sv");
  });

  it("discards a far field that arrives after its language was abandoned", async () => {
    let resolveEn: (v: FarFieldEntry[]) => void = () => {};
    let lang = "en";
    const observed: NearbyArticle[][] = [];
    const lifecycle = createBrowseListLifecycle(
      makeDeps({
        getState: () => ({ ...tiledState(), currentLang: lang }) as AppState,
        loadFarField: (l) =>
          l === "en"
            ? new Promise<FarFieldEntry[]>((r) => (resolveEn = r))
            : Promise.resolve([]),
      }),
    );
    lifecycle.attachObserver((a) => observed.push(a));

    lifecycle.rebuild(position);
    lang = "sv";
    lifecycle.rebuild(position);
    // Let the Swedish fetch settle so its own rebuild is already counted.
    await vi.waitFor(() => expect(observed).toHaveLength(3));
    const countBeforeLateArrival = observed.length;

    // The abandoned English fetch finally lands — it must not repopulate a
    // Swedish list with English articles.
    resolveEn([{ title: "English article", lat: 50, lon: 0, weight: 200 }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(observed).toHaveLength(countBeforeLateArrival);
  });

  it("applies the Highlights filter to the list it builds", () => {
    const observed: NearbyArticle[][] = [];
    const lifecycle = createBrowseListLifecycle(
      makeDeps({
        getState: () => ({ ...tiledState(), filter: "highlights" }),
        loadFarField: () =>
          Promise.resolve([
            { title: "Famous", lat: 50, lon: 0, weight: 250 },
            { title: "Unremarkable", lat: 50, lon: 0, weight: 3 },
          ]),
      }),
    );
    lifecycle.attachObserver((a) => observed.push(a));

    lifecycle.rebuild(position);

    return vi.waitFor(() => {
      const latest = observed[observed.length - 1];
      expect(latest.map((a) => a.title)).toEqual(["Famous"]);
    });
  });

  it("builds nothing before tiles are available", () => {
    const observed: NearbyArticle[][] = [];
    const lifecycle = createBrowseListLifecycle(
      makeDeps({
        getState: () => ({ query: { mode: "none" } }) as AppState,
      }),
    );
    lifecycle.attachObserver((a) => observed.push(a));

    lifecycle.rebuild(position);

    expect(observed).toHaveLength(0);
    expect(lifecycle.list()).toEqual([]);
  });

  it("clears the list on reset", () => {
    const lifecycle = createBrowseListLifecycle(
      makeDeps({
        queryLocal: () => [
          { title: "Nearby", lat: 0.01, lon: 0, distanceM: 1_100 },
        ],
      }),
    );

    lifecycle.rebuild(position);
    expect(lifecycle.list()).toHaveLength(1);

    lifecycle.reset();

    expect(lifecycle.list()).toEqual([]);
  });

  it("keeps the far field across a reset rather than refetching it", () => {
    const loadFarField = vi.fn(async () => []);
    const lifecycle = createBrowseListLifecycle(makeDeps({ loadFarField }));

    lifecycle.rebuild(position);
    lifecycle.reset();
    lifecycle.rebuild(position);

    expect(loadFarField).toHaveBeenCalledTimes(1);
  });

  it("rejects a second observer instead of silently replacing the first", () => {
    const lifecycle = createBrowseListLifecycle(makeDeps());
    lifecycle.attachObserver(vi.fn());

    expect(() => lifecycle.attachObserver(vi.fn())).toThrow(/already attached/);
  });

  it("adds mid-field articles to the list once their digests resolve, and re-renders", async () => {
    const tileMap = new Map([
      ["18-36", tileEntry("18-36", DIGEST_META)],
      ["18-37", tileEntry("18-37", DIGEST_META)],
    ]);
    const renderBrowsingList = vi.fn();
    const observed: NearbyArticle[][] = [];
    const lifecycle = createBrowseListLifecycle(
      makeDeps({
        getState: () => tiledState(tileMap),
        // Never resolves — isolates this test from the far field's own
        // independent re-render.
        loadFarField: () => new Promise(() => {}),
        loadDigest: (_lang, tileId) =>
          Promise.resolve([
            { title: `Article from ${tileId}`, lat: 2, lon: 0, weight: 100 },
          ]),
        renderBrowsingList,
      }),
    );
    lifecycle.attachObserver((a) => observed.push(a));

    lifecycle.rebuild(position);
    await vi.waitFor(() => expect(observed).toHaveLength(2));

    const titles = observed[1].map((a) => a.title);
    expect(titles).toContain("Article from 18-36");
    expect(titles).toContain("Article from 18-37");
    expect(renderBrowsingList).toHaveBeenCalled();
  });

  it("re-renders once for a batch of several digests, not once per digest", async () => {
    const tileMap = new Map([
      ["18-36", tileEntry("18-36", DIGEST_META)],
      ["18-37", tileEntry("18-37", DIGEST_META)],
      ["18-38", tileEntry("18-38", DIGEST_META)],
    ]);
    const renderBrowsingList = vi.fn();
    const lifecycle = createBrowseListLifecycle(
      makeDeps({
        getState: () => tiledState(tileMap),
        loadFarField: () => new Promise(() => {}),
        loadDigest: async () => [],
        renderBrowsingList,
      }),
    );

    lifecycle.rebuild(position);
    await vi.waitFor(() => expect(renderBrowsingList).toHaveBeenCalled());

    expect(renderBrowsingList).toHaveBeenCalledTimes(1);
  });

  it("does not refetch digests on a second rebuild at the same position", () => {
    const tileMap = new Map([["18-36", tileEntry("18-36", DIGEST_META)]]);
    const loadDigest = vi.fn(async () => []);
    const lifecycle = createBrowseListLifecycle(
      makeDeps({
        getState: () => tiledState(tileMap),
        loadDigest,
      }),
    );

    lifecycle.rebuild(position);
    lifecycle.rebuild(position);

    expect(loadDigest).toHaveBeenCalledTimes(1);
  });

  it("refetches digests when the language changes even though the cell IDs are unchanged", () => {
    const tileMap = new Map([["18-36", tileEntry("18-36", DIGEST_META)]]);
    const loadDigest: BrowseListLifecycleDeps["loadDigest"] = vi.fn(
      async () => [],
    );
    let lang = "en";
    const lifecycle = createBrowseListLifecycle(
      makeDeps({
        getState: () =>
          ({ ...tiledState(tileMap), currentLang: lang }) as AppState,
        loadDigest,
      }),
    );

    lifecycle.rebuild(position);
    lang = "sv";
    lifecycle.rebuild(position);

    expect(loadDigest).toHaveBeenCalledTimes(2);
    expect(vi.mocked(loadDigest).mock.calls[1][0]).toBe("sv");
  });

  it("drops a cell's mid-field articles once it falls out of range", async () => {
    const tileMap = new Map([["18-36", tileEntry("18-36", DIGEST_META)]]);
    const lifecycle = createBrowseListLifecycle(
      makeDeps({
        getState: () => tiledState(tileMap),
        loadFarField: () => new Promise(() => {}),
        loadDigest: async () => [
          { title: "Mid-field article", lat: 2, lon: 0, weight: 100 },
        ],
      }),
    );

    lifecycle.rebuild(position);
    await vi.waitFor(() =>
      expect(lifecycle.list().map((a) => a.title)).toContain(
        "Mid-field article",
      ),
    );

    // 90° of longitude away: tile 18-36 no longer sits within
    // MID_FIELD_RADIUS_M.
    lifecycle.rebuild({ lat: 0, lon: 90 });

    expect(lifecycle.list().map((a) => a.title)).not.toContain(
      "Mid-field article",
    );
  });

  it("keeps the list working when a digest fetch rejects", async () => {
    const tileMap = new Map([["18-36", tileEntry("18-36", DIGEST_META)]]);
    const observed: NearbyArticle[][] = [];
    const lifecycle = createBrowseListLifecycle(
      makeDeps({
        getState: () => tiledState(tileMap),
        queryLocal: () => [
          { title: "Nearby", lat: 0.01, lon: 0, distanceM: 1_100 },
        ],
        loadFarField: () =>
          Promise.resolve([
            { title: "Far away", lat: 50, lon: 0, weight: 200 },
          ]),
        loadDigest: () => Promise.reject(new Error("digest unavailable")),
      }),
    );
    lifecycle.attachObserver((a) => observed.push(a));

    lifecycle.rebuild(position);

    await vi.waitFor(() =>
      expect(observed[observed.length - 1].map((a) => a.title)).toEqual([
        "Nearby",
        "Far away",
      ]),
    );
  });
});
