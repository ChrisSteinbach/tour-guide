// Pure state machine for the app — no DOM, no I/O, no side effects.
// transition(state, event) → { next, effects }

import type { NearbyArticle, UserPosition } from "./types";
import type { LocationError } from "./location";
import type { NearestQuery } from "./query";
import { findNearestTiled, buildTileMap } from "./tile-loader";
import type { TileIndex, TileEntry } from "../tiles";
import type { Lang } from "../lang";
import { distanceMeters, distanceBetweenPositions } from "./format";
import { mockArticles } from "./mock-data";

// ── Constants ────────────────────────────────────────────────

export const NEARBY_TIERS = [10, 20, 50, 100];
export const REQUERY_DISTANCE_M = 15;

// ── Helpers ──────────────────────────────────────────────────

export function getNextTier(nearbyCount: number): number | undefined {
  const idx = NEARBY_TIERS.indexOf(nearbyCount);
  return idx >= 0 && idx < NEARBY_TIERS.length - 1
    ? NEARBY_TIERS[idx + 1]
    : undefined;
}

// ── Query state (discriminated union — all query state is visible) ──

export type QueryState =
  | { mode: "none" }
  | {
      mode: "tiled";
      index: TileIndex;
      tileMap: Map<string, TileEntry>;
      tiles: ReadonlyMap<string, NearestQuery>;
    };

/** Compute nearby articles using the current query state. */
export function getNearby(
  queryState: QueryState,
  pos: UserPosition,
  count: number,
): { articles: NearbyArticle[]; query: QueryState } {
  switch (queryState.mode) {
    case "tiled":
      return {
        articles: findNearestTiled(queryState.tiles, pos.lat, pos.lon, count),
        query: queryState,
      };
    case "none":
      return {
        articles: mockArticles
          .map((a) => ({ ...a, distanceM: distanceMeters(pos, a) }))
          .sort((a, b) => a.distanceM - b.distanceM),
        query: queryState,
      };
  }
}

// ── Phase (discriminated union for the UI state) ─────────────

export type Phase =
  | { phase: "welcome" }
  | { phase: "downloading"; progress: number }
  | { phase: "locating" }
  | { phase: "loadingTiles" }
  | { phase: "error"; error: LocationError }
  | {
      phase: "browsing";
      articles: NearbyArticle[];
      nearbyCount: number;
      paused: boolean;
      lastQueryPos: UserPosition;
    }
  | {
      phase: "detail";
      article: NearbyArticle;
      articles: NearbyArticle[];
      nearbyCount: number;
      paused: boolean;
      lastQueryPos: UserPosition;
    };

// ── AppState ─────────────────────────────────────────────────

export interface AppState {
  phase: Phase;
  query: QueryState;
  position: UserPosition | null;
  currentLang: Lang;
  loadGeneration: number;
  loadingTiles: Set<string>;
  downloadProgress: number;
  pendingUpdate: { serverHash: string; lang: Lang } | null;
  updateDownloading: boolean;
  updateProgress: number;
}

// ── Event (all inputs to the state machine) ──────────────────

export type Event =
  | { type: "start"; hasGeolocation: boolean }
  | { type: "useMockData"; mockPosition: UserPosition }
  | { type: "position"; pos: UserPosition }
  | { type: "gpsError"; error: LocationError }
  | { type: "tileLoadStarted"; id: string }
  | { type: "updateProgress"; fraction: number }
  | { type: "updateAvailable"; serverHash: string; lang: Lang }
  | {
      type: "tileIndexLoaded";
      index: TileIndex | null;
      lang: Lang;
      gen: number;
    }
  | { type: "tileLoaded"; id: string; tileQuery: NearestQuery; gen: number }
  | { type: "downloadProgress"; fraction: number; gen: number }
  | { type: "langChanged"; lang: Lang }
  | { type: "selectArticle"; article: NearbyArticle }
  | { type: "back" }
  | { type: "showMore" }
  | { type: "togglePause" }
  | { type: "acceptUpdate" }
  | { type: "declineUpdate" }
  | {
      type: "updateDownloaded";
      query: NearestQuery;
      lang: Lang;
    }
  | { type: "updateFailed" };

// ── Effect (all side effects the machine requests) ───────────

export type Effect =
  | { type: "render" }
  | { type: "renderBrowsingList" }
  | { type: "updateDistances" }
  | { type: "startGps" }
  | { type: "stopGps" }
  | { type: "storeLang"; lang: Lang }
  | { type: "storeStarted" }
  | { type: "loadData"; lang: Lang }
  | { type: "loadTiles"; lang: Lang }
  | { type: "loadUpdate"; serverHash: string; lang: Lang }
  | { type: "dismissUpdate"; cacheKey: string; serverHash: string }
  | { type: "pushHistory" }
  | { type: "fetchSummary"; article: NearbyArticle }
  | { type: "showUpdateBanner" }
  | { type: "removeUpdateBanner" }
  | { type: "showAppUpdateBanner" }
  | { type: "checkForUpdate"; lang: Lang }
  | { type: "log"; message: string };

// ── Internal helpers ─────────────────────────────────────────

type TransitionResult = { next: AppState; effects: Effect[] };

/** Enter browsing (or loadingTiles if tiled with no tiles yet). */
function enterBrowsing(state: AppState): TransitionResult {
  if (!state.position) return { next: state, effects: [] };
  if (state.query.mode === "tiled" && state.query.tiles.size === 0) {
    return {
      next: { ...state, phase: { phase: "loadingTiles" } },
      effects: [{ type: "render" }],
    };
  }
  const count =
    state.phase.phase === "browsing"
      ? state.phase.nearbyCount
      : NEARBY_TIERS[0];
  const { articles, query } = getNearby(state.query, state.position, count);
  return {
    next: {
      ...state,
      query,
      phase: {
        phase: "browsing",
        articles,
        nearbyCount: count,
        paused: false,
        lastQueryPos: state.position,
      },
    },
    effects: [{ type: "renderBrowsingList" }],
  };
}

/** Requery at current position — used by position updates. */
function forceRequery(state: AppState): TransitionResult {
  if (state.phase.phase !== "browsing" || !state.position) {
    return { next: state, effects: [] };
  }
  const p = state.phase;
  const { articles, query } = getNearby(
    state.query,
    state.position,
    p.nearbyCount,
  );
  const same =
    articles.length === p.articles.length &&
    articles.every((a, i) => a.title === p.articles[i].title);
  const next: AppState = {
    ...state,
    query,
    phase: {
      phase: "browsing",
      nearbyCount: p.nearbyCount,
      paused: p.paused,
      articles,
      lastQueryPos: state.position,
    },
  };
  if (same) {
    return { next, effects: [{ type: "updateDistances" }] };
  }
  return { next, effects: [{ type: "renderBrowsingList" }] };
}

// ── Transition function ──────────────────────────────────────

export function transition(state: AppState, event: Event): TransitionResult {
  switch (event.type) {
    // ── Core lifecycle (tour-guide-fed) ──────────────────────

    case "start": {
      const effects: Effect[] = [{ type: "storeStarted" }];
      if (event.hasGeolocation) effects.push({ type: "startGps" });

      if (state.query.mode !== "none") {
        if (state.position) {
          const result = enterBrowsing(state);
          return {
            next: result.next,
            effects: [...effects, ...result.effects],
          };
        }
        return {
          next: { ...state, phase: { phase: "locating" } },
          effects: [...effects, { type: "render" }],
        };
      }

      // No query yet — show download progress
      const next: AppState = {
        ...state,
        phase: { phase: "downloading", progress: state.downloadProgress },
      };
      if (!event.hasGeolocation) {
        // No geolocation — use mock data immediately
        const mockResult = handleUseMockData(next, {
          type: "useMockData",
          mockPosition: state.position ?? { lat: 0, lon: 0 },
        });
        return {
          next: mockResult.next,
          effects: [...effects, ...mockResult.effects],
        };
      }
      return { next, effects: [...effects, { type: "render" }] };
    }

    case "tileLoadStarted": {
      const nextTiles = new Set(state.loadingTiles);
      nextTiles.add(event.id);
      return { next: { ...state, loadingTiles: nextTiles }, effects: [] };
    }

    case "updateProgress": {
      const clamped = event.fraction < 0 ? 0 : event.fraction;
      return {
        next: { ...state, updateProgress: clamped },
        effects: [{ type: "showUpdateBanner" }],
      };
    }

    case "updateAvailable": {
      if (state.currentLang !== event.lang) {
        return { next: state, effects: [] };
      }
      return {
        next: {
          ...state,
          pendingUpdate: { serverHash: event.serverHash, lang: event.lang },
        },
        effects: [{ type: "showUpdateBanner" }],
      };
    }

    case "useMockData":
      return handleUseMockData(state, event);

    // ── GPS events (tour-guide-6ub) ──────────────────────────

    case "position":
      return handlePosition(state, event);

    case "gpsError": {
      if (state.phase.phase === "locating") {
        return {
          next: { ...state, phase: { phase: "error", error: event.error } },
          effects: [{ type: "render" }],
        };
      }
      return { next: state, effects: [] };
    }

    // ── Browsing actions (tour-guide-bli) ────────────────────

    case "showMore": {
      if (state.phase.phase !== "browsing" || !state.position) {
        return { next: state, effects: [] };
      }
      const nextTier = getNextTier(state.phase.nearbyCount);
      if (nextTier === undefined) return { next: state, effects: [] };
      const { articles, query } = getNearby(
        state.query,
        state.position,
        nextTier,
      );
      return {
        next: {
          ...state,
          query,
          phase: { ...state.phase, nearbyCount: nextTier, articles },
        },
        effects: [{ type: "renderBrowsingList" }],
      };
    }

    case "togglePause": {
      if (state.phase.phase !== "browsing") {
        return { next: state, effects: [] };
      }
      const nowPaused = !state.phase.paused;
      if (!nowPaused && state.position) {
        const { articles, query } = getNearby(
          state.query,
          state.position,
          state.phase.nearbyCount,
        );
        return {
          next: {
            ...state,
            query,
            phase: {
              ...state.phase,
              paused: false,
              articles,
              lastQueryPos: state.position,
            },
          },
          effects: [{ type: "renderBrowsingList" }],
        };
      }
      return {
        next: {
          ...state,
          phase: { ...state.phase, paused: nowPaused },
        },
        effects: [{ type: "renderBrowsingList" }],
      };
    }

    // ── Detail view (tour-guide-2cd) ─────────────────────────

    case "selectArticle": {
      if (state.phase.phase !== "browsing") {
        return { next: state, effects: [] };
      }
      const { articles, nearbyCount, paused, lastQueryPos } = state.phase;
      return {
        next: {
          ...state,
          phase: {
            phase: "detail",
            article: event.article,
            articles,
            nearbyCount,
            paused,
            lastQueryPos,
          },
        },
        effects: [
          { type: "pushHistory" },
          { type: "fetchSummary", article: event.article },
        ],
      };
    }

    case "back": {
      if (state.phase.phase !== "detail") {
        return { next: state, effects: [] };
      }
      const { articles, nearbyCount, paused, lastQueryPos } = state.phase;
      return {
        next: {
          ...state,
          phase: {
            phase: "browsing",
            articles,
            nearbyCount,
            paused,
            lastQueryPos,
          },
        },
        effects: [{ type: "renderBrowsingList" }],
      };
    }

    // ── Language + update banner (tour-guide-e3f) ────────────

    case "langChanged": {
      const effects: Effect[] = [
        { type: "storeLang", lang: event.lang },
        { type: "removeUpdateBanner" },
        { type: "loadData", lang: event.lang },
      ];
      const hasStarted = state.phase.phase !== "welcome";
      const next: AppState = {
        ...state,
        query: { mode: "none" },
        currentLang: event.lang,
        loadGeneration: state.loadGeneration + 1,
        loadingTiles: new Set(),
        downloadProgress: -1,
        pendingUpdate: null,
        updateDownloading: false,
        updateProgress: 0,
        phase: hasStarted
          ? { phase: "downloading", progress: -1 }
          : state.phase,
      };
      if (hasStarted) effects.push({ type: "render" });
      return { next, effects };
    }

    case "acceptUpdate": {
      if (!state.pendingUpdate) return { next: state, effects: [] };
      const { serverHash, lang } = state.pendingUpdate;
      return {
        next: { ...state, updateDownloading: true, updateProgress: 0 },
        effects: [
          { type: "showUpdateBanner" },
          { type: "loadUpdate", serverHash, lang },
        ],
      };
    }

    case "declineUpdate": {
      if (!state.pendingUpdate) return { next: state, effects: [] };
      const { serverHash, lang } = state.pendingUpdate;
      const cacheKey = `triangulation-v3-${lang}`;
      return {
        next: { ...state, pendingUpdate: null },
        effects: [
          { type: "dismissUpdate", cacheKey, serverHash },
          { type: "removeUpdateBanner" },
        ],
      };
    }

    case "updateDownloaded": {
      const next: AppState = {
        ...state,
        pendingUpdate: null,
        updateDownloading: false,
      };
      return { next, effects: [{ type: "removeUpdateBanner" }] };
    }

    case "updateFailed": {
      return {
        next: {
          ...state,
          pendingUpdate: null,
          updateDownloading: false,
        },
        effects: [{ type: "removeUpdateBanner" }],
      };
    }

    // ── Download progress (tour-guide-8y4) ───────────────────

    case "downloadProgress": {
      if (event.gen !== state.loadGeneration) {
        return { next: state, effects: [] };
      }
      const next: AppState = { ...state, downloadProgress: event.fraction };
      if (state.phase.phase === "downloading") {
        return {
          next: {
            ...next,
            phase: { phase: "downloading", progress: event.fraction },
          },
          effects: [{ type: "render" }],
        };
      }
      return { next, effects: [] };
    }

    case "tileIndexLoaded": {
      if (event.gen !== state.loadGeneration) {
        return { next: state, effects: [] };
      }
      if (event.index) {
        const tiledQuery: QueryState = {
          mode: "tiled",
          index: event.index,
          tileMap: buildTileMap(event.index),
          tiles: new Map(),
        };
        const effects: Effect[] = [];
        let next: AppState = { ...state, query: tiledQuery };

        // Handle dataReady inline — tiled data is "ready" once index loads
        if (next.phase.phase === "downloading") {
          if (next.position) {
            const browseResult = enterBrowsing(next);
            next = browseResult.next;
            effects.push(...browseResult.effects);
          } else {
            next = { ...next, phase: { phase: "locating" } };
            effects.push({ type: "render" });
          }
        }

        if (next.position) {
          effects.push({ type: "loadTiles", lang: event.lang });
        }
        return { next, effects };
      }
      // No tile index available — show indeterminate downloading state
      return {
        next: {
          ...state,
          phase: { phase: "downloading", progress: -1 },
        },
        effects: [
          {
            type: "log",
            message: `Tile index not available for ${event.lang}`,
          },
          { type: "render" },
        ],
      };
    }

    case "tileLoaded": {
      if (event.gen !== state.loadGeneration) {
        return { next: state, effects: [] };
      }
      if (state.query.mode !== "tiled") {
        return { next: state, effects: [] };
      }
      const newTiles = new Map(state.query.tiles);
      newTiles.set(event.id, event.tileQuery);
      const newLoadingTiles = new Set(state.loadingTiles);
      newLoadingTiles.delete(event.id);
      const next: AppState = {
        ...state,
        query: { ...state.query, tiles: newTiles },
        loadingTiles: newLoadingTiles,
      };

      if (state.phase.phase === "loadingTiles" && state.position) {
        return enterBrowsing(next);
      }
      if (state.phase.phase === "browsing" || state.phase.phase === "detail") {
        return forceRequery(next);
      }
      return { next, effects: [] };
    }

    default:
      return { next: state, effects: [] };
  }
}

// ── Event handler helpers ────────────────────────────────────

function handleUseMockData(
  state: AppState,
  event: { type: "useMockData"; mockPosition: UserPosition },
): TransitionResult {
  const effects: Effect[] = [{ type: "stopGps" }];
  const next: AppState = { ...state, position: event.mockPosition };

  if (state.query.mode === "none") {
    return {
      next: {
        ...next,
        phase: { phase: "downloading", progress: state.downloadProgress },
      },
      effects: [...effects, { type: "render" }],
    };
  }

  // mode === "tiled"
  const result = enterBrowsing(next);
  return {
    next: result.next,
    effects: [
      ...effects,
      { type: "loadTiles", lang: state.currentLang },
      ...result.effects,
    ],
  };
}

function handlePosition(
  state: AppState,
  event: { type: "position"; pos: UserPosition },
): TransitionResult {
  const next: AppState = { ...state, position: event.pos };
  const effects: Effect[] = [];

  if (state.query.mode === "tiled") {
    if (
      state.phase.phase === "locating" ||
      state.phase.phase === "loadingTiles" ||
      state.phase.phase === "browsing" ||
      state.phase.phase === "detail"
    ) {
      effects.push({ type: "loadTiles", lang: state.currentLang });
    }
  }

  switch (state.phase.phase) {
    case "locating": {
      const result = enterBrowsing(next);
      return {
        next: result.next,
        effects: [...effects, ...result.effects],
      };
    }

    case "browsing": {
      if (state.phase.paused) {
        return { next, effects };
      }
      const distance = distanceBetweenPositions(
        event.pos,
        state.phase.lastQueryPos,
      );
      if (distance < REQUERY_DISTANCE_M) {
        return { next, effects };
      }
      const requery = forceRequery(next);
      return {
        next: requery.next,
        effects: [...effects, ...requery.effects],
      };
    }

    case "detail": {
      effects.push({ type: "render" });
      return { next, effects };
    }

    default:
      return { next, effects };
  }
}
