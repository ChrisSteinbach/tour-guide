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

/** Compute distance in meters between two user positions. */
export function distanceBetweenPositions(
  a: UserPosition,
  b: UserPosition,
): number {
  return haversineDistance(a, b) * EARTH_RADIUS_M;
}

/** Build a directions URL appropriate for the current platform. */
export function directionsUrl(lat: number, lon: number): string {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) {
    return `https://maps.apple.com/?daddr=${lat},${lon}`;
  }
  if (/Android/.test(ua)) {
    return `geo:${lat},${lon}?q=${lat},${lon}`;
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
}

/** Full Wikipedia article URL from a title. */
export function wikipediaUrl(title: string, lang: Lang = "en"): string {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}
