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

export const REQUERY_DISTANCE_M = 15;
/** Initial article count when entering infinite scroll mode. */
export const INFINITE_SCROLL_INITIAL = 200;
/** How many more articles to load on each lazy expansion. */
export const INFINITE_SCROLL_STEP = 200;
/** Default viewport fill count when actual viewport size is unknown. */
export const DEFAULT_VIEWPORT_FILL = 15;

// ── Helpers ──────────────────────────────────────────────────

/** Position is "stable" when picked or when GPS is paused. */
export function computeScrollMode(
  positionSource: "gps" | "picked" | null,
  paused: boolean,
): "infinite" | "viewport" {
  if (positionSource === "picked") return "infinite";
  if (paused) return "infinite";
  return "viewport";
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

/** Fields shared by browsing and detail phases — the "live session" context
 *  that must survive transitions between the two views. */
export type BrowsingContext = {
  articles: NearbyArticle[];
  nearbyCount: number;
  paused: boolean;
  /** Why the view is paused: 'manual' (user clicked pause), 'scroll' (auto-paused by scrolling), or null (not paused). */
  pauseReason: "manual" | "scroll" | null;
  lastQueryPos: UserPosition;
  scrollMode: "infinite" | "viewport";
  /** Current lazy limit for infinite scroll queries; grows on demand. */
  infiniteScrollLimit: number;
};

export type Phase =
  | { phase: "welcome" }
  | { phase: "downloading"; progress: number }
  | { phase: "locating" }
  | { phase: "loadingTiles" }
  | { phase: "error"; error: LocationError }
  | { phase: "dataUnavailable" }
  | ({ phase: "browsing" } & BrowsingContext)
  | ({
      phase: "detail";
      article: NearbyArticle;
      /** Index of the first visible article in the browse list, saved on entry to restore on back. */
      savedFirstVisibleIndex: number;
    } & BrowsingContext)
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
  /** True when GPS signal is lost mid-session (cleared on next position). */
  gpsSignalLost: boolean;
  /** How many articles to show in the initial viewport-filling view. */
  viewportFillCount: number;
  /** Whether the About dialog is currently open. */
  aboutOpen: boolean;
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
  | { type: "tileLoadFailed"; id: string; gen: number }
  | { type: "downloadProgress"; fraction: number; gen: number }
  | { type: "langChanged"; lang: Lang }
  | {
      type: "selectArticle";
      article: NearbyArticle;
      firstVisibleIndex: number;
    }
  | { type: "back" }
  | { type: "forwardToDetail"; title: string }
  | { type: "scrollPause" }
  | { type: "togglePause" }
  | { type: "useGps" }
  | { type: "expandInfiniteScroll" }
  | { type: "showMapPicker" }
  | {
      type: "queryResult";
      articles: NearbyArticle[];
      queryPos: UserPosition;
      count: number;
    }
  | { type: "noTilesNearby" }
  | { type: "swUpdateAvailable" }
  | { type: "articlesSync"; articles: NearbyArticle[] }
  | { type: "showAbout" }
  | { type: "closeAbout" };

// ── Effect (all side effects the machine requests) ───────────

export type Effect =
  | { type: "render" }
  | { type: "renderBrowsingList" }
  | { type: "renderBrowsingHeader" }
  | { type: "updateDistances" }
  | { type: "showAbout" }
  | { type: "hideAbout" }
  | { type: "startGps" }
  | { type: "stopGps" }
  | { type: "storeLang"; lang: Lang }
  | { type: "storeStarted" }
  | { type: "loadData"; lang: Lang }
  | { type: "loadTiles"; lang: Lang }
  | { type: "pushHistory"; state: unknown }
  | { type: "fetchSummary"; article: NearbyArticle }
  | { type: "showMapPicker" }
  | { type: "showAppUpdateBanner" }
  | { type: "requery"; pos: UserPosition; count: number }
  | { type: "fetchListSummaries" }
  | { type: "scrollToTop" }
  | { type: "restoreScrollTop"; firstVisibleIndex: number };

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
  const scrollMode = computeScrollMode(state.positionSource, false);
  const count =
    state.phase.phase === "browsing"
      ? state.phase.nearbyCount
      : state.viewportFillCount;
  const requeryCount =
    scrollMode === "infinite" ? INFINITE_SCROLL_INITIAL : count;
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
        pauseReason: null,
        lastQueryPos: state.position,
        scrollMode,
        infiniteScrollLimit: INFINITE_SCROLL_INITIAL,
      },
    },
    effects: [
      { type: "requery", pos: state.position, count: requeryCount },
      { type: "scrollToTop" },
    ],
  };
}

/** Requery at current position — used by position updates. */
function forceRequery(state: AppState): TransitionResult {
  if (state.phase.phase !== "browsing" || !state.position) {
    return { next: state, effects: [] };
  }
  const count =
    state.phase.scrollMode === "infinite"
      ? state.phase.infiniteScrollLimit
      : state.phase.nearbyCount;
  return {
    next: {
      ...state,
      phase: {
        ...state.phase,
        lastQueryPos: state.position,
      },
    },
    effects: [{ type: "requery", pos: state.position, count }],
  };
}

// ── Transition function ──────────────────────────────────────

// Invariant: the About dialog is only openable during these phases.
// If the About button is added to other phases, update this set.
const ABOUT_PHASES = new Set<Phase["phase"]>(["welcome", "browsing"]);

export function transition(state: AppState, event: Event): TransitionResult {
  const result = transitionCore(state, event);
  // Auto-dismiss the about dialog when leaving a phase where it can be open.
  if (
    state.aboutOpen &&
    result.next.phase.phase !== state.phase.phase &&
    ABOUT_PHASES.has(state.phase.phase)
  ) {
    return {
      ...result,
      next: { ...result.next, aboutOpen: false },
      effects: [{ type: "hideAbout" }, ...result.effects],
    };
  }
  return result;
}

function transitionCore(state: AppState, event: Event): TransitionResult {
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
      if (
        state.positionSource === "gps" &&
        (state.phase.phase === "browsing" || state.phase.phase === "detail")
      ) {
        return {
          next: { ...state, gpsSignalLost: true },
          effects: [{ type: "render" }],
        };
      }
      return { next: state, effects: [] };
    }

    // ── Browsing actions (tour-guide-bli) ────────────────────

    case "scrollPause": {
      if (state.phase.phase !== "browsing" || !state.position) {
        return { next: state, effects: [] };
      }
      // Already paused → no-op. Infinite scroll → already paused by definition
      // (computeScrollMode returns "infinite" only when paused or picked).
      if (state.phase.paused || state.phase.scrollMode === "infinite") {
        return { next: state, effects: [] };
      }
      return {
        next: {
          ...state,
          phase: {
            ...state.phase,
            paused: true,
            pauseReason: "scroll",
            scrollMode: "infinite",
            infiniteScrollLimit: INFINITE_SCROLL_INITIAL,
          },
        },
        effects: [
          {
            type: "requery",
            pos: state.position,
            count: INFINITE_SCROLL_INITIAL,
          },
        ],
      };
    }

    case "togglePause": {
      if (state.phase.phase !== "browsing") {
        return { next: state, effects: [] };
      }
      const nowPaused = !state.phase.paused;
      const newScrollMode = computeScrollMode(state.positionSource, nowPaused);
      if (!nowPaused && state.position) {
        // Unpausing → switch to viewport mode, requery, scroll to top.
        // Always include renderBrowsingList so the DOM rebuilds from
        // infinite-scroll back to viewport mode even when the article
        // list hasn't changed (queryResult's "same" optimisation would
        // otherwise skip the rebuild).
        return {
          next: {
            ...state,
            phase: {
              ...state.phase,
              paused: false,
              pauseReason: null,
              scrollMode: newScrollMode,
              lastQueryPos: state.position,
            },
          },
          effects: [
            { type: "scrollToTop" },
            {
              type: "requery",
              pos: state.position,
              count: state.phase.nearbyCount,
            },
            { type: "renderBrowsingList" },
            { type: "fetchListSummaries" },
          ],
        };
      }
      if (nowPaused && state.position) {
        // Pausing → switch to infinite scroll, requery with initial count
        return {
          next: {
            ...state,
            phase: {
              ...state.phase,
              paused: true,
              pauseReason: "manual",
              scrollMode: newScrollMode,
              infiniteScrollLimit: INFINITE_SCROLL_INITIAL,
            },
          },
          effects: [
            {
              type: "requery",
              pos: state.position,
              count: INFINITE_SCROLL_INITIAL,
            },
          ],
        };
      }
      return {
        next: {
          ...state,
          phase: {
            ...state.phase,
            paused: nowPaused,
            pauseReason: nowPaused ? "manual" : null,
            scrollMode: newScrollMode,
          },
        },
        effects: [{ type: "renderBrowsingList" }],
      };
    }

    case "expandInfiniteScroll": {
      if (
        state.phase.phase !== "browsing" ||
        !state.position ||
        state.phase.scrollMode !== "infinite"
      ) {
        return { next: state, effects: [] };
      }
      const newLimit = state.phase.infiniteScrollLimit + INFINITE_SCROLL_STEP;
      return {
        next: {
          ...state,
          phase: {
            ...state.phase,
            infiniteScrollLimit: newLimit,
          },
        },
        effects: [{ type: "requery", pos: state.position, count: newLimit }],
      };
    }

    case "showMapPicker": {
      return {
        next: {
          ...state,
          phase: { phase: "mapPicker", returnPhase: state.phase },
        },
        effects: [
          { type: "pushHistory", state: { view: "mapPicker" } },
          { type: "showMapPicker" },
        ],
      };
    }

    case "useGps": {
      if (state.phase.phase !== "browsing" && state.phase.phase !== "detail") {
        return { next: state, effects: [] };
      }
      // Switch to GPS — viewport mode, unpaused.
      const updatedPhase = {
        ...state.phase,
        scrollMode: "viewport" as const,
        paused: false,
        pauseReason: null as "manual" | "scroll" | null,
      };

      // When switching away from a picked position, clear the stale
      // coordinates so that nothing (scrollPause, ensureArticleRange,
      // renderViewportListDOM) can act on the old location before GPS
      // provides the real one via handlePosition → forceRequery.
      const hasGpsPosition = state.positionSource === "gps" && state.position;
      const next: AppState = {
        ...state,
        positionSource: "gps",
        position: hasGpsPosition ? state.position : null,
        phase: updatedPhase,
      };
      const effects: Effect[] = [{ type: "startGps" }];

      if (next.position) {
        // Already on GPS with a valid position — requery and scroll to top.
        const rq = forceRequery(next);
        return {
          next: rq.next,
          effects: [...effects, ...rq.effects, { type: "scrollToTop" }],
        };
      }

      // No valid GPS position yet — scroll to top and wait for GPS.
      // The existing DOM stays visible until handlePosition fires.
      effects.push({ type: "scrollToTop" });
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
      // In infinite mode, preserve viewport-based nearbyCount for mode transitions
      const nearbyCount =
        p.scrollMode === "infinite" ? p.nearbyCount : event.count;
      return {
        next: {
          ...state,
          phase: {
            ...p,
            articles: event.articles,
            nearbyCount,
            lastQueryPos: event.queryPos,
          },
        },
        effects: same
          ? [{ type: "updateDistances" }]
          : p.scrollMode === "infinite"
            ? [{ type: "renderBrowsingList" }]
            : [{ type: "renderBrowsingList" }, { type: "fetchListSummaries" }],
      };
    }

    // ── Articles sync (from ArticleWindow reloads) ──────────

    case "articlesSync": {
      if (state.phase.phase !== "browsing") {
        return { next: state, effects: [] };
      }
      const sp = state.phase;
      const same =
        event.articles.length === sp.articles.length &&
        event.articles.every((a, i) => a.title === sp.articles[i].title);
      if (same) return { next: state, effects: [] };
      return {
        next: {
          ...state,
          phase: { ...sp, articles: event.articles },
        },
        effects:
          sp.scrollMode === "infinite"
            ? [{ type: "renderBrowsingList" }]
            : [{ type: "renderBrowsingList" }, { type: "fetchListSummaries" }],
      };
    }

    // ── Detail view (tour-guide-2cd) ─────────────────────────

    case "selectArticle": {
      if (state.phase.phase === "browsing") {
        const { phase: _, ...context } = state.phase;
        return {
          next: {
            ...state,
            phase: {
              phase: "detail",
              ...context,
              article: event.article,
              savedFirstVisibleIndex: event.firstVisibleIndex,
            },
          },
          effects: [
            {
              type: "pushHistory",
              state: { view: "detail", title: event.article.title },
            },
            { type: "fetchSummary", article: event.article },
          ],
        };
      }
      // Allow swapping the detail target directly (e.g. clicking a different
      // pin while detail is open) — keep the original savedFirstVisibleIndex
      // so back still restores the list position from the originating click.
      if (state.phase.phase === "detail") {
        return {
          next: {
            ...state,
            phase: { ...state.phase, article: event.article },
          },
          effects: [
            {
              type: "pushHistory",
              state: { view: "detail", title: event.article.title },
            },
            { type: "fetchSummary", article: event.article },
          ],
        };
      }
      return { next: state, effects: [] };
    }

    case "forwardToDetail": {
      if (state.phase.phase !== "browsing") {
        return { next: state, effects: [] };
      }
      const article = state.phase.articles.find((a) => a.title === event.title);
      if (!article) return { next: state, effects: [] };
      const { phase: _, ...context } = state.phase;
      return {
        next: {
          ...state,
          phase: {
            phase: "detail",
            ...context,
            article,
            savedFirstVisibleIndex: 0,
          },
        },
        effects: [{ type: "fetchSummary", article }],
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
      const {
        phase: _,
        article: __,
        savedFirstVisibleIndex,
        ...context
      } = state.phase;
      const effects: Effect[] = [{ type: "renderBrowsingList" }];
      // In non-infinite mode, eagerly fetch all summaries. In infinite mode,
      // the enrichment scheduler handles viewport-based fetching — calling
      // load() with the full (potentially 14k+) article list would overwhelm
      // the Wikipedia API with requests.
      if (context.scrollMode !== "infinite") {
        effects.push({ type: "fetchListSummaries" });
      }
      if (savedFirstVisibleIndex > 0) {
        effects.push({
          type: "restoreScrollTop",
          firstVisibleIndex: savedFirstVisibleIndex,
        });
      }
      return {
        next: {
          ...state,
          phase: { phase: "browsing", ...context },
        },
        effects,
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

    case "showAbout": {
      if (state.aboutOpen) return { next: state, effects: [] };
      return {
        next: { ...state, aboutOpen: true },
        effects: [{ type: "showAbout" }],
      };
    }

    case "closeAbout": {
      if (!state.aboutOpen) return { next: state, effects: [] };
      return {
        next: { ...state, aboutOpen: false },
        effects: [{ type: "hideAbout" }],
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

    case "tileLoadFailed": {
      if (event.gen !== state.loadGeneration) {
        return { next: state, effects: [] };
      }
      const failedLoadingTiles = new Set(state.loadingTiles);
      failedLoadingTiles.delete(event.id);
      const next: AppState = { ...state, loadingTiles: failedLoadingTiles };
      if (
        state.phase.phase === "loadingTiles" &&
        state.position &&
        failedLoadingTiles.size === 0
      ) {
        // If some tiles loaded successfully, enterBrowsing will requery them.
        // If all tiles failed (none loaded), go straight to empty browsing.
        const hasTiles =
          next.query.mode === "tiled" && next.query.tiles.size > 0;
        if (hasTiles) return enterBrowsing(next);
        const scrollMode = computeScrollMode(state.positionSource, false);
        const count = state.viewportFillCount;
        return {
          next: {
            ...next,
            phase: {
              phase: "browsing",
              articles: [],
              nearbyCount: count,
              paused: false,
              pauseReason: null,
              lastQueryPos: state.position,
              scrollMode,
              infiniteScrollLimit: INFINITE_SCROLL_INITIAL,
            },
          },
          effects: [{ type: "renderBrowsingList" }],
        };
      }
      return { next, effects: [] };
    }

    case "noTilesNearby": {
      if (state.phase.phase !== "loadingTiles" || !state.position) {
        return { next: state, effects: [] };
      }
      const scrollMode = computeScrollMode(state.positionSource, false);
      const count = state.viewportFillCount;
      return {
        next: {
          ...state,
          phase: {
            phase: "browsing",
            articles: [],
            nearbyCount: count,
            paused: false,
            pauseReason: null,
            lastQueryPos: state.position,
            scrollMode,
            infiniteScrollLimit: INFINITE_SCROLL_INITIAL,
          },
        },
        effects: [{ type: "renderBrowsingList" }],
      };
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

  // After the "none" early-return above, state.query is narrowed to "tiled".
  // Exhaustive guard: if a third mode is ever added, TypeScript will error
  // here because the new variant won't be assignable to `never`.
  if (state.query.mode !== "tiled") {
    const _exhaustive: never = state.query;
    return _exhaustive;
  }

  // Clear stale tiles and bump loadGeneration so in-flight tile loads
  // from the previous position are discarded by the generation guard.
  const cleared: AppState = {
    ...next,
    query: { ...state.query, tiles: new Map() },
    loadingTiles: new Set(),
    loadGeneration: state.loadGeneration + 1,
  };
  const result = enterBrowsing(cleared);
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
    gpsSignalLost: false,
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
        // When auto-paused by scroll, re-render header to restart blink.
        // Use renderBrowsingHeader (not renderBrowsingList) to avoid a full
        // virtual-list DOM rebuild that would destroy :hover state.
        if (state.phase.pauseReason === "scroll") {
          return {
            next,
            effects: [...effects, { type: "renderBrowsingHeader" }],
          };
        }
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
