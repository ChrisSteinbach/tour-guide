// Pure Chebyshev ring geometry over the tile grid.

import { COLS, ROWS, tileId, wrapCol } from "../tiles";
import type { TileEntry } from "../tiles";

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

/**
 * Maximum Chebyshev ring before the grid is fully covered.
 * ROWS - 1 is the max vertical distance (top-to-bottom of the grid).
 * Math.floor(COLS / 2) is the max horizontal distance (longitude wraps,
 * so the farthest column is half the grid away). The larger of the two
 * determines when every tile has been reached.
 */
export const MAX_RING = Math.max(ROWS - 1, Math.floor(COLS / 2));
