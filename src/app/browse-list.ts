// The browse list: one distance-ordered list of the whole globe, at two levels
// of detail.
//
// Tiles give exhaustive coverage, but only near the user — reaching the
// furthest article by loading tiles means downloading every one of them, and a
// 1:1 virtual list of every article would be taller than the element-height
// ceiling browsers enforce. So the list is exhaustive out to the radius the
// loaded tiles actually cover, and beyond that switches to the far-field tier
// (see src/farfield.ts): the most notable articles from every cell on Earth.
//
// The whole list is materialized. That is the point: its length is exact from
// the moment it is built, any index can be read without fetching anything, and
// the last entry really is the furthest article in the language. None of the
// windowing, optimistic sizing or near-end expansion that an
// unknown-length list needs applies.

import { distanceBetweenPositions } from "./format";
import { tileBoxLowerBoundMeters } from "./tile-loader";
import type { FarFieldEntry } from "../farfield";
import type { TileEntry } from "../tiles";
import type { NearbyArticle, UserPosition } from "./types";

/**
 * Cap on the exhaustive tier. Bounds both the nearest-neighbor query (`k`
 * feeds the pruning in `queryTilesPruned`, so an unbounded k defeats it) and
 * how much of the list one dense city can occupy: without a cap, London's
 * 67,000 articles within 250 km would bury the rest of the planet below a
 * scroll position no one reaches. Articles past the cap are still represented
 * by the far-field tier.
 */
export const LOCAL_EXHAUSTIVE_MAX = 5000;

/**
 * The radius within which the loaded tiles are complete: the distance to the
 * nearest tile that exists but is not loaded. Beyond it, the exhaustive tier
 * has holes, so the far-field tier takes over.
 *
 * `tileBoxLowerBoundMeters` is deliberately conservative (it subtracts a
 * margin), so this under-claims coverage rather than over-claiming — the
 * failure mode is showing a notable article twice as far out as strictly
 * necessary, not silently omitting one.
 *
 * Returns `Infinity` when every existing tile is loaded, i.e. the exhaustive
 * tier already covers the planet and no far-field entry is needed.
 */
export function coverageRadiusMeters(
  tiles: ReadonlyMap<string, TileEntry>,
  loadedIds: ReadonlySet<string>,
  lat: number,
  lon: number,
): number {
  let nearest = Infinity;
  for (const id of tiles.keys()) {
    if (loadedIds.has(id)) continue;
    const bound = tileBoxLowerBoundMeters(id, lat, lon);
    if (bound < nearest) nearest = bound;
  }
  return nearest;
}

export interface BrowseListInput {
  position: UserPosition;
  /** Exhaustive articles from the loaded tiles, nearest first. */
  local: readonly NearbyArticle[];
  /** The far-field tier for the current language. */
  farField: readonly FarFieldEntry[];
  /** Radius within which `local` is complete (see coverageRadiusMeters). */
  coverageRadiusM: number;
  /** Weight floor from the Highlights filter, or undefined for no filter. */
  minWeight?: number;
}

/**
 * Merge the exhaustive and far-field tiers into the distance-ordered list the
 * user scrolls.
 *
 * Local articles beyond the coverage radius are dropped rather than kept.
 * Keeping them would make density depend on which direction the user faces —
 * hundreds of articles at 600 km where a tile happens to be loaded, three
 * where one is not — which reads as a broken list. Dropping them costs only
 * the long tail in partly-covered cells, because the far-field tier still
 * carries those cells' notable articles.
 */
export function buildBrowseList(input: BrowseListInput): NearbyArticle[] {
  const { position, local, farField, coverageRadiusM, minWeight } = input;

  const merged: NearbyArticle[] = [];
  const seen = new Set<string>();

  // `local` is nearest-first, so the first article past the coverage radius
  // ends the exhaustive tier.
  for (const article of local) {
    if (article.distanceM > coverageRadiusM) break;
    if (merged.length >= LOCAL_EXHAUSTIVE_MAX) break;
    merged.push(article);
    seen.add(article.title);
  }

  // Title dedupe is the only guard needed. A far-field entry inside the
  // covered radius is either already in the exhaustive tier — caught here —
  // or comes from a cell too sparse to have produced a tile at all, in which
  // case it is the sole way that article can ever be reached.
  for (const entry of farField) {
    if (minWeight !== undefined && entry.weight < minWeight) continue;
    if (seen.has(entry.title)) continue;
    merged.push({
      title: entry.title,
      lat: entry.lat,
      lon: entry.lon,
      distanceM: distanceBetweenPositions(position, entry),
      weight: entry.weight,
    });
  }

  merged.sort((a, b) => a.distanceM - b.distanceM);
  return merged;
}
