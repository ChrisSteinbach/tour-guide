// Progressive tile loading by distance radius.
// Pure ring geometry + orchestrator that expands rings on demand.

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
  /** Query all currently loaded tiles for nearest articles, sorted by distance. */
  queryAllTiles: () => Promise<NearbyArticle[]>;
  /** Load tiles at the given ring. Returns true if new tiles were loaded. */
  loadRing: (ring: number) => Promise<boolean>;
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
 * Create an ArticleProvider that expands tile rings on demand
 * to satisfy article range requests.
 */
export function createTileRadiusProvider(
  options: TileRadiusProviderOptions,
): ArticleProvider {
  const { queryAllTiles, loadRing } = options;
  let currentRing = 0;
  let ring0Loaded = false;

  return {
    async fetchRange(start: number, end: number): Promise<FetchResult> {
      // Load ring 0 if not yet loaded
      if (!ring0Loaded) {
        await loadRing(0);
        ring0Loaded = true;
      }

      // Expand rings until we have enough articles or exhaust the grid
      let articles = await queryAllTiles();
      while (articles.length < end && currentRing < MAX_RING) {
        currentRing++;
        const loaded = await loadRing(currentRing);
        if (loaded) {
          articles = await queryAllTiles();
        }
      }

      // Defensive copy — don't mutate the array returned by queryAllTiles
      const sorted = [...articles].sort((a, b) => a.distanceM - b.distanceM);
      return {
        articles: sorted.slice(start, Math.min(end, sorted.length)),
        totalAvailable: sorted.length,
      };
    },
  };
}
