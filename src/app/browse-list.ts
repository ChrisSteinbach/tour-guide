// The browse list: one distance-ordered list of the whole globe, with detail
// that falls off as distance grows.
//
// Tiles give exhaustive coverage, but only near the user — reaching the
// furthest article by loading tiles means downloading every one of them, and a
// 1:1 virtual list of every article would be taller than the element-height
// ceiling browsers enforce. So the list is built at three levels of detail:
//
//   everything            out to FULL_DETAIL_RADIUS_M
//   DISTANCE_BAND_QUOTA   per doubling of distance, out to the radius the
//     most notable         loaded tiles actually cover
//   the far-field tier    beyond that: the most notable articles from every
//                          cell on Earth (see src/farfield.ts)
//
// Grading the middle level is what makes the list scrollable rather than
// merely long. Ungraded, the nearest 5,000 articles to central London all sit
// within 4.6 km — while the tiles already in memory cover 112 km — so the list
// spent its whole near field on one neighbourhood and then fell off a cliff
// onto 25-articles-per-5°-cell. Sampling per distance band spends the same
// number of rows on each doubling of distance instead, which is what a map
// does with labels, and it costs nothing to download.
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
 * Radius within which the exhaustive tier is kept whole, with no notability
 * sampling at all. "Everything within walking distance" is the promise the app
 * exists to keep, so this band is never thinned — in the densest cities it is
 * around a thousand articles, and everywhere else it is however many there are.
 */
export const FULL_DETAIL_RADIUS_M = 1_000;

/**
 * Articles kept per doubling of distance beyond `FULL_DETAIL_RADIUS_M`, most
 * notable first.
 *
 * A constant per-band quota makes every doubling of distance cost the same
 * number of rows, so scrolling a fixed distance zooms out by a fixed factor.
 * It is also self-calibrating: a band with fewer articles than the quota keeps
 * all of them, so sparse regions are still exhaustive and only dense ones are
 * sampled.
 */
export const DISTANCE_BAND_QUOTA = 250;

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

/**
 * Thin the exhaustive tier so detail falls off with distance: everything
 * within `FULL_DETAIL_RADIUS_M`, then the `DISTANCE_BAND_QUOTA` most notable
 * articles from each subsequent doubling of distance.
 *
 * Bands are geometric rather than linear because that is how the list is read.
 * Equal-width bands would put almost every row in the outermost one — the area
 * of a band grows with its radius — which is the density cliff this exists to
 * remove.
 *
 * Input order is irrelevant and output order is unspecified; callers sort the
 * merged list by distance anyway.
 */
export function sampleByDistanceBand(
  local: readonly NearbyArticle[],
): NearbyArticle[] {
  const kept: NearbyArticle[] = [];
  const bands = new Map<number, NearbyArticle[]>();

  for (const article of local) {
    if (article.distanceM <= FULL_DETAIL_RADIUS_M) {
      kept.push(article);
      continue;
    }
    const band = Math.floor(
      Math.log2(article.distanceM / FULL_DETAIL_RADIUS_M),
    );
    const bucket = bands.get(band);
    if (bucket) bucket.push(article);
    else bands.set(band, [article]);
  }

  for (const bucket of bands.values()) {
    if (bucket.length > DISTANCE_BAND_QUOTA) {
      bucket.sort(byNotability);
      bucket.length = DISTANCE_BAND_QUOTA;
    }
    kept.push(...bucket);
  }

  return kept;
}

/** Most notable first; among equally notable articles, nearest first. */
function byNotability(a: NearbyArticle, b: NearbyArticle): number {
  const weightGap = (b.weight ?? 0) - (a.weight ?? 0);
  return weightGap !== 0 ? weightGap : a.distanceM - b.distanceM;
}

export interface BrowseListInput {
  position: UserPosition;
  /**
   * Every article the loaded tiles hold inside the coverage radius (see
   * `coverageRadiusMeters`), in any order. Bounding this at the query is what
   * keeps the tier free of holes: articles past that radius are present only
   * in whichever direction a tile happens to be loaded, so including them
   * would make density depend on which way the user faces — hundreds of
   * articles at 600 km one way, three the other — which reads as a broken
   * list.
   */
  local: readonly NearbyArticle[];
  /** The far-field tier for the current language. */
  farField: readonly FarFieldEntry[];
  /** Weight floor from the Highlights filter, or undefined for no filter. */
  minWeight?: number;
}

/**
 * Merge the exhaustive and far-field tiers into the distance-ordered list the
 * user scrolls, sampling the exhaustive tier by distance band on the way in.
 */
export function buildBrowseList(input: BrowseListInput): NearbyArticle[] {
  const { position, local, farField, minWeight } = input;

  const merged = sampleByDistanceBand(local);
  const seen = new Set(merged.map((article) => article.title));

  // Title dedupe is the only guard needed. A far-field entry inside the
  // covered radius is either already listed — caught here — or it is one the
  // band sampling dropped, or it comes from a cell too sparse to have produced
  // a tile at all. In the last two cases it belongs: the far-field tier is
  // itself a notability ranking, so an entry it carries has already earned a
  // row.
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
