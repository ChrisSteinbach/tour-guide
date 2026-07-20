// Owns the materialized browse list and the far-field tier it is built from.
//
// This replaces the sliding-window model the list used to have. That model
// existed because the list's length was unknowable without downloading every
// tile, so it grew as the user scrolled: optimistic heights, never-shrink
// ratchets, near-end prefetch and failure backoff were all consequences of not
// knowing how long the list was. The far-field tier removes the premise — the
// list is built whole, so its length is exact and every index is already there.

import { buildBrowseList, coverageRadiusMeters } from "./browse-list";
import { filterMinWeight } from "./config";
import type { FarFieldEntry } from "../farfield";
import type { Lang } from "../lang";
import type { AppState } from "./state-machine";
import type { NearbyArticle, UserPosition } from "./types";

/** Notified whenever the browse list is rebuilt. */
export type BrowseListObserver = (articles: NearbyArticle[]) => void;

export interface BrowseListLifecycleDeps {
  getState: () => AppState;
  /**
   * Every article the currently loaded tiles hold within `radiusM`, in any
   * order — the raw local level, before `buildBrowseList` grades it by
   * distance band. A radius rather than a count: the local level reaches
   * exactly as far as the tiles are complete, not as far as some number of
   * rows happens to stretch.
   */
  queryLocal: (
    position: UserPosition,
    minWeight: number | undefined,
    radiusM: number,
  ) => NearbyArticle[];
  /** Fetch a language's far-field tier (cached by the loader). */
  loadFarField: (lang: Lang, signal: AbortSignal) => Promise<FarFieldEntry[]>;
  renderBrowsingList: () => void;
}

export interface BrowseListLifecycle {
  /**
   * Rebuild the list for `position` under the current filter and loaded
   * tiles. Cheap and synchronous once the far-field tier is in memory; safe
   * to call whenever any of those inputs change.
   */
  rebuild: (position: UserPosition) => void;
  /** Discard the current list. The far-field tier survives — it is scoped to
   *  the language, not the position. */
  reset: () => void;
  /** The current list. Empty before the first rebuild. */
  list: () => NearbyArticle[];
  /**
   * Attach the observer that receives the rebuilt list. Throws if one is
   * already attached — there is exactly one subscriber, so a silent
   * overwrite is a bug. Detach by passing `null`.
   */
  attachObserver: (observer: BrowseListObserver | null) => void;
}

export function createBrowseListLifecycle(
  deps: BrowseListLifecycleDeps,
): BrowseListLifecycle {
  let farField: readonly FarFieldEntry[] = [];
  let farFieldLang: Lang | null = null;
  let farFieldAbort: AbortController | null = null;
  let currentList: NearbyArticle[] = [];
  let lastPosition: UserPosition | null = null;
  let observer: BrowseListObserver | null = null;

  function build(position: UserPosition): void {
    const state = deps.getState();
    if (state.query.mode !== "tiled") return;

    const minWeight = filterMinWeight(state.filter);
    const coverageRadiusM = coverageRadiusMeters(
      state.query.tileMap,
      new Set(state.query.tiles.keys()),
      position.lat,
      position.lon,
    );
    currentList = buildBrowseList({
      position,
      local: deps.queryLocal(position, minWeight, coverageRadiusM),
      farField,
      minWeight,
    });
    lastPosition = position;
    observer?.(currentList);
  }

  /**
   * Fetch the far-field tier for the current language, once per language.
   *
   * The caller does not wait on it: the first build runs with whatever tier is
   * in hand, because a list that is instantly correct-but-short beats a
   * spinner, and the tier is usually an IDB hit anyway. When it lands, the
   * list is rebuilt and re-rendered so it gains its far end.
   */
  function ensureFarField(): void {
    const lang = deps.getState().currentLang;
    if (lang === farFieldLang) return;

    farFieldAbort?.abort();
    const abort = new AbortController();
    farFieldAbort = abort;
    farFieldLang = lang;
    farField = [];

    deps.loadFarField(lang, abort.signal).then(
      (entries) => {
        if (abort.signal.aborted) return;
        farField = entries;
        if (lastPosition) {
          build(lastPosition);
          deps.renderBrowsingList();
        }
      },
      (err) => {
        if (abort.signal.aborted) return;
        // The loader degrades to [] for every recoverable failure, so reaching
        // here means something unexpected. The list still works — it just ends
        // at the tile coverage radius.
        console.warn("far-field tier unavailable:", err);
      },
    );
  }

  return {
    rebuild(position) {
      ensureFarField();
      build(position);
    },

    reset() {
      currentList = [];
      lastPosition = null;
    },

    list: () => currentList,

    attachObserver(next) {
      if (next !== null && observer !== null) {
        throw new Error("browse-list observer already attached — detach first");
      }
      observer = next;
    },
  };
}
