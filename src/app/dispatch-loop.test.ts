import {
  transition,
  INFINITE_SCROLL_INITIAL,
  DEFAULT_VIEWPORT_FILL,
  type AppState,
  type Event,
  type Phase,
  type QueryState,
} from "./state-machine";
import {
  createEffectExecutor,
  type EffectDeps,
  type RenderDeps,
  type DataDeps,
} from "./effect-executor";
import type { NearbyArticle, UserPosition } from "./types";
import type { SummaryLoader } from "./summary-loader";
import type { TileEntry } from "../tiles";
import { GRID_DEG } from "../tiles";
import { NearestQuery } from "./query";
import { buildTileMap } from "./tile-loader";

// ── Helpers ─────────────────────────────────────────────────

const stubNearestQuery = new NearestQuery(
  {
    vertexPoints: new Float64Array(0),
    vertexTriangles: new Uint32Array(0),
    triangleVertices: new Uint32Array(0),
    triangleNeighbors: new Uint32Array(0),
  },
  [],
);

const paris: UserPosition = { lat: 48.8584, lon: 2.2945 };
const tokyo: UserPosition = { lat: 35.6762, lon: 139.6503 };

function makeTileIndex(tileIds: string[]) {
  return {
    version: 1 as const,
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

function makeTiledQuery(tileIds: string[]): QueryState {
  const index = makeTileIndex(tileIds);
  return {
    mode: "tiled",
    index,
    tileMap: buildTileMap(index),
    tiles: new Map(),
  };
}

function makeUi(): RenderDeps {
  return {
    render: vi.fn(),
    renderBrowsingList: vi.fn(),
    renderBrowsingHeader: vi.fn(),
    updateDistances: vi.fn(),
    showAbout: vi.fn(),
    hideAbout: vi.fn(),
    renderDetailLoading: vi.fn(),
    renderDetailReady: vi.fn(),
    renderDetailError: vi.fn(),
    renderAppUpdateBanner: vi.fn(),
    showMapPicker: vi.fn(),
    scrollToTop: vi.fn(),
    restoreScrollTop: vi.fn(),
  };
}

function makeData(overrides: Partial<DataDeps> = {}): DataDeps {
  return {
    loadTileIndex: vi.fn(async () => null),
    loadTile: vi.fn(async () => stubNearestQuery),
    tilesForPosition: vi.fn(() => ({ primary: "t1", adjacent: [] })),
    getTileEntry: vi.fn(),
    nearestExistingTiles: vi.fn(() => []),
    ...overrides,
  };
}

/**
 * Wire the real transition() and createEffectExecutor() into a dispatch
 * loop identical to main.ts:51-57. Only I/O boundaries are mocked.
 */
function buildDispatchLoop(opts: {
  tileIds: string[];
  getNearby?: EffectDeps["getNearby"];
  data?: Partial<DataDeps>;
}) {
  const query = makeTiledQuery(opts.tileIds);
  const tileMap = (query as Extract<QueryState, { mode: "tiled" }>).tileMap;

  let appState: AppState = {
    phase: { phase: "welcome" },
    query,
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
    aboutOpen: false,
  };

  const ui = makeUi();
  const data = makeData({
    getTileEntry: vi.fn((_map: Map<string, TileEntry>, id: string) =>
      tileMap.get(id),
    ),
    ...opts.data,
  });

  function dispatch(event: Event): void {
    const { next, effects } = transition(appState, event);
    appState = next;
    for (const effect of effects) {
      executeEffect(effect);
    }
  }

  const executeEffect = createEffectExecutor({
    getState: () => appState,
    dispatch,
    watchLocation: vi.fn(() => vi.fn()),
    pushState: vi.fn(),
    fetchArticleSummary: vi.fn(async () => ({
      title: "",
      extract: "",
      description: "",
      thumbnailUrl: null,
      thumbnailWidth: null,
      thumbnailHeight: null,
      pageUrl: "",
    })),
    getNearby: opts.getNearby ?? vi.fn(() => []),
    summaryLoader: {
      load: vi.fn(),
      request: vi.fn(),
      get: vi.fn(),
      cancel: vi.fn(),
    } satisfies SummaryLoader,
    ui,
    data,
    storage: { setItem: vi.fn() },
  });

  return { dispatch, getState: () => appState, ui, data };
}

function expectBrowsing(state: AppState) {
  expect(state.phase.phase).toBe("browsing");
  return state.phase as Extract<Phase, { phase: "browsing" }>;
}

// ── Tests ───────────────────────────────────────────────────

describe("dispatch loop: pickPosition round-trip", () => {
  it("pickPosition → tileLoaded → browsing with infinite scroll", async () => {
    const { dispatch, getState, ui } = buildDispatchLoop({
      tileIds: ["27-36"],
      data: {
        tilesForPosition: vi.fn(() => ({ primary: "27-36", adjacent: [] })),
      },
    });

    dispatch({ type: "pickPosition", position: paris });

    // Synchronous: should be in loadingTiles with cleared state
    expect(getState().phase.phase).toBe("loadingTiles");
    expect(getState().loadGeneration).toBe(1);
    expect(getState().position).toEqual(paris);
    expect(getState().positionSource).toBe("picked");

    const tiled = getState().query as Extract<QueryState, { mode: "tiled" }>;
    expect(tiled.tiles.size).toBe(0);

    // Wait for async tile load to complete and flow back through dispatch
    await vi.waitFor(() => {
      expect(getState().phase.phase).toBe("browsing");
    });

    const browsing = expectBrowsing(getState());
    expect(browsing.scrollMode).toBe("infinite");
    expect(browsing.infiniteScrollLimit).toBe(INFINITE_SCROLL_INITIAL);
    expect(ui.scrollToTop).toHaveBeenCalled();
  });

  it("re-pick during loading drops stale tile data from first position", async () => {
    type Resolver = (q: NearestQuery) => void;
    const resolvers: Resolver[] = [];

    const { dispatch, getState } = buildDispatchLoop({
      tileIds: ["27-36", "25-64"],
      data: {
        tilesForPosition: vi.fn(
          (_map: Map<string, TileEntry>, _lat: number, _lon: number) => {
            // Return different tiles based on call order
            if (resolvers.length === 0) {
              return { primary: "27-36", adjacent: [] };
            }
            return { primary: "25-64", adjacent: [] };
          },
        ),
        loadTile: vi.fn(
          () =>
            new Promise<NearestQuery>((resolve) => {
              resolvers.push(resolve);
            }),
        ),
      },
    });

    // First pick — starts loading tile "27-36"
    dispatch({ type: "pickPosition", position: paris });
    expect(getState().loadGeneration).toBe(1);
    expect(getState().phase.phase).toBe("loadingTiles");

    // Second pick before first tile resolves — bumps generation, aborts first
    dispatch({ type: "pickPosition", position: tokyo });
    expect(getState().loadGeneration).toBe(2);
    expect(getState().position).toEqual(tokyo);

    // Resolve first (stale) tile — should be silently dropped
    resolvers[0](stubNearestQuery);
    await vi.waitFor(() => {
      // The stale tile should not have entered state
      const q = getState().query as Extract<QueryState, { mode: "tiled" }>;
      expect(q.tiles.has("27-36")).toBe(false);
    });
    // Still in loadingTiles — stale tile was ignored
    expect(getState().phase.phase).toBe("loadingTiles");

    // Resolve second (current) tile — should enter browsing
    resolvers[1](stubNearestQuery);
    await vi.waitFor(() => {
      expect(getState().phase.phase).toBe("browsing");
    });

    expect(getState().position).toEqual(tokyo);
    const q = getState().query as Extract<QueryState, { mode: "tiled" }>;
    expect(q.tiles.has("25-64")).toBe(true);
    expect(q.tiles.has("27-36")).toBe(false);
  });

  it("primary tile enters browsing, adjacent tile triggers requery", async () => {
    let loadCount = 0;
    type Resolver = (q: NearestQuery) => void;
    const resolvers: Resolver[] = [];

    const getNearby = vi.fn(() => [] as NearbyArticle[]);
    const { dispatch, getState } = buildDispatchLoop({
      tileIds: ["27-36", "27-37"],
      getNearby,
      data: {
        tilesForPosition: vi.fn(() => ({
          primary: "27-36",
          adjacent: ["27-37"],
        })),
        loadTile: vi.fn(
          () =>
            new Promise<NearestQuery>((resolve) => {
              loadCount++;
              resolvers.push(resolve);
            }),
        ),
      },
    });

    dispatch({ type: "pickPosition", position: paris });
    expect(getState().phase.phase).toBe("loadingTiles");

    // Primary tile resolves — triggers enterBrowsing
    resolvers[0](stubNearestQuery);
    await vi.waitFor(() => {
      expect(getState().phase.phase).toBe("browsing");
    });

    // Adjacent tile should have started loading after primary
    await vi.waitFor(() => {
      expect(loadCount).toBe(2);
    });

    const callsBefore = getNearby.mock.calls.length;

    // Resolve adjacent tile — triggers forceRequery (another requery)
    resolvers[1](stubNearestQuery);
    await vi.waitFor(() => {
      expect(getNearby).toHaveBeenCalledTimes(callsBefore + 1);
    });

    const q = getState().query as Extract<QueryState, { mode: "tiled" }>;
    expect(q.tiles.has("27-36")).toBe(true);
    expect(q.tiles.has("27-37")).toBe(true);
  });
});
