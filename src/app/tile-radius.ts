// Progressive tile loading by distance radius.
// Pure ring geometry + orchestrator that expands rings on demand.
//
// The provider is *resumable*: it maintains a cumulative sorted list of
// discovered articles and a seen-title set for cross-ring deduplication.
// When a new ring is loaded only its tiles are queried and the results
// are merged into the existing list via a merge-tail to handle the
// Chebyshev-vs-great-circle distance interleaving at ring boundaries.

import { COLS, ROWS, tileId, wrapCol } from "../tiles";
import type { TileEntry } from "../tiles";
import type { NearbyArticle } from "./types";
import type { ArticleProvider, FetchResult } from "./article-window";

const MAX_ROW = ROWS - 1; // 35

/**
 * Return tile IDs at exactly Chebyshev distance `ring` from center.
 * Ring 0 = center tile only. Ring 1 = 8 surrounding tiles. Etc.
 * Only returns tiles that exist in the tileMap.
 */
export function tilesAtRing(
  centerRow: number,
  centerCol: number,
  ring: number,
  tileMap: Map<string, TileEntry>,
): string[] {
  if (ring === 0) {
    const id = tileId(centerRow, centerCol);
    return tileMap.has(id) ? [id] : [];
  }

  const result: string[] = [];

  for (let dr = -ring; dr <= ring; dr++) {
    for (let dc = -ring; dc <= ring; dc++) {
      // Only tiles on the ring border (Chebyshev distance === ring)
      if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;

      const row = centerRow + dr;
      if (row < 0 || row > MAX_ROW) continue;

      const col = wrapCol(centerCol + dc);
      const id = tileId(row, col);
      if (tileMap.has(id)) {
        result.push(id);
      }
    }
  }

  return result;
}

/** Return all tile IDs within Chebyshev distance `maxRing` from center. */
export function tilesWithinRadius(
  centerRow: number,
  centerCol: number,
  maxRing: number,
  tileMap: Map<string, TileEntry>,
): string[] {
  const result: string[] = [];
  for (let r = 0; r <= maxRing; r++) {
    result.push(...tilesAtRing(centerRow, centerCol, r, tileMap));
  }
  return result;
}

// ── Radius provider (orchestrator) ───────────────────────────

export interface TileRadiusProviderOptions {
  /** Query specific tiles for nearest articles, sorted by distance. */
  queryTiles: (tileIds: string[]) => Promise<NearbyArticle[]>;
  /** Load tiles at the given ring. Returns IDs of newly loaded tiles. */
  loadRing: (ring: number) => Promise<string[]>;
  centerRow: number;
  centerCol: number;
}

/**
 * Maximum Chebyshev ring before the grid is fully covered.
 * ROWS - 1 is the max vertical distance (top-to-bottom of the grid).
 * Math.floor(COLS / 2) is the max horizontal distance (longitude wraps,
 * so the farthest column is half the grid away). The larger of the two
 * determines when every tile has been reached.
 */
export const MAX_RING = Math.max(ROWS - 1, Math.floor(COLS / 2));

/**
 * Number of articles kept as the merge tail when integrating a new ring.
 * Articles in the tail may be re-ordered when new-ring articles interleave
 * with them (Chebyshev tile distance ≠ great-circle article distance).
 * Articles before the tail are finalized and never re-sorted.
 *
 * @internal Exported only so tests can pin the tail size — not part of the
 * public API. No production caller should need to read or override this.
 */
export const MERGE_TAIL_SIZE = 500;

/**
 * Create an ArticleProvider that expands tile rings on demand
 * to satisfy article range requests.
 *
 * The provider is *resumable*: it keeps a cumulative sorted list of
 * discovered articles and only queries newly loaded tiles on expansion.
 */
export function createTileRadiusProvider(
  options: TileRadiusProviderOptions,
): ArticleProvider {
  const { queryTiles, loadRing } = options;
  let currentRing = 0;
  let ring0Loaded = false;

  /** Cumulative sorted list of all discovered articles. */
  const discoveredArticles: NearbyArticle[] = [];
  /** Titles already in discoveredArticles — for cross-ring dedup. */
  const seenTitles = new Set<string>();

  /**
   * Dedup `incoming` against seenTitles, add survivors to the set.
   * Keeps the first-seen distance for each title. This is safe because
   * findNearestTiled computes great-circle distance from the user's
   * position, which is tile-independent — the same article always
   * gets the same distance regardless of which tile returned it.
   */
  function dedup(incoming: NearbyArticle[]): NearbyArticle[] {
    const fresh: NearbyArticle[] = [];
    for (const a of incoming) {
      if (!seenTitles.has(a.title)) {
        seenTitles.add(a.title);
        fresh.push(a);
      }
    }
    return fresh;
  }

  /** Merge `fresh` articles into discoveredArticles using the tail. */
  function mergeInto(fresh: NearbyArticle[]): void {
    if (fresh.length === 0) return;

    if (discoveredArticles.length <= MERGE_TAIL_SIZE) {
      // Small list — just append and re-sort everything
      discoveredArticles.push(...fresh);
      discoveredArticles.sort((a, b) => a.distanceM - b.distanceM);
      return;
    }

    // Split: finalized portion stays untouched, tail gets merged with fresh.
    // Default tail spans the last MERGE_TAIL_SIZE entries, but we may need to
    // widen it: a ring-(N+1) article can have a smaller great-circle distance
    // than a ring-N article that already sits in the finalized prefix
    // (Chebyshev tile distance ≠ great-circle distance). If any such fresh
    // article exists, we must pull the affected prefix entries back into the
    // tail so they can be re-sorted alongside the new batch.
    let minFresh = fresh[0].distanceM;
    for (let i = 1; i < fresh.length; i++) {
      if (fresh[i].distanceM < minFresh) minFresh = fresh[i].distanceM;
    }

    let tailStart = discoveredArticles.length - MERGE_TAIL_SIZE;
    if (discoveredArticles[tailStart - 1].distanceM > minFresh) {
      // Binary-search the finalized prefix for the first index whose distance
      // exceeds minFresh. Everything from that index onward must be re-sorted.
      // The prefix is sorted, so this is O(log N).
      let lo = 0;
      let hi = tailStart;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (discoveredArticles[mid].distanceM > minFresh) hi = mid;
        else lo = mid + 1;
      }
      tailStart = lo;
    }

    const tail = discoveredArticles.splice(tailStart);
    tail.push(...fresh);
    tail.sort((a, b) => a.distanceM - b.distanceM);
    discoveredArticles.push(...tail);
  }

  /** Query and merge a batch of newly loaded tiles. */
  async function ingestTiles(tileIds: string[]): Promise<void> {
    if (tileIds.length === 0) return;
    const articles = await queryTiles(tileIds);
    const fresh = dedup(articles);
    mergeInto(fresh);
  }

  return {
    async fetchRange(start: number, end: number): Promise<FetchResult> {
      // Fast path: already have enough articles
      if (discoveredArticles.length >= end) {
        return {
          articles: discoveredArticles.slice(start, end),
          totalAvailable: discoveredArticles.length,
        };
      }

      // Load ring 0 if not yet loaded
      if (!ring0Loaded) {
        const ids = await loadRing(0);
        ring0Loaded = true;
        await ingestTiles(ids);
      }

      // Expand rings until we have enough articles or exhaust the grid
      while (discoveredArticles.length < end && currentRing < MAX_RING) {
        currentRing++;
        const ids = await loadRing(currentRing);
        await ingestTiles(ids);
      }

      return {
        articles: discoveredArticles.slice(
          start,
          Math.min(end, discoveredArticles.length),
        ),
        totalAvailable: discoveredArticles.length,
      };
    },
  };
}
