// Pure state machine for the app — no DOM, no I/O, no side effects.
// transition(state, event) → { next, effects }

import type { NearbyArticle, UserPosition } from "./types";
import type { LocationError } from "./location";
import type { NearestQuery } from "./query";
import type { TiledQuery } from "./tile-loader";
import type { TileIndex } from "../tiles";
import type { Lang } from "../lang";

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
  query: NearestQuery | TiledQuery | null;
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
  | { type: "start" }
  | { type: "useMockData" }
  | { type: "position"; pos: UserPosition }
  | { type: "gpsError"; error: LocationError }
  | { type: "dataReady" }
  | { type: "tileIndexLoaded"; index: TileIndex | null; lang: Lang }
  | { type: "tileLoaded"; id: string; tileQuery: NearestQuery }
  | { type: "downloadProgress"; fraction: number }
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
  | { type: "loadMonolithic"; lang: Lang }
  | { type: "loadTiles"; lang: Lang }
  | { type: "cleanMonolithicCache"; lang: Lang }
  | { type: "loadUpdate"; serverHash: string; lang: Lang }
  | { type: "dismissUpdate"; cacheKey: string; serverHash: string }
  | { type: "pushHistory" }
  | { type: "fetchSummary"; article: NearbyArticle }
  | { type: "showUpdateBanner" }
  | { type: "removeUpdateBanner" }
  | { type: "showAppUpdateBanner" }
  | { type: "checkForUpdate"; lang: Lang }
  | { type: "log"; message: string };

// ── Transition function ──────────────────────────────────────

export function transition(
  state: AppState,
  _event: Event,
): { next: AppState; effects: Effect[] } {
  return { next: state, effects: [] };
}
