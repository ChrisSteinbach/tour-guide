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
   * Weight class 0-255 derived from page length (see pageLenToWeight in
   * src/geometry); 0 or absent when unknown. Always populated on articles
   * produced by nearest-neighbor queries.
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
 * articles with substantial pages (weight >= HIGHLIGHT_MIN_WEIGHT in
 * config.ts); "all" shows everything, including bot-generated stubs.
 */
export type ArticleFilter = "highlights" | "all";
