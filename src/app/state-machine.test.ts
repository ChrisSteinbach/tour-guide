import {
  transition,
  getNearby,
  computeScrollMode,
  REQUERY_DISTANCE_M,
  INFINITE_SCROLL_INITIAL,
  INFINITE_SCROLL_STEP,
  DEFAULT_VIEWPORT_FILL,
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
    gpsSignalLost: false,
    viewportFillCount: DEFAULT_VIEWPORT_FILL,
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
    pauseReason?: "manual" | "scroll" | null;
    lastQueryPos?: UserPosition;
    positionSource?: "gps" | "picked" | null;
    scrollMode?: "infinite" | "viewport";
    infiniteScrollLimit?: number;
  } = {},
): AppState {
  const {
    articles: arts,
    nearbyCount,
    paused,
    pauseReason,
    lastQueryPos,
    scrollMode,
    infiniteScrollLimit,
    ...stateOverrides
  } = overrides;
  return makeState({
    query: sampleQuery,
    position: paris,
    phase: {
      phase: "browsing",
      articles: arts ?? defaultBrowsingArticles,
      nearbyCount: nearbyCount ?? DEFAULT_VIEWPORT_FILL,
      paused: paused ?? false,
      pauseReason: pauseReason ?? null,
      lastQueryPos: lastQueryPos ?? paris,
      scrollMode: scrollMode ?? "viewport",
      infiniteScrollLimit: infiniteScrollLimit ?? INFINITE_SCROLL_INITIAL,
    },
    ...stateOverrides,
  });
}

function effectTypes(effects: Effect[]): string[] {
  return effects.map((e) => e.type);
}

// ── DEFAULT_VIEWPORT_FILL ────────────────────────────────────

describe("DEFAULT_VIEWPORT_FILL", () => {
  it("is a positive number", () => {
    expect(DEFAULT_VIEWPORT_FILL).toBeGreaterThan(0);
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

  it("clears gpsSignalLost on successful position", () => {
    const state = browsingState({
      positionSource: "gps",
    });
    // First, simulate signal loss
    const { next: lostState } = transition(state, {
      type: "gpsError",
      error: { code: "POSITION_UNAVAILABLE", message: "Lost" },
    });
    expect(lostState.gpsSignalLost).toBe(true);
    // Then, signal recovers
    const { next } = transition(lostState, {
      type: "position",
      pos: parisNearby,
    });
    expect(next.gpsSignalLost).toBe(false);
  });

  it("triggers render in detail phase", () => {
    const state = makeState({
      query: sampleQuery,
      position: paris,
      phase: {
        phase: "detail",
        article: defaultBrowsingArticles[0],
        articles: defaultBrowsingArticles,
        nearbyCount: DEFAULT_VIEWPORT_FILL,
        paused: false,
        pauseReason: null,
        lastQueryPos: paris,
        scrollMode: "viewport",
        infiniteScrollLimit: INFINITE_SCROLL_INITIAL,
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

  it("sets gpsSignalLost while browsing with GPS source", () => {
    const state = browsingState({ positionSource: "gps" });
    const { next, effects } = transition(state, {
      type: "gpsError",
      error,
    });
    expect(next.gpsSignalLost).toBe(true);
    expect(next.phase.phase).toBe("browsing");
    expect(effectTypes(effects)).toContain("render");
  });

  it("sets gpsSignalLost while in detail with GPS source", () => {
    const state = browsingState({ positionSource: "gps" });
    const { next: detailState } = transition(state, {
      type: "selectArticle",
      article: defaultBrowsingArticles[0],
    });
    const { next, effects } = transition(detailState, {
      type: "gpsError",
      error,
    });
    expect(next.gpsSignalLost).toBe(true);
    expect(next.phase.phase).toBe("detail");
    expect(effectTypes(effects)).toContain("render");
  });

  it("ignores error while browsing with picked source", () => {
    const state = browsingState({ positionSource: "picked" });
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

// ── scrollPause event (tour-guide-54z) ──────────────────────

describe("scrollPause event", () => {
  it("auto-pauses and switches to infinite scroll mode", () => {
    const state = browsingState({ paused: false, scrollMode: "viewport" });
    const { next, effects } = transition(state, { type: "scrollPause" });
    const browsing = expectBrowsing(next);
    expect(browsing.paused).toBe(true);
    expect(browsing.pauseReason).toBe("scroll");
    expect(browsing.scrollMode).toBe("infinite");
    expect(effectTypes(effects)).toContain("requery");
    const requery = effects.find((e) => e.type === "requery");
    expect(requery).toMatchObject({ count: INFINITE_SCROLL_INITIAL });
  });

  it("no-ops when already paused", () => {
    const state = browsingState({
      paused: true,
      pauseReason: "manual",
      scrollMode: "infinite",
    });
    const { next, effects } = transition(state, { type: "scrollPause" });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it("no-ops when already in infinite scroll mode", () => {
    const state = browsingState({ scrollMode: "infinite" });
    const { next, effects } = transition(state, { type: "scrollPause" });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it("no-ops when not browsing", () => {
    const state = makeState();
    const { next, effects } = transition(state, { type: "scrollPause" });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});

// ── togglePause event (tour-guide-bli) ───────────────────────

describe("togglePause event", () => {
  it("pauses and switches to infinite scroll mode with manual reason", () => {
    const state = browsingState({ paused: false, scrollMode: "viewport" });
    const { next, effects } = transition(state, { type: "togglePause" });
    const browsing = expectBrowsing(next);
    expect(browsing.paused).toBe(true);
    expect(browsing.pauseReason).toBe("manual");
    expect(browsing.scrollMode).toBe("infinite");
    expect(effectTypes(effects)).toContain("requery");
  });

  it("unpauses and switches to viewport mode with scrollToTop and requery", () => {
    const state = browsingState({
      paused: true,
      pauseReason: "manual",
      scrollMode: "infinite",
      nearbyCount: 20,
    });
    const { next, effects } = transition(state, { type: "togglePause" });
    const browsing = expectBrowsing(next);
    expect(browsing.paused).toBe(false);
    expect(browsing.pauseReason).toBeNull();
    expect(browsing.scrollMode).toBe("viewport");
    expect(browsing.lastQueryPos).toBe(paris);
    expect(effectTypes(effects)).toContain("scrollToTop");
    expect(effectTypes(effects)).toContain("requery");
    expect(effectTypes(effects)).toContain("renderBrowsingList");
    expect(effectTypes(effects)).toContain("fetchListSummaries");
    const requery = effects.find((e) => e.type === "requery");
    expect(requery).toMatchObject({ count: 20 });
  });

  it("preserves nearbyCount through infinite mode round-trip", () => {
    const state = browsingState({
      nearbyCount: 20,
      scrollMode: "viewport",
    });
    // Pause → infinite
    const { next: paused } = transition(state, { type: "togglePause" });
    expect(expectBrowsing(paused).nearbyCount).toBe(20);
    // Unpause → viewport
    const { next: resumed } = transition(paused, { type: "togglePause" });
    expect(expectBrowsing(resumed).nearbyCount).toBe(20);
  });

  it("clears scroll pauseReason on resume", () => {
    const state = browsingState({
      paused: true,
      pauseReason: "scroll",
      scrollMode: "infinite",
    });
    const { next } = transition(state, { type: "togglePause" });
    const browsing = expectBrowsing(next);
    expect(browsing.paused).toBe(false);
    expect(browsing.pauseReason).toBeNull();
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
  it("sets positionSource to gps and switches to viewport mode from browsing", () => {
    const state = browsingState({
      positionSource: "picked",
      scrollMode: "infinite",
    });
    const { next, effects } = transition(state, { type: "useGps" });
    expect(next.positionSource).toBe("gps");
    const browsing = expectBrowsing(next);
    expect(browsing.scrollMode).toBe("viewport");
    expect(effectTypes(effects)).toContain("startGps");
    expect(effectTypes(effects)).toContain("requery");
  });

  it("does not requery when no position is known", () => {
    const state = browsingState({ positionSource: "picked" });
    const noPos = { ...state, position: null };
    const { effects } = transition(noPos, { type: "useGps" });
    expect(effectTypes(effects)).not.toContain("requery");
    expect(effectTypes(effects)).toContain("startGps");
    expect(effectTypes(effects)).toContain("renderBrowsingList");
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
        nearbyCount: DEFAULT_VIEWPORT_FILL,
        paused: false,
        pauseReason: null,
        lastQueryPos: paris,
        scrollMode: "infinite",
        infiniteScrollLimit: INFINITE_SCROLL_INITIAL,
      },
    });
    const { next, effects } = transition(state, { type: "useGps" });
    expect(next.positionSource).toBe("gps");
    expect(effectTypes(effects)).toContain("startGps");
    // Detail phase: no requery (forceRequery only works from browsing)
    expect(effectTypes(effects)).not.toContain("requery");
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
    expect(effectTypes(effects)).toContain("fetchListSummaries");
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

  it("enters dataUnavailable when index is null", () => {
    const state = makeState();
    const { next, effects } = transition(state, {
      type: "tileIndexLoaded",
      index: null,
      lang: "en",
      gen: 0,
    });
    expect(next.query.mode).toBe("none");
    expect(next.phase.phase).toBe("dataUnavailable");
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
      count: DEFAULT_VIEWPORT_FILL,
    });
    const browsing = expectBrowsing(next);
    expect(browsing.articles).toBe(newArticles);
    expect(browsing.nearbyCount).toBe(DEFAULT_VIEWPORT_FILL);
    expect(browsing.lastQueryPos).toBe(paris);
    expect(effectTypes(effects)).toContain("renderBrowsingList");
    expect(effectTypes(effects)).toContain("fetchListSummaries");
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
      count: DEFAULT_VIEWPORT_FILL,
    });
    const nextBrowsing = expectBrowsing(next);
    expect(nextBrowsing.articles).toBe(updatedArticles);
    expect(effectTypes(effects)).toContain("updateDistances");
    expect(effectTypes(effects)).not.toContain("renderBrowsingList");
    expect(effectTypes(effects)).not.toContain("fetchListSummaries");
  });

  it("updates nearbyCount and lastQueryPos", () => {
    const state = browsingState({ nearbyCount: DEFAULT_VIEWPORT_FILL });
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

// ── Map picker phase ──────────────────────────────────────────

describe("showMapPicker event", () => {
  it("transitions to mapPicker phase and pushes history", () => {
    const browsingPhase: Phase = {
      phase: "browsing",
      articles: defaultBrowsingArticles,
      nearbyCount: DEFAULT_VIEWPORT_FILL,
      paused: false,
      pauseReason: null,
      lastQueryPos: paris,
      scrollMode: "viewport",
      infiniteScrollLimit: INFINITE_SCROLL_INITIAL,
    };
    const state = makeState({ phase: browsingPhase });
    const { next, effects } = transition(state, { type: "showMapPicker" });
    expect(next.phase).toEqual({
      phase: "mapPicker",
      returnPhase: browsingPhase,
    });
    expect(effects).toContainEqual({ type: "pushHistory" });
    expect(effects).toContainEqual({ type: "showMapPicker" });
  });

  it("stores current phase as returnPhase from error", () => {
    const errorPhase: Phase = {
      phase: "error",
      error: { code: "POSITION_UNAVAILABLE", message: "No GPS" },
    };
    const state = makeState({ phase: errorPhase });
    const { next } = transition(state, { type: "showMapPicker" });
    expect(next.phase).toEqual({
      phase: "mapPicker",
      returnPhase: errorPhase,
    });
  });
});

describe("back from mapPicker", () => {
  it("restores browsing phase and renders list", () => {
    const browsingPhase: Phase = {
      phase: "browsing",
      articles: defaultBrowsingArticles,
      nearbyCount: DEFAULT_VIEWPORT_FILL,
      paused: false,
      pauseReason: null,
      lastQueryPos: paris,
      scrollMode: "viewport",
      infiniteScrollLimit: INFINITE_SCROLL_INITIAL,
    };
    const state = makeState({
      phase: { phase: "mapPicker", returnPhase: browsingPhase },
    });
    const { next, effects } = transition(state, { type: "back" });
    expect(next.phase).toEqual(browsingPhase);
    expect(effects).toContainEqual({ type: "renderBrowsingList" });
  });

  it("restores error phase and renders", () => {
    const errorPhase: Phase = {
      phase: "error",
      error: { code: "POSITION_UNAVAILABLE", message: "No GPS" },
    };
    const state = makeState({
      phase: { phase: "mapPicker", returnPhase: errorPhase },
    });
    const { next, effects } = transition(state, { type: "back" });
    expect(next.phase).toEqual(errorPhase);
    expect(effects).toContainEqual({ type: "render" });
  });
});

// ── computeScrollMode ─────────────────────────────────────────

describe("computeScrollMode", () => {
  it("returns infinite for picked position", () => {
    expect(computeScrollMode("picked", false)).toBe("infinite");
    expect(computeScrollMode("picked", true)).toBe("infinite");
  });

  it("returns infinite for GPS when paused", () => {
    expect(computeScrollMode("gps", true)).toBe("infinite");
  });

  it("returns viewport for GPS when not paused", () => {
    expect(computeScrollMode("gps", false)).toBe("viewport");
  });

  it("returns viewport for null position source", () => {
    expect(computeScrollMode(null, false)).toBe("viewport");
  });
});

// ── Scroll mode transitions (tour-guide-ove) ─────────────────

describe("scroll mode transitions", () => {
  it("pickPosition enters infinite scroll mode", () => {
    const state = makeState({ query: sampleQuery });
    const { next } = transition(state, {
      type: "pickPosition",
      position: paris,
    });
    const browsing = expectBrowsing(next);
    expect(browsing.scrollMode).toBe("infinite");
  });

  it("pickPosition requeries with INFINITE_SCROLL_INITIAL", () => {
    const state = makeState({ query: sampleQuery });
    const { effects } = transition(state, {
      type: "pickPosition",
      position: paris,
    });
    const requery = effects.find((e) => e.type === "requery");
    expect(requery).toMatchObject({ count: INFINITE_SCROLL_INITIAL });
  });

  it("GPS position enters viewport mode", () => {
    const state = makeState({
      phase: { phase: "locating" },
      query: sampleQuery,
    });
    const { next } = transition(state, { type: "position", pos: paris });
    const browsing = expectBrowsing(next);
    expect(browsing.scrollMode).toBe("viewport");
  });

  it("scrollMode preserved through selectArticle → back round-trip", () => {
    const state = browsingState({ scrollMode: "infinite" });
    const article = expectBrowsing(state).articles[0];
    const { next: detail } = transition(state, {
      type: "selectArticle",
      article,
    });
    expect(expectDetail(detail).scrollMode).toBe("infinite");
    const { next: restored } = transition(detail, { type: "back" });
    expect(expectBrowsing(restored).scrollMode).toBe("infinite");
  });

  it("queryResult preserves nearbyCount in infinite mode", () => {
    const state = browsingState({
      scrollMode: "infinite",
      nearbyCount: 50,
    });
    const newArticles: NearbyArticle[] = [
      { title: "New Place", lat: 48.86, lon: 2.35, distanceM: 100 },
    ];
    const { next } = transition(state, {
      type: "queryResult",
      articles: newArticles,
      queryPos: paris,
      count: INFINITE_SCROLL_INITIAL,
    });
    // nearbyCount should stay at 50 (the tier value), not INFINITE_SCROLL_INITIAL
    expect(expectBrowsing(next).nearbyCount).toBe(50);
  });

  it("queryResult skips fetchListSummaries in infinite mode", () => {
    const state = browsingState({ scrollMode: "infinite" });
    const newArticles: NearbyArticle[] = [
      { title: "New Place", lat: 48.86, lon: 2.35, distanceM: 100 },
    ];
    const { effects } = transition(state, {
      type: "queryResult",
      articles: newArticles,
      queryPos: paris,
      count: INFINITE_SCROLL_INITIAL,
    });
    expect(effectTypes(effects)).toContain("renderBrowsingList");
    expect(effectTypes(effects)).not.toContain("fetchListSummaries");
  });

  it("forceRequery uses infiniteScrollLimit in infinite mode", () => {
    const state = browsingState({
      scrollMode: "infinite",
      nearbyCount: 20,
      infiniteScrollLimit: 600,
      lastQueryPos: paris,
    });
    // Move far enough to trigger requery
    const { effects } = transition(state, {
      type: "position",
      pos: parisNearby,
    });
    const requery = effects.find((e) => e.type === "requery");
    expect(requery).toBeDefined();
    expect(requery).toMatchObject({ count: 600 });
  });

  it("useGps from infinite switches to viewport and requeries", () => {
    const state = browsingState({
      positionSource: "picked",
      scrollMode: "infinite",
      nearbyCount: 20,
    });
    const { next, effects } = transition(state, { type: "useGps" });
    expect(next.positionSource).toBe("gps");
    const browsing = expectBrowsing(next);
    expect(browsing.scrollMode).toBe("viewport");
    const requery = effects.find((e) => e.type === "requery");
    expect(requery).toMatchObject({ count: 20 });
  });
});

// ── expandInfiniteScroll event ──────────────────────────────

describe("expandInfiniteScroll event", () => {
  it("expands limit by STEP and requeries", () => {
    const state = browsingState({
      scrollMode: "infinite",
      infiniteScrollLimit: INFINITE_SCROLL_INITIAL,
    });
    const { next, effects } = transition(state, {
      type: "expandInfiniteScroll",
    });
    const browsing = expectBrowsing(next);
    expect(browsing.infiniteScrollLimit).toBe(
      INFINITE_SCROLL_INITIAL + INFINITE_SCROLL_STEP,
    );
    const requery = effects.find((e) => e.type === "requery");
    expect(requery).toMatchObject({
      count: INFINITE_SCROLL_INITIAL + INFINITE_SCROLL_STEP,
    });
  });

  it("no-ops in viewport mode", () => {
    const state = browsingState({ scrollMode: "viewport" });
    const { next, effects } = transition(state, {
      type: "expandInfiniteScroll",
    });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it("no-ops when not browsing", () => {
    const state = makeState();
    const { next, effects } = transition(state, {
      type: "expandInfiniteScroll",
    });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it("infiniteScrollLimit preserved through detail round-trip", () => {
    const state = browsingState({
      scrollMode: "infinite",
      infiniteScrollLimit: 600,
    });
    const { next: detail } = transition(state, {
      type: "selectArticle",
      article: defaultBrowsingArticles[0],
    });
    expect(detail.phase.phase).toBe("detail");
    const { next: back } = transition(detail, { type: "back" });
    expect(expectBrowsing(back).infiniteScrollLimit).toBe(600);
  });
});
