import { haversineDistance } from "../geometry/index";
import type { UserPosition, Article } from "./types";
import type { Lang } from "../lang";

const EARTH_RADIUS_M = 6_371_000;

/** Compute distance in meters between a user position and an article. */
export function distanceMeters(from: UserPosition, to: Article): number {
  return haversineDistance(from, to) * EARTH_RADIUS_M;
}

/** Human-readable distance string: meters below 1 km, km above. */
export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  const km = meters / 1000;
  return km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
}

/** Full Wikipedia article URL from a title. */
export function wikipediaUrl(title: string, lang: Lang = "en"): string {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}
