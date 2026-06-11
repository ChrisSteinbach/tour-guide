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
}

/** The user's current geographic position. */
export interface UserPosition {
  lat: number;
  lon: number;
}

/** Where the browsing position comes from: live GPS or a map-picked spot. */
export type PositionSource = "gps" | "picked";
