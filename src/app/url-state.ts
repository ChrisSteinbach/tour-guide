// URL hash <-> app location state.
//
// The position (and optionally the language) is encoded in the URL fragment
// so every view is a shareable permalink, e.g.
//   https://…/#41.8902,12.4922&lang=sv
// On boot we restore that state; while browsing we mirror the live position
// back into the address bar. All functions here are pure / dependency-injected
// so they can be unit-tested without a real History or Location.

import { SUPPORTED_LANGS } from "../lang";
import type { Lang } from "../lang";
import type { ArticleFilter, UserPosition } from "./types";

/** Parsed result of a location hash: always a position, optionally a language. */
export interface LocationHashState {
  position: UserPosition;
  /** Supported language from the hash, or undefined when absent/unrecognised. */
  lang?: Lang;
  /** Article filter from the hash, or undefined when absent/unrecognised. */
  filter?: ArticleFilter;
}

/** Number of decimal places used when encoding lat/lon (~11 m precision). */
const COORD_PRECISION = 4;

function isSupportedLang(value: string): value is Lang {
  return (SUPPORTED_LANGS as readonly string[]).includes(value);
}

/**
 * Parse a location hash into a position (+ optional language).
 *
 * Accepts `#lat,lon` plus optional `&lang=xx` and `&filter=all` params; the
 * leading `#` is optional.
 * Returns null for anything that isn't a valid coordinate pair:
 *   - non-finite numbers / junk text
 *   - latitude outside [-90, 90] or longitude outside [-180, 180]
 *
 * A missing or unsupported `lang` yields `lang: undefined` but still keeps the
 * position — sharing a link must never silently drop a recognised location just
 * because the language is unknown. The same applies to `filter`: unknown values
 * yield `filter: undefined` (the caller falls back to its default).
 */
export function parseLocationHash(hash: string): LocationHashState | null {
  if (!hash) return null;
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;

  const [coordPart, ...params] = raw.split("&");
  const coords = coordPart.split(",");
  if (coords.length !== 2) return null;

  const latStr = coords[0].trim();
  const lonStr = coords[1].trim();
  if (latStr === "" || lonStr === "") return null;

  const lat = Number(latStr);
  const lon = Number(lonStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90) return null;
  if (lon < -180 || lon > 180) return null;

  let lang: Lang | undefined;
  let filter: ArticleFilter | undefined;
  for (const param of params) {
    const eq = param.indexOf("=");
    if (eq === -1) continue;
    const key = param.slice(0, eq);
    const value = param.slice(eq + 1);
    if (key === "lang" && isSupportedLang(value)) {
      lang = value;
    }
    if (key === "filter" && (value === "all" || value === "highlights")) {
      filter = value;
    }
  }

  return { position: { lat, lon }, lang, filter };
}

/**
 * Encode a position + language (+ filter) into a location hash. The language
 * is always included so a shared link is fully self-describing, e.g.
 *   #41.8902,12.4922&lang=en
 * The filter is only included when it differs from the default ("highlights"),
 * so default-state URLs stay clean:
 *   #41.8902,12.4922&lang=en&filter=all
 */
export function encodeLocationHash(
  position: UserPosition,
  lang: Lang,
  filter: ArticleFilter = "highlights",
): string {
  const lat = position.lat.toFixed(COORD_PRECISION);
  const lon = position.lon.toFixed(COORD_PRECISION);
  const filterParam = filter === "all" ? "&filter=all" : "";
  return `#${lat},${lon}&lang=${lang}${filterParam}`;
}

export interface UrlMirrorDeps {
  /** Reads the current history.state (preserved across updates) and writes via replaceState. */
  history: Pick<History, "replaceState" | "state">;
  /** Reads the current fragment so we can skip no-op writes. */
  location: Pick<Location, "hash">;
}

/**
 * Build a function that mirrors the live (position, language, filter) into the
 * address bar via `history.replaceState`, never pushing a new history entry.
 *
 * Key behaviours:
 *   - No-op when there is no position (e.g. the welcome screen).
 *   - Skips the write when the encoded hash already matches the current one,
 *     so sub-4dp GPS jitter doesn't spam replaceState.
 *   - Passes the existing `history.state` through untouched, so the
 *     `{ view: … }` objects that drive back-navigation survive the update.
 */
export function createUrlMirror(
  deps: UrlMirrorDeps,
): (position: UserPosition | null, lang: Lang, filter?: ArticleFilter) => void {
  return (position, lang, filter) => {
    if (!position) return;
    const nextHash = encodeLocationHash(position, lang, filter);
    if (nextHash === deps.location.hash) return;
    deps.history.replaceState(deps.history.state, "", nextHash);
  };
}
