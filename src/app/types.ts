/** A geotagged Wikipedia article. */
export interface Article {
  title: string;
  lat: number;
  lon: number;
}

/** An article with a computed distance from the user. */
export interface NearbyArticle extends Article {
  /** Distance from the user in meters. */
  distanceM: number;
  /**
   * Weight class 0-255: popularity percentile among the language build's
   * articles by monthly pageviews (see src/pipeline/popularity.ts); 0 or
   * absent when unknown. Always populated on articles produced by
   * nearest-neighbor queries.
   */
  weight?: number;
}

/** The user's current geographic position. */
export interface UserPosition {
  lat: number;
  lon: number;
}

/** Where the browsing position comes from: live GPS or a map-picked spot. */
export type PositionSource = "gps" | "picked";

/**
 * Which articles the nearby list shows: "highlights" (default) keeps only
 * the most popular articles by monthly pageviews (weight >=
 * HIGHLIGHT_MIN_WEIGHT in config.ts); "all" shows everything, including
 * rarely-viewed stubs.
 */
export type ArticleFilter = "highlights" | "all";
