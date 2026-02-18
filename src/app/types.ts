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
