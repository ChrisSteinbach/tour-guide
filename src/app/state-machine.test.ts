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
import { GRID_DEG, type TileIndex, type TileEntry } from "../tiles";
import { buildTileMap } from "./tile-loader";
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
    positionSource: null,
    currentLang: "en",
    loadGeneration: 0,
    loadingTiles: new Set(),
    downloadProgress: -1,
    updateBanner: null,
    hasGeolocation: true,
    ...overrides,
  };
}

const paris: UserPosition = { lat: 48.8584, lon: 2.2945 };
const parisNearby: UserPosition = { lat: 48.8586, lon: 2.2948 }; // ~25m away
const parisSame: UserPosition = { lat: 48.85841, lon: 2.29451 }; // ~1m away

/** Stub NearestQuery — satisfies the type without running real geometry. */
const stubNearestQuery = {} as NearestQuery;

/** Pre-built articles for browsing state, no geometry required. */
const defaultBrowsingArticles: NearbyArticle[] = [
  { title: "Eiffel Tower", lat: 48.8584, lon: 2.2945, distanceM: 50 },
  { title: "Champ de Mars", lat: 48.856, lon: 2.2983, distanceM: 100 },
  { title: "Palais de Chaillot", lat: 48.8627, lon: 2.2876, distanceM: 150 },
];

/** Build a default TileIndex from tile IDs (defaults to ["27-36"]). */
function makeTileIndex(tileIds: string[] = ["27-36"]): TileIndex {
  return {
    version: 1,
    gridDeg: GRID_DEG,
    bufferDeg: 0.5,
    generated: "2024-01-01",
    tiles: tileIds.map((id) => {
      const [rowStr, colStr] = id.split("-");
      const row = parseInt(rowStr, 10);
      const col = parseInt(colStr, 10);
      return {
        id,
        row,
        col,
        south: row * GRID_DEG - 90,
        north: row * GRID_DEG - 90 + GRID_DEG,
        west: col * GRID_DEG - 180,
        east: col * GRID_DEG - 180 + GRID_DEG,
        articles: 100,
        bytes: 1000,
        hash: "abc",
      } satisfies TileEntry;
    }),
  };
}

/** Build a tiled QueryState from tile IDs (defaults to ["27-36"]). */
function makeTiledQuery(tileIds: string[] = ["27-36"]): QueryState {
  const index = makeTileIndex(tileIds);
  return {
    mode: "tiled",
    index,
    tileMap: buildTileMap(index),
    tiles: new Map(),
  };
}

const sampleIndex = makeTileIndex();
const sampleQuery: QueryState = {
  mode: "tiled",
  index: sampleIndex,
  tileMap: buildTileMap(sampleIndex),
  tiles: new Map([["27-36", stubNearestQuery]]),
};

/** Assert phase is "browsing" and return the narrowed type. */
function expectBrowsing(state: AppState) {
  expect(state.phase.phase).toBe("browsing");
  return state.phase as Extract<Phase, { phase: "browsing" }>;
}

/** Assert phase is "detail" and return the narrowed type. */
function expectDetail(state: AppState) {
  expect(state.phase.phase).toBe("detail");
  return state.phase as Extract<Phase, { phase: "detail" }>;
}

function browsingState(
  overrides: Partial<AppState> & {
    articles?: NearbyArticle[];
    nearbyCount?: number;
    paused?: boolean;
    lastQueryPos?: UserPosition;
    positionSource?: "gps" | "picked" | null;
  } = {},
): AppState {
  const {
    articles: arts,
    nearbyCount,
    paused,
    lastQueryPos,
    ...stateOverrides
  } = overrides;
  return makeState({
    query: sampleQuery,
    position: paris,
    phase: {
      phase: "browsing",
      articles: arts ?? defaultBrowsingArticles,
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
  const testArticles = [
    { title: "Eiffel Tower", lat: 48.8584, lon: 2.2945 },
    { title: "Champ de Mars", lat: 48.856, lon: 2.2983 },
    { title: "Palais de Chaillot", lat: 48.8627, lon: 2.2876 },
    { title: "Pont d'Iéna", lat: 48.8608, lon: 2.2935 },
    { title: "Musée du quai Branly", lat: 48.8611, lon: 2.2978 },
    { title: "Les Invalides", lat: 48.8567, lon: 2.3125 },
  ];

  /** Build a real NearestQuery for integration testing. */
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

  const realSampleQuery: QueryState = {
    mode: "tiled",
    index: sampleIndex,
    tileMap: buildTileMap(sampleIndex),
    tiles: new Map([["27-36", buildQuery(testArticles)]]),
  };

  it("returns articles sorted by distance from tiled query", () => {
    const articles = getNearby(realSampleQuery, paris, 5);
    expect(articles).toHaveLength(5);
    for (let i = 1; i < articles.length; i++) {
      expect(articles[i].distanceM).toBeGreaterThanOrEqual(
        articles[i - 1].distanceM,
      );
    }
  });

  it("returns empty array when query mode is none", () => {
    const articles = getNearby({ mode: "none" }, paris, 10);
    expect(articles).toEqual([]);
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
    expect(effectTypes(effects)).toContain("requery");
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

  it("enters downloading when no geolocation and no query", () => {
    const state = makeState();
    const { next, effects } = transition(state, {
      type: "start",
      hasGeolocation: false,
    });
    expect(next.phase.phase).toBe("downloading");
    expect(next.hasGeolocation).toBe(false);
    expect(effectTypes(effects)).toContain("storeStarted");
    expect(effectTypes(effects)).not.toContain("startGps");
    expect(effectTypes(effects)).toContain("render");
    expect(effectTypes(effects)).not.toContain("stopGps");
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

// ── pickPosition event (tour-guide-fed) ──────────────────────

describe("pickPosition event", () => {
  const pickedPos: UserPosition = { lat: 48.8584, lon: 2.2945 };

  it("enters browsing with picked position when query ready", () => {
    const state = makeState({ query: sampleQuery });
    const { next, effects } = transition(state, {
      type: "pickPosition",
      position: pickedPos,
    });
    expect(next.phase.phase).toBe("browsing");
    expect(next.position).toBe(pickedPos);
    expect(effectTypes(effects)).toContain("stopGps");
    expect(effectTypes(effects)).toContain("requery");
  });

  it("enters downloading when no query", () => {
    const state = makeState();
    const { next, effects } = transition(state, {
      type: "pickPosition",
      position: pickedPos,
    });
    expect(next.phase.phase).toBe("downloading");
    expect(next.position).toBe(pickedPos);
    expect(effectTypes(effects)).toContain("stopGps");
    expect(effectTypes(effects)).toContain("render");
  });

  it("triggers loadTiles for tiled query", () => {
    const tiledQuery = makeTiledQuery();
    const state = makeState({ query: tiledQuery });
    const { effects } = transition(state, {
      type: "pickPosition",
      position: pickedPos,
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
    expect(effectTypes(effects)).toContain("requery");
  });

  it("enters loadingTiles from locating when tiled query with no tiles", () => {
    const tiledQuery = makeTiledQuery();
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
    expect(effectTypes(effects)).toContain("requery");
  });

  it("does not requery when moved less than 15m", () => {
    const state = browsingState({ lastQueryPos: paris });
    const { next, effects } = transition(state, {
      type: "position",
      pos: parisSame,
    });
    expect(next.position).toEqual(parisSame);
    expect(effectTypes(effects)).not.toContain("requery");
  });

  it("does not requery when paused", () => {
    const state = browsingState({ lastQueryPos: paris, paused: true });
    const { next, effects } = transition(state, {
      type: "position",
      pos: parisNearby,
    });
    expect(next.position).toEqual(parisNearby);
    expect(effectTypes(effects)).not.toContain("requery");
  });

  it("triggers render in detail phase", () => {
    const state = makeState({
      query: sampleQuery,
      position: paris,
      phase: {
        phase: "detail",
        article: defaultBrowsingArticles[0],
        articles: defaultBrowsingArticles,
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
    const browsing = expectBrowsing(next);
    expect(browsing.nearbyCount).toBe(20);
    expect(effectTypes(effects)).toContain("requery");
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
    const browsing = expectBrowsing(next);
    expect(browsing.paused).toBe(true);
    expect(effectTypes(effects)).toContain("renderBrowsingList");
  });

  it("unpauses and requeries at current position", () => {
    const state = browsingState({ paused: true });
    const { next, effects } = transition(state, { type: "togglePause" });
    const browsing = expectBrowsing(next);
    expect(browsing.paused).toBe(false);
    expect(browsing.lastQueryPos).toBe(paris);
    expect(effectTypes(effects)).toContain("requery");
  });

  it("no-ops when not browsing", () => {
    const state = makeState();
    const { next, effects } = transition(state, { type: "togglePause" });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});

// ── positionSource tracking ───────────────────────────────────

describe("positionSource tracking", () => {
  it("pickPosition sets positionSource to picked", () => {
    const state = makeState({ query: sampleQuery });
    const { next } = transition(state, {
      type: "pickPosition",
      position: paris,
    });
    expect(next.positionSource).toBe("picked");
  });

  it("position event sets positionSource to gps", () => {
    const state = makeState();
    const { next } = transition(state, { type: "position", pos: paris });
    expect(next.positionSource).toBe("gps");
  });

  it("positionSource defaults to null", () => {
    const state = makeState();
    expect(state.positionSource).toBeNull();
  });
});

// ── useGps event ─────────────────────────────────────────────

describe("useGps event", () => {
  it("sets positionSource to gps and emits startGps from browsing", () => {
    const state = browsingState({ positionSource: "picked" });
    const { next, effects } = transition(state, { type: "useGps" });
    expect(next.positionSource).toBe("gps");
    expect(effectTypes(effects)).toContain("startGps");
  });

  it("works from detail phase", () => {
    const state = makeState({
      query: sampleQuery,
      position: paris,
      positionSource: "picked",
      phase: {
        phase: "detail",
        article: defaultBrowsingArticles[0],
        articles: defaultBrowsingArticles,
        nearbyCount: 10,
        paused: false,
        lastQueryPos: paris,
      },
    });
    const { next, effects } = transition(state, { type: "useGps" });
    expect(next.positionSource).toBe("gps");
    expect(effectTypes(effects)).toContain("startGps");
  });

  it("no-ops when not browsing or detail", () => {
    const state = makeState({ phase: { phase: "locating" } });
    const { next, effects } = transition(state, { type: "useGps" });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});

// ── selectArticle event (tour-guide-2cd) ─────────────────────

describe("selectArticle event", () => {
  it("transitions from browsing to detail", () => {
    const state = browsingState();
    const article = expectBrowsing(state).articles[0];
    const { next, effects } = transition(state, {
      type: "selectArticle",
      article,
    });
    const detail = expectDetail(next);
    expect(detail.article).toBe(article);
    expect(effectTypes(effects)).toContain("pushHistory");
    expect(effectTypes(effects)).toContain("fetchSummary");
  });

  it("preserves browsing context in detail state", () => {
    const state = browsingState({ nearbyCount: 20, paused: true });
    const browsing = expectBrowsing(state);
    const { next } = transition(state, {
      type: "selectArticle",
      article: browsing.articles[0],
    });
    const detail = expectDetail(next);
    expect(detail.articles).toBe(browsing.articles);
    expect(detail.nearbyCount).toBe(20);
    expect(detail.paused).toBe(true);
    expect(detail.lastQueryPos).toBe(browsing.lastQueryPos);
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
    const browsing = expectBrowsing(state);
    const { next: detail } = transition(state, {
      type: "selectArticle",
      article: browsing.articles[0],
    });
    const { next: restored, effects } = transition(detail, { type: "back" });
    const restoredBrowsing = expectBrowsing(restored);
    expect(restoredBrowsing.articles).toBe(browsing.articles);
    expect(restoredBrowsing.nearbyCount).toBe(20);
    expect(restoredBrowsing.paused).toBe(true);
    expect(effectTypes(effects)).toContain("renderBrowsingList");
  });

  it("no-ops when not in detail", () => {
    const state = makeState();
    const { next, effects } = transition(state, { type: "back" });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});

// ── swUpdateAvailable event (tour-guide-2lw) ─────────────

describe("swUpdateAvailable event", () => {
  it("sets updateBanner and emits showAppUpdateBanner", () => {
    const state = makeState();
    const { next, effects } = transition(state, {
      type: "swUpdateAvailable",
    });
    expect(next.updateBanner).toBe("app");
    expect(effectTypes(effects)).toContain("showAppUpdateBanner");
  });

  it("no-ops when app update banner already showing", () => {
    const state = makeState({ updateBanner: "app" });
    const { next, effects } = transition(state, {
      type: "swUpdateAvailable",
    });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it("works in any phase", () => {
    const state = browsingState();
    const { next, effects } = transition(state, {
      type: "swUpdateAvailable",
    });
    expect(next.updateBanner).toBe("app");
    expect(next.phase.phase).toBe("browsing");
    expect(effectTypes(effects)).toContain("showAppUpdateBanner");
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
  const tileIndex = makeTileIndex();

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

  it("enters dataUnavailable with log when index is null", () => {
    const state = makeState();
    const { next, effects } = transition(state, {
      type: "tileIndexLoaded",
      index: null,
      lang: "en",
      gen: 0,
    });
    expect(next.query.mode).toBe("none");
    expect(next.phase.phase).toBe("dataUnavailable");
    expect(effectTypes(effects)).toContain("log");
    expect(effectTypes(effects)).toContain("render");
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

  it("enters error when downloading with no position and no geolocation", () => {
    const state = makeState({
      phase: { phase: "downloading", progress: 0 },
      hasGeolocation: false,
    });
    const { next, effects } = transition(state, {
      type: "tileIndexLoaded",
      index: tileIndex,
      lang: "en",
      gen: 0,
    });
    expect(next.phase.phase).toBe("error");
    if (next.phase.phase === "error") {
      expect(next.phase.error.code).toBe("POSITION_UNAVAILABLE");
    }
    expect(effectTypes(effects)).toContain("render");
  });
});

// ── tileLoaded event (tour-guide-8y4) ────────────────────────

describe("tileLoaded event", () => {
  it("enters browsing from loadingTiles when first tile arrives", () => {
    const tiledQuery = makeTiledQuery();
    const state = makeState({
      phase: { phase: "loadingTiles" },
      query: tiledQuery,
      position: paris,
      loadingTiles: new Set(["27-36"]),
    });
    const tileQuery = stubNearestQuery;
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
    expect(effectTypes(effects)).toContain("requery");
  });

  it("ignores stale generation", () => {
    const tiledQuery = makeTiledQuery([]);
    const state = makeState({
      query: tiledQuery,
      loadGeneration: 2,
    });
    const tileQuery = stubNearestQuery;
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

// ── queryResult event ────────────────────────────────────

describe("queryResult event", () => {
  it("renders list when articles change", () => {
    const state = browsingState();
    const newArticles: NearbyArticle[] = [
      { title: "New Place", lat: 48.86, lon: 2.35, distanceM: 100 },
    ];
    const { next, effects } = transition(state, {
      type: "queryResult",
      articles: newArticles,
      queryPos: paris,
      count: 10,
    });
    const browsing = expectBrowsing(next);
    expect(browsing.articles).toBe(newArticles);
    expect(browsing.nearbyCount).toBe(10);
    expect(browsing.lastQueryPos).toBe(paris);
    expect(effectTypes(effects)).toContain("renderBrowsingList");
    expect(effectTypes(effects)).not.toContain("updateDistances");
  });

  it("updates distances when article titles unchanged", () => {
    const state = browsingState();
    const browsing = expectBrowsing(state);
    const updatedArticles = browsing.articles.map((a) => ({
      ...a,
      distanceM: a.distanceM + 1,
    }));
    const { next, effects } = transition(state, {
      type: "queryResult",
      articles: updatedArticles,
      queryPos: paris,
      count: 10,
    });
    const nextBrowsing = expectBrowsing(next);
    expect(nextBrowsing.articles).toBe(updatedArticles);
    expect(effectTypes(effects)).toContain("updateDistances");
    expect(effectTypes(effects)).not.toContain("renderBrowsingList");
  });

  it("updates nearbyCount and lastQueryPos", () => {
    const state = browsingState({ nearbyCount: 10 });
    const newPos: UserPosition = { lat: 48.86, lon: 2.3 };
    const browsing = expectBrowsing(state);
    const { next } = transition(state, {
      type: "queryResult",
      articles: browsing.articles,
      queryPos: newPos,
      count: 20,
    });
    const nextBrowsing = expectBrowsing(next);
    expect(nextBrowsing.nearbyCount).toBe(20);
    expect(nextBrowsing.lastQueryPos).toBe(newPos);
  });

  it("ignores when not in browsing phase", () => {
    const state = makeState({ phase: { phase: "locating" } });
    const articles: NearbyArticle[] = [
      { title: "Test", lat: 0, lon: 0, distanceM: 0 },
    ];
    const { next, effects } = transition(state, {
      type: "queryResult",
      articles,
      queryPos: paris,
      count: 10,
    });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});
