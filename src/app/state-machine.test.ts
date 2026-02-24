import {
  transition,
  getNearby,
  getNextTier,
  NEARBY_TIERS,
  REQUERY_DISTANCE_M,
  type AppState,
  type QueryState,
  type Phase,
  type Effect,
} from "./state-machine";
import type { NearbyArticle, UserPosition } from "./types";
import type { LocationError } from "./location";
import { NearestQuery, toFlatDelaunay } from "./query";
import type { TileIndex } from "../tiles";
import { buildTileMap } from "./tile-loader";
import { mockArticles, mockPosition } from "./mock-data";
import {
  toCartesian,
  convexHull,
  buildTriangulation,
  serialize,
} from "../geometry";

// ── Test helpers ─────────────────────────────────────────────

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    phase: { phase: "welcome" },
    query: { mode: "none" },
    position: null,
    currentLang: "en",
    loadGeneration: 0,
    loadingTiles: new Set(),
    downloadProgress: -1,
    ...overrides,
  };
}

const paris: UserPosition = { lat: 48.8584, lon: 2.2945 };
const parisNearby: UserPosition = { lat: 48.8586, lon: 2.2948 }; // ~25m away
const parisSame: UserPosition = { lat: 48.85841, lon: 2.29451 }; // ~1m away

/** Build a minimal NearestQuery from a set of articles. */
function buildQuery(
  articles: { title: string; lat: number; lon: number }[],
): NearestQuery {
  const points = articles.map((a) => toCartesian(a));
  const hull = convexHull(points);
  const tri = buildTriangulation(hull);
  const meta = articles.map((a) => ({ title: a.title }));
  const data = serialize(tri, meta);
  const fd = toFlatDelaunay(data);
  return new NearestQuery(fd, meta);
}

const sampleNearestQuery = buildQuery(mockArticles);
const sampleIndex: TileIndex = {
  version: 1,
  gridDeg: 5,
  bufferDeg: 0.5,
  generated: "2024-01-01",
  tiles: [
    {
      id: "27-36",
      row: 27,
      col: 36,
      south: 45,
      north: 50,
      west: 0,
      east: 5,
      articles: 100,
      bytes: 1000,
      hash: "abc",
    },
  ],
};
const sampleQuery: QueryState = {
  mode: "tiled",
  index: sampleIndex,
  tileMap: buildTileMap(sampleIndex),
  tiles: new Map([["27-36", sampleNearestQuery]]),
};

function browsingState(
  overrides: Partial<AppState> & {
    articles?: NearbyArticle[];
    nearbyCount?: number;
    paused?: boolean;
    lastQueryPos?: UserPosition;
  } = {},
): AppState {
  const {
    articles: arts,
    nearbyCount,
    paused,
    lastQueryPos,
    ...stateOverrides
  } = overrides;
  const { results: defaultArticles } = sampleNearestQuery.findNearest(
    paris.lat,
    paris.lon,
    10,
  );
  return makeState({
    query: sampleQuery,
    position: paris,
    phase: {
      phase: "browsing",
      articles: arts ?? defaultArticles,
      nearbyCount: nearbyCount ?? 10,
      paused: paused ?? false,
      lastQueryPos: lastQueryPos ?? paris,
    },
    ...stateOverrides,
  });
}

function effectTypes(effects: Effect[]): string[] {
  return effects.map((e) => e.type);
}

// ── getNextTier ──────────────────────────────────────────────

describe("getNextTier", () => {
  it("returns the next tier for each valid count", () => {
    expect(getNextTier(10)).toBe(20);
    expect(getNextTier(20)).toBe(50);
    expect(getNextTier(50)).toBe(100);
  });

  it("returns undefined for the last tier", () => {
    expect(getNextTier(100)).toBeUndefined();
  });

  it("returns undefined for a count not in the tier list", () => {
    expect(getNextTier(7)).toBeUndefined();
  });
});

describe("NEARBY_TIERS", () => {
  it("is sorted ascending", () => {
    for (let i = 1; i < NEARBY_TIERS.length; i++) {
      expect(NEARBY_TIERS[i]).toBeGreaterThan(NEARBY_TIERS[i - 1]);
    }
  });
});

describe("REQUERY_DISTANCE_M", () => {
  it("is a positive number", () => {
    expect(REQUERY_DISTANCE_M).toBeGreaterThan(0);
  });
});

// ── getNearby ────────────────────────────────────────────────

describe("getNearby", () => {
  it("returns articles sorted by distance from tiled query", () => {
    const { articles } = getNearby(sampleQuery, paris, 5);
    expect(articles).toHaveLength(5);
    for (let i = 1; i < articles.length; i++) {
      expect(articles[i].distanceM).toBeGreaterThanOrEqual(
        articles[i - 1].distanceM,
      );
    }
  });

  it("falls back to mock articles when query mode is none", () => {
    const { articles } = getNearby({ mode: "none" }, paris, 10);
    expect(articles.length).toBeGreaterThan(0);
    expect(articles[0].title).toBeDefined();
    for (let i = 1; i < articles.length; i++) {
      expect(articles[i].distanceM).toBeGreaterThanOrEqual(
        articles[i - 1].distanceM,
      );
    }
  });
});

// ── start event (tour-guide-fed) ─────────────────────────────

describe("start event", () => {
  it("enters browsing when query and position ready", () => {
    const state = makeState({ query: sampleQuery, position: paris });
    const { next, effects } = transition(state, {
      type: "start",
      hasGeolocation: true,
    });
    expect(next.phase.phase).toBe("browsing");
    expect(effectTypes(effects)).toContain("storeStarted");
    expect(effectTypes(effects)).toContain("startGps");
    expect(effectTypes(effects)).toContain("renderBrowsingList");
  });

  it("enters locating when query ready but no position", () => {
    const state = makeState({ query: sampleQuery });
    const { next, effects } = transition(state, {
      type: "start",
      hasGeolocation: true,
    });
    expect(next.phase.phase).toBe("locating");
    expect(effectTypes(effects)).toContain("storeStarted");
    expect(effectTypes(effects)).toContain("startGps");
    expect(effectTypes(effects)).toContain("render");
  });

  it("enters downloading when no query", () => {
    const state = makeState();
    const { next, effects } = transition(state, {
      type: "start",
      hasGeolocation: true,
    });
    expect(next.phase.phase).toBe("downloading");
    expect(effectTypes(effects)).toContain("storeStarted");
    expect(effectTypes(effects)).toContain("startGps");
    expect(effectTypes(effects)).toContain("render");
  });

  it("uses mock data when no geolocation and no query", () => {
    const state = makeState();
    const { effects } = transition(state, {
      type: "start",
      hasGeolocation: false,
    });
    expect(effectTypes(effects)).toContain("storeStarted");
    expect(effectTypes(effects)).not.toContain("startGps");
    expect(effectTypes(effects)).toContain("stopGps");
  });
});

// ── tileLoadStarted event ─────────────────────────────────────

describe("tileLoadStarted event", () => {
  it("adds id to loadingTiles set", () => {
    const state = makeState({ loadingTiles: new Set(["a"]) });
    const { next, effects } = transition(state, {
      type: "tileLoadStarted",
      id: "b",
    });
    expect(next.loadingTiles.has("a")).toBe(true);
    expect(next.loadingTiles.has("b")).toBe(true);
    expect(effects).toEqual([]);
  });
});

// ── useMockData event (tour-guide-fed) ───────────────────────

describe("useMockData event", () => {
  it("enters browsing with mock position when query ready", () => {
    const state = makeState({ query: sampleQuery });
    const { next, effects } = transition(state, {
      type: "useMockData",
      mockPosition,
    });
    expect(next.phase.phase).toBe("browsing");
    expect(next.position).toBe(mockPosition);
    expect(effectTypes(effects)).toContain("stopGps");
    expect(effectTypes(effects)).toContain("renderBrowsingList");
  });

  it("enters downloading when no query", () => {
    const state = makeState();
    const { next, effects } = transition(state, {
      type: "useMockData",
      mockPosition,
    });
    expect(next.phase.phase).toBe("downloading");
    expect(next.position).toBe(mockPosition);
    expect(effectTypes(effects)).toContain("stopGps");
    expect(effectTypes(effects)).toContain("render");
  });

  it("triggers loadTiles for tiled query", () => {
    const index: TileIndex = {
      version: 1,
      gridDeg: 5,
      bufferDeg: 0.5,
      generated: "2024-01-01",
      tiles: [
        {
          id: "27-36",
          row: 27,
          col: 36,
          south: 45,
          north: 50,
          west: 0,
          east: 5,
          articles: 100,
          bytes: 1000,
          hash: "abc",
        },
      ],
    };
    const tiledQuery: QueryState = {
      mode: "tiled",
      index,
      tileMap: buildTileMap(index),
      tiles: new Map(),
    };
    const state = makeState({ query: tiledQuery });
    const { effects } = transition(state, {
      type: "useMockData",
      mockPosition,
    });
    expect(effectTypes(effects)).toContain("loadTiles");
  });
});

// ── position event (tour-guide-6ub) ─────────────────────────

describe("position event", () => {
  it("stores position in welcome phase without changing phase", () => {
    const state = makeState();
    const { next, effects } = transition(state, {
      type: "position",
      pos: paris,
    });
    expect(next.phase.phase).toBe("welcome");
    expect(next.position).toBe(paris);
    expect(effects).toEqual([]);
  });

  it("stores position in downloading phase without changing phase", () => {
    const state = makeState({
      phase: { phase: "downloading", progress: 0.5 },
    });
    const { next, effects } = transition(state, {
      type: "position",
      pos: paris,
    });
    expect(next.phase.phase).toBe("downloading");
    expect(next.position).toBe(paris);
    expect(effects).toEqual([]);
  });

  it("enters browsing from locating when query ready", () => {
    const state = makeState({
      phase: { phase: "locating" },
      query: sampleQuery,
    });
    const { next, effects } = transition(state, {
      type: "position",
      pos: paris,
    });
    expect(next.phase.phase).toBe("browsing");
    expect(effectTypes(effects)).toContain("renderBrowsingList");
  });

  it("enters loadingTiles from locating when tiled query with no tiles", () => {
    const index: TileIndex = {
      version: 1,
      gridDeg: 5,
      bufferDeg: 0.5,
      generated: "2024-01-01",
      tiles: [
        {
          id: "27-36",
          row: 27,
          col: 36,
          south: 45,
          north: 50,
          west: 0,
          east: 5,
          articles: 100,
          bytes: 1000,
          hash: "abc",
        },
      ],
    };
    const tiledQuery: QueryState = {
      mode: "tiled",
      index,
      tileMap: buildTileMap(index),
      tiles: new Map(),
    };
    const state = makeState({
      phase: { phase: "locating" },
      query: tiledQuery,
    });
    const { next, effects } = transition(state, {
      type: "position",
      pos: paris,
    });
    expect(next.phase.phase).toBe("loadingTiles");
    expect(effectTypes(effects)).toContain("loadTiles");
  });

  it("requeries when moved more than 15m while browsing", () => {
    const state = browsingState({ lastQueryPos: paris });
    const { next, effects } = transition(state, {
      type: "position",
      pos: parisNearby,
    });
    expect(next.phase.phase).toBe("browsing");
    expect(next.position).toEqual(parisNearby);
    expect(effectTypes(effects)).toContain("updateDistances");
  });

  it("does not requery when moved less than 15m", () => {
    const state = browsingState({ lastQueryPos: paris });
    const { next, effects } = transition(state, {
      type: "position",
      pos: parisSame,
    });
    expect(next.position).toEqual(parisSame);
    expect(effectTypes(effects)).not.toContain("renderBrowsingList");
    expect(effectTypes(effects)).not.toContain("updateDistances");
  });

  it("does not requery when paused", () => {
    const state = browsingState({ lastQueryPos: paris, paused: true });
    const { next, effects } = transition(state, {
      type: "position",
      pos: parisNearby,
    });
    expect(next.position).toEqual(parisNearby);
    expect(effectTypes(effects)).not.toContain("renderBrowsingList");
    expect(effectTypes(effects)).not.toContain("updateDistances");
  });

  it("triggers render in detail phase", () => {
    const { results: articles } = sampleNearestQuery.findNearest(
      paris.lat,
      paris.lon,
      10,
    );
    const state = makeState({
      query: sampleQuery,
      position: paris,
      phase: {
        phase: "detail",
        article: articles[0],
        articles,
        nearbyCount: 10,
        paused: false,
        lastQueryPos: paris,
      },
    });
    const { effects } = transition(state, {
      type: "position",
      pos: parisNearby,
    });
    expect(effectTypes(effects)).toContain("render");
  });
});

// ── gpsError event (tour-guide-6ub) ─────────────────────────

describe("gpsError event", () => {
  const error: LocationError = {
    code: "PERMISSION_DENIED",
    message: "User denied",
  };

  it("transitions to error from locating", () => {
    const state = makeState({ phase: { phase: "locating" } });
    const { next, effects } = transition(state, {
      type: "gpsError",
      error,
    });
    expect(next.phase).toEqual({ phase: "error", error });
    expect(effectTypes(effects)).toContain("render");
  });

  it("ignores error while browsing", () => {
    const state = browsingState();
    const { next, effects } = transition(state, {
      type: "gpsError",
      error,
    });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it("ignores error while on welcome", () => {
    const state = makeState();
    const { next, effects } = transition(state, {
      type: "gpsError",
      error,
    });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});

// ── showMore event (tour-guide-bli) ──────────────────────────

describe("showMore event", () => {
  it("advances from 10 to 20 articles", () => {
    const state = browsingState({ nearbyCount: 10 });
    const { next, effects } = transition(state, { type: "showMore" });
    expect(next.phase.phase).toBe("browsing");
    if (next.phase.phase === "browsing") {
      expect(next.phase.nearbyCount).toBe(20);
    }
    expect(effectTypes(effects)).toContain("renderBrowsingList");
  });

  it("no-ops at max tier", () => {
    const state = browsingState({ nearbyCount: 100 });
    const { next, effects } = transition(state, { type: "showMore" });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it("no-ops when not browsing", () => {
    const state = makeState();
    const { next, effects } = transition(state, { type: "showMore" });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});

// ── togglePause event (tour-guide-bli) ───────────────────────

describe("togglePause event", () => {
  it("pauses when unpaused", () => {
    const state = browsingState({ paused: false });
    const { next, effects } = transition(state, { type: "togglePause" });
    if (next.phase.phase === "browsing") {
      expect(next.phase.paused).toBe(true);
    }
    expect(effectTypes(effects)).toContain("renderBrowsingList");
  });

  it("unpauses and requeries at current position", () => {
    const state = browsingState({ paused: true });
    const { next, effects } = transition(state, { type: "togglePause" });
    if (next.phase.phase === "browsing") {
      expect(next.phase.paused).toBe(false);
      expect(next.phase.lastQueryPos).toBe(paris);
    }
    expect(effectTypes(effects)).toContain("renderBrowsingList");
  });

  it("no-ops when not browsing", () => {
    const state = makeState();
    const { next, effects } = transition(state, { type: "togglePause" });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});

// ── selectArticle event (tour-guide-2cd) ─────────────────────

describe("selectArticle event", () => {
  it("transitions from browsing to detail", () => {
    const state = browsingState();
    const article = (state.phase as Extract<Phase, { phase: "browsing" }>)
      .articles[0];
    const { next, effects } = transition(state, {
      type: "selectArticle",
      article,
    });
    expect(next.phase.phase).toBe("detail");
    if (next.phase.phase === "detail") {
      expect(next.phase.article).toBe(article);
    }
    expect(effectTypes(effects)).toContain("pushHistory");
    expect(effectTypes(effects)).toContain("fetchSummary");
  });

  it("preserves browsing context in detail state", () => {
    const state = browsingState({ nearbyCount: 20, paused: true });
    const browsing = state.phase as Extract<Phase, { phase: "browsing" }>;
    const { next } = transition(state, {
      type: "selectArticle",
      article: browsing.articles[0],
    });
    if (next.phase.phase === "detail") {
      expect(next.phase.articles).toBe(browsing.articles);
      expect(next.phase.nearbyCount).toBe(20);
      expect(next.phase.paused).toBe(true);
      expect(next.phase.lastQueryPos).toBe(browsing.lastQueryPos);
    }
  });

  it("no-ops when not browsing", () => {
    const state = makeState({ phase: { phase: "locating" } });
    const article: NearbyArticle = {
      title: "Test",
      lat: 0,
      lon: 0,
      distanceM: 0,
    };
    const { next, effects } = transition(state, {
      type: "selectArticle",
      article,
    });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});

// ── back event (tour-guide-2cd) ──────────────────────────────

describe("back event", () => {
  it("restores browsing state from detail", () => {
    const state = browsingState({ nearbyCount: 20, paused: true });
    const browsing = state.phase as Extract<Phase, { phase: "browsing" }>;
    const { next: detail } = transition(state, {
      type: "selectArticle",
      article: browsing.articles[0],
    });
    const { next: restored, effects } = transition(detail, { type: "back" });
    expect(restored.phase.phase).toBe("browsing");
    if (restored.phase.phase === "browsing") {
      expect(restored.phase.articles).toBe(browsing.articles);
      expect(restored.phase.nearbyCount).toBe(20);
      expect(restored.phase.paused).toBe(true);
    }
    expect(effectTypes(effects)).toContain("renderBrowsingList");
  });

  it("no-ops when not in detail", () => {
    const state = makeState();
    const { next, effects } = transition(state, { type: "back" });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});

// ── langChanged event (tour-guide-e3f) ───────────────────────

describe("langChanged event", () => {
  it("resets state and starts data loading from browsing", () => {
    const state = browsingState({ currentLang: "en" });
    const { next, effects } = transition(state, {
      type: "langChanged",
      lang: "sv",
    });
    expect(next.currentLang).toBe("sv");
    expect(next.query.mode).toBe("none");
    expect(next.phase.phase).toBe("downloading");
    expect(next.loadGeneration).toBe(state.loadGeneration + 1);
    expect(next.downloadProgress).toBe(-1);
    expect(next.loadingTiles.size).toBe(0);
    expect(effectTypes(effects)).toContain("storeLang");
    expect(effectTypes(effects)).toContain("loadData");
    expect(effectTypes(effects)).toContain("render");
  });

  it("stays on welcome if not started yet", () => {
    const state = makeState({ currentLang: "en" });
    const { next, effects } = transition(state, {
      type: "langChanged",
      lang: "sv",
    });
    expect(next.phase.phase).toBe("welcome");
    expect(next.currentLang).toBe("sv");
    expect(effectTypes(effects)).not.toContain("render");
    expect(effectTypes(effects)).toContain("loadData");
  });
});

// ── downloadProgress event (tour-guide-8y4) ──────────────────

describe("downloadProgress event", () => {
  it("updates progress in downloading phase", () => {
    const state = makeState({
      phase: { phase: "downloading", progress: 0.1 },
    });
    const { next, effects } = transition(state, {
      type: "downloadProgress",
      fraction: 0.5,
      gen: 0,
    });
    expect(next.downloadProgress).toBe(0.5);
    if (next.phase.phase === "downloading") {
      expect(next.phase.progress).toBe(0.5);
    }
    expect(effectTypes(effects)).toContain("render");
  });

  it("stores progress but does not render when not downloading", () => {
    const state = makeState();
    const { next, effects } = transition(state, {
      type: "downloadProgress",
      fraction: 0.3,
      gen: 0,
    });
    expect(next.downloadProgress).toBe(0.3);
    expect(effects).toEqual([]);
  });

  it("ignores stale generation", () => {
    const state = makeState({
      loadGeneration: 2,
      phase: { phase: "downloading", progress: 0 },
    });
    const { next, effects } = transition(state, {
      type: "downloadProgress",
      fraction: 0.5,
      gen: 1,
    });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});

// ── tileIndexLoaded event (tour-guide-8y4) ───────────────────

describe("tileIndexLoaded event", () => {
  const tileIndex: TileIndex = {
    version: 1,
    gridDeg: 5,
    bufferDeg: 0.5,
    generated: "2024-01-01",
    tiles: [
      {
        id: "27-36",
        row: 27,
        col: 36,
        south: 45,
        north: 50,
        west: 0,
        east: 5,
        articles: 100,
        bytes: 1000,
        hash: "abc",
      },
    ],
  };

  it("sets tiled query state when index exists", () => {
    const state = makeState();
    const { next } = transition(state, {
      type: "tileIndexLoaded",
      index: tileIndex,
      lang: "en",
      gen: 0,
    });
    expect(next.query.mode).toBe("tiled");
    if (next.query.mode === "tiled") {
      expect(next.query.index).toBe(tileIndex);
      expect(next.query.tiles.size).toBe(0);
    }
  });

  it("triggers loadTiles when position known", () => {
    const state = makeState({ position: paris });
    const { effects } = transition(state, {
      type: "tileIndexLoaded",
      index: tileIndex,
      lang: "en",
      gen: 0,
    });
    expect(effectTypes(effects)).toContain("loadTiles");
  });

  it("enters downloading with log when index is null", () => {
    const state = makeState();
    const { next, effects } = transition(state, {
      type: "tileIndexLoaded",
      index: null,
      lang: "en",
      gen: 0,
    });
    expect(next.query.mode).toBe("none");
    expect(next.phase.phase).toBe("downloading");
    expect(effectTypes(effects)).toContain("log");
    expect(effectTypes(effects)).toContain("render");
    expect(effectTypes(effects)).not.toContain("loadMonolithic");
  });

  it("ignores stale generation", () => {
    const state = makeState({ loadGeneration: 2 });
    const { next, effects } = transition(state, {
      type: "tileIndexLoaded",
      index: tileIndex,
      lang: "en",
      gen: 1,
    });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it("handles dataReady inline — downloading with position enters browsing", () => {
    const state = makeState({
      phase: { phase: "downloading", progress: 0 },
      position: paris,
    });
    const { next, effects } = transition(state, {
      type: "tileIndexLoaded",
      index: tileIndex,
      lang: "en",
      gen: 0,
    });
    // TiledQuery with 0 tiles → loadingTiles
    expect(next.phase.phase).toBe("loadingTiles");
    expect(effectTypes(effects)).toContain("render");
  });
});

// ── tileLoaded event (tour-guide-8y4) ────────────────────────

describe("tileLoaded event", () => {
  it("enters browsing from loadingTiles when first tile arrives", () => {
    const index: TileIndex = {
      version: 1,
      gridDeg: 5,
      bufferDeg: 0.5,
      generated: "2024-01-01",
      tiles: [
        {
          id: "27-36",
          row: 27,
          col: 36,
          south: 45,
          north: 50,
          west: 0,
          east: 5,
          articles: 100,
          bytes: 1000,
          hash: "abc",
        },
      ],
    };
    const tiledQuery: QueryState = {
      mode: "tiled",
      index,
      tileMap: buildTileMap(index),
      tiles: new Map(),
    };
    const state = makeState({
      phase: { phase: "loadingTiles" },
      query: tiledQuery,
      position: paris,
      loadingTiles: new Set(["27-36"]),
    });
    const tileQuery = buildQuery(mockArticles.slice(0, 5));
    const { next, effects } = transition(state, {
      type: "tileLoaded",
      id: "27-36",
      tileQuery,
      gen: 0,
    });
    expect(next.phase.phase).toBe("browsing");
    expect(next.loadingTiles.has("27-36")).toBe(false);
    if (next.query.mode === "tiled") {
      expect(next.query.tiles.has("27-36")).toBe(true);
    }
    expect(effectTypes(effects)).toContain("renderBrowsingList");
  });

  it("ignores stale generation", () => {
    const index: TileIndex = {
      version: 1,
      gridDeg: 5,
      bufferDeg: 0.5,
      generated: "2024-01-01",
      tiles: [],
    };
    const tiledQuery: QueryState = {
      mode: "tiled",
      index,
      tileMap: buildTileMap(index),
      tiles: new Map(),
    };
    const state = makeState({
      query: tiledQuery,
      loadGeneration: 2,
    });
    const tileQuery = buildQuery(mockArticles.slice(0, 5));
    const { next, effects } = transition(state, {
      type: "tileLoaded",
      id: "27-36",
      tileQuery,
      gen: 1,
    });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});
