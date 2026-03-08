// Pure state machine for the app — no DOM, no I/O, no side effects.
// transition(state, event) → { next, effects }

import type { NearbyArticle, UserPosition } from "./types";
import type { LocationError } from "./location";
import type { NearestQuery } from "./query";
import { findNearestTiled, buildTileMap } from "./tile-loader";
import type { TileIndex, TileEntry } from "../tiles";
import type { Lang } from "../lang";
import { distanceBetweenPositions } from "./format";

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
): NearbyArticle[] {
  switch (queryState.mode) {
    case "tiled":
      return findNearestTiled(queryState.tiles, pos.lat, pos.lon, count);
    case "none":
      return [];
  }
}

// ── Phase (discriminated union for the UI state) ─────────────

export type Phase =
  | { phase: "welcome" }
  | { phase: "downloading"; progress: number }
  | { phase: "locating" }
  | { phase: "loadingTiles" }
  | { phase: "error"; error: LocationError }
  | { phase: "dataUnavailable" }
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
    }
  | { phase: "mapPicker"; returnPhase: Phase };

// ── AppState ─────────────────────────────────────────────────

export interface AppState {
  phase: Phase;
  query: QueryState;
  position: UserPosition | null;
  positionSource: "gps" | "picked" | null;
  currentLang: Lang;
  loadGeneration: number;
  loadingTiles: Set<string>;
  downloadProgress: number;
  /** Which update banner (if any) is showing. App updates take priority. */
  updateBanner: null | "app";
  hasGeolocation: boolean;
}

// ── Event (all inputs to the state machine) ──────────────────

export type Event =
  | { type: "start"; hasGeolocation: boolean }
  | { type: "pickPosition"; position: UserPosition }
  | { type: "position"; pos: UserPosition }
  | { type: "gpsError"; error: LocationError }
  | { type: "tileLoadStarted"; id: string }
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
  | { type: "useGps" }
  | { type: "showMapPicker" }
  | {
      type: "queryResult";
      articles: NearbyArticle[];
      queryPos: UserPosition;
      count: number;
    }
  | { type: "swUpdateAvailable" };

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
  | { type: "pushHistory" }
  | { type: "fetchSummary"; article: NearbyArticle }
  | { type: "showMapPicker" }
  | { type: "showAppUpdateBanner" }
  | { type: "requery"; pos: UserPosition; count: number }
  | { type: "fetchListSummaries" };

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
  const prevArticles =
    state.phase.phase === "browsing" ? state.phase.articles : [];
  return {
    next: {
      ...state,
      phase: {
        phase: "browsing",
        articles: prevArticles,
        nearbyCount: count,
        paused: false,
        lastQueryPos: state.position,
      },
    },
    effects: [{ type: "requery", pos: state.position, count }],
  };
}

/** Requery at current position — used by position updates. */
function forceRequery(state: AppState): TransitionResult {
  if (state.phase.phase !== "browsing" || !state.position) {
    return { next: state, effects: [] };
  }
  return {
    next: {
      ...state,
      phase: {
        ...state.phase,
        lastQueryPos: state.position,
      },
    },
    effects: [
      { type: "requery", pos: state.position, count: state.phase.nearbyCount },
    ],
  };
}

// ── Transition function ──────────────────────────────────────

export function transition(state: AppState, event: Event): TransitionResult {
  switch (event.type) {
    // ── Core lifecycle (tour-guide-fed) ──────────────────────

    case "start": {
      const next: AppState = {
        ...state,
        hasGeolocation: event.hasGeolocation,
      };
      const effects: Effect[] = [{ type: "storeStarted" }];
      if (event.hasGeolocation) effects.push({ type: "startGps" });

      if (next.query.mode !== "none") {
        if (next.position) {
          const result = enterBrowsing(next);
          return {
            next: result.next,
            effects: [...effects, ...result.effects],
          };
        }
        return {
          next: { ...next, phase: { phase: "locating" } },
          effects: [...effects, { type: "render" }],
        };
      }

      // No query yet — show download progress
      return {
        next: {
          ...next,
          phase: { phase: "downloading", progress: next.downloadProgress },
        },
        effects: [...effects, { type: "render" }],
      };
    }

    case "tileLoadStarted": {
      const nextTiles = new Set(state.loadingTiles);
      nextTiles.add(event.id);
      return { next: { ...state, loadingTiles: nextTiles }, effects: [] };
    }

    case "pickPosition":
      return handlePickPosition(state, event);

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
      return {
        next: {
          ...state,
          phase: { ...state.phase, nearbyCount: nextTier },
        },
        effects: [{ type: "requery", pos: state.position, count: nextTier }],
      };
    }

    case "togglePause": {
      if (state.phase.phase !== "browsing") {
        return { next: state, effects: [] };
      }
      const nowPaused = !state.phase.paused;
      if (!nowPaused && state.position) {
        return {
          next: {
            ...state,
            phase: {
              ...state.phase,
              paused: false,
              lastQueryPos: state.position,
            },
          },
          effects: [
            { type: "renderBrowsingList" },
            {
              type: "requery",
              pos: state.position,
              count: state.phase.nearbyCount,
            },
          ],
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

    case "showMapPicker": {
      return {
        next: {
          ...state,
          phase: { phase: "mapPicker", returnPhase: state.phase },
        },
        effects: [{ type: "pushHistory" }, { type: "showMapPicker" }],
      };
    }

    case "useGps": {
      if (state.phase.phase !== "browsing" && state.phase.phase !== "detail") {
        return { next: state, effects: [] };
      }
      const next: AppState = { ...state, positionSource: "gps" };
      const effects: Effect[] = [
        { type: "startGps" },
        { type: "renderBrowsingList" },
      ];
      // If we already have a GPS position, requery immediately so the
      // list updates without waiting for the next 15 m GPS movement.
      if (state.position) {
        const rq = forceRequery(next);
        return {
          next: rq.next,
          effects: [...effects, ...rq.effects],
        };
      }
      return { next, effects };
    }

    // ── Query result (async-ready requery response) ─────────

    case "queryResult": {
      if (state.phase.phase !== "browsing") {
        return { next: state, effects: [] };
      }
      const p = state.phase;
      const same =
        event.articles.length === p.articles.length &&
        event.articles.every((a, i) => a.title === p.articles[i].title);
      return {
        next: {
          ...state,
          phase: {
            ...p,
            articles: event.articles,
            nearbyCount: event.count,
            lastQueryPos: event.queryPos,
          },
        },
        effects: same
          ? [{ type: "updateDistances" }]
          : [{ type: "renderBrowsingList" }, { type: "fetchListSummaries" }],
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
      if (state.phase.phase === "mapPicker") {
        const rp = state.phase.returnPhase;
        const effects: Effect[] =
          rp.phase === "browsing"
            ? [{ type: "renderBrowsingList" }]
            : [{ type: "render" }];
        return {
          next: { ...state, phase: rp },
          effects,
        };
      }
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
        effects: [
          { type: "renderBrowsingList" },
          { type: "fetchListSummaries" },
        ],
      };
    }

    // ── Update banner (tour-guide-2lw) ─────────────────────

    case "swUpdateAvailable": {
      if (state.updateBanner === "app") {
        return { next: state, effects: [] };
      }
      return {
        next: { ...state, updateBanner: "app" },
        effects: [{ type: "showAppUpdateBanner" }],
      };
    }

    // ── Language + update banner (tour-guide-e3f) ────────────

    case "langChanged": {
      const effects: Effect[] = [
        { type: "storeLang", lang: event.lang },
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
        phase: hasStarted
          ? { phase: "downloading", progress: -1 }
          : state.phase,
      };
      if (hasStarted) effects.push({ type: "render" });
      return { next, effects };
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
          } else if (!next.hasGeolocation) {
            next = {
              ...next,
              phase: {
                phase: "error",
                error: {
                  code: "POSITION_UNAVAILABLE",
                  message: "Geolocation not available",
                },
              },
            };
            effects.push({ type: "render" });
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
      // No tile index available — let user pick a different language
      return {
        next: {
          ...state,
          phase: { phase: "dataUnavailable" },
        },
        effects: [{ type: "render" }],
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

function handlePickPosition(
  state: AppState,
  event: { type: "pickPosition"; position: UserPosition },
): TransitionResult {
  const effects: Effect[] = [{ type: "stopGps" }];
  const next: AppState = {
    ...state,
    position: event.position,
    positionSource: "picked",
  };

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
  const next: AppState = {
    ...state,
    position: event.pos,
    positionSource: "gps",
  };
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
