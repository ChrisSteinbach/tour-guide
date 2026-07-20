// Owns the materialized browse list and the far-field tier it is built from.
//
// This replaces the sliding-window model the list used to have. That model
// existed because the list's length was unknowable without downloading every
// tile, so it grew as the user scrolled: optimistic heights, never-shrink
// ratchets, near-end prefetch and failure backoff were all consequences of not
// knowing how long the list was. The far-field tier removes the premise — the
// list is built whole, so its length is exact and every index is already there.

import {
  buildBrowseList,
  coverageRadiusMeters,
  selectDigestCells,
} from "./browse-list";
import { filterMinWeight } from "./config";
import type { FarFieldEntry } from "../farfield";
import type { Lang } from "../lang";
import type { SampledTierMeta, TileEntry } from "../tiles";
import type { AppState } from "./state-machine";
import type { NearbyArticle, UserPosition } from "./types";

/** Notified whenever the browse list is rebuilt. */
export type BrowseListObserver = (articles: NearbyArticle[]) => void;

/**
 * Digests fetched at once. They are small and the set is at most ~45, so this
 * is not about throughput — it is to stop a fresh position from putting dozens
 * of requests ahead of the tile fetch the user is actually waiting to see.
 */
const DIGEST_FETCH_CONCURRENCY = 6;

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
  /** Fetch one cell's mid-field digest (cached by the loader). */
  loadDigest: (
    lang: Lang,
    tileId: string,
    meta: SampledTierMeta,
    signal: AbortSignal,
  ) => Promise<FarFieldEntry[]>;
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

  /** Digests in memory, by cell ID, pruned to the cells currently in range. */
  const digests = new Map<string, readonly FarFieldEntry[]>();
  /** `digests` flattened — rebuilt only when it changes, read on every build. */
  let midField: readonly FarFieldEntry[] = [];
  let digestLang: Lang | null = null;
  let digestCells = "";
  let digestAbort: AbortController | null = null;

  function flattenDigests(): void {
    midField = [...digests.values()].flat();
  }

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
      midField,
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

  /**
   * Fetch `ids` with bounded concurrency, in the order given — nearest cell
   * first, so if the tail is still in flight the part of the gap already
   * closed is the part nearest the user.
   */
  async function fetchDigests(
    ids: readonly string[],
    lang: Lang,
    tileMap: ReadonlyMap<string, TileEntry>,
    abort: AbortController,
  ): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < ids.length && !abort.signal.aborted) {
        const id = ids[next++];
        const meta = tileMap.get(id)?.digest;
        if (!meta) continue;
        const entries = await deps.loadDigest(lang, id, meta, abort.signal);
        if (abort.signal.aborted) return;
        digests.set(id, entries);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(DIGEST_FETCH_CONCURRENCY, ids.length) },
        worker,
      ),
    );
  }

  /**
   * Bring the mid-field tier in step with the position: fetch the digests for
   * the cells now in range, drop the ones that left.
   *
   * Unlike the far-field tier this depends on where the user is, so it is
   * re-evaluated on every rebuild — but the set of cells within
   * `MID_FIELD_RADIUS_M` only changes when the user crosses a boundary a
   * thousand kilometres away, so in practice GPS jitter compares equal and
   * this does nothing. Cells that go out of range are dropped rather than kept
   * on the chance the user returns: memory stays bounded by the radius instead
   * of by how far they have travelled, and IDB makes coming back cheap.
   *
   * As with the far field, nothing waits on the fetch. The list is built from
   * whatever digests are in hand and rebuilt when the rest arrive — once, at
   * the end of the batch, because each rebuild shifts every row below the
   * insertion point and doing that eight times running is worse than doing it
   * late.
   */
  function ensureMidField(position: UserPosition): void {
    const state = deps.getState();
    if (state.query.mode !== "tiled") return;

    const lang = state.currentLang;
    const tileMap = state.query.tileMap;
    const wanted = selectDigestCells(tileMap, position.lat, position.lon);
    const cellKey = wanted.join(",");
    if (lang === digestLang && cellKey === digestCells) return;

    digestAbort?.abort();
    const abort = new AbortController();
    digestAbort = abort;

    // Digests are per language as well as per cell, so a language switch
    // invalidates every one of them even though the cell IDs are unchanged.
    if (lang !== digestLang) digests.clear();
    digestLang = lang;
    digestCells = cellKey;

    const inRange = new Set(wanted);
    for (const id of [...digests.keys()]) {
      if (!inRange.has(id)) digests.delete(id);
    }
    flattenDigests();

    const missing = wanted.filter((id) => !digests.has(id));
    if (missing.length === 0) return;

    fetchDigests(missing, lang, tileMap, abort).then(
      () => {
        if (abort.signal.aborted) return;
        flattenDigests();
        if (lastPosition) {
          build(lastPosition);
          deps.renderBrowsingList();
        }
      },
      (err: unknown) => {
        if (abort.signal.aborted) return;
        // The loader degrades to [] for every recoverable failure, so reaching
        // here means something unexpected. The list still works — it just has
        // the gap this tier exists to fill.
        console.warn("mid-field digests unavailable:", err);
      },
    );
  }

  return {
    rebuild(position) {
      ensureFarField();
      ensureMidField(position);
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
