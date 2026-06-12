import { pageLenToWeight } from "../geometry";
import type { ArticleFilter } from "./types";

/** User-visible application name (PWA manifest, headers, title). */
export const APP_NAME = "WikiRadar";

// ── Highlights filter ────────────────────────────────────────

/**
 * Minimum Wikipedia page length (bytes of wikitext) for an article to count
 * as a "highlight". This byte threshold is the tunable knob — adjust it and
 * the derived weight constant below follows automatically.
 */
export const HIGHLIGHT_MIN_PAGE_LEN = 8 * 1024;

/** HIGHLIGHT_MIN_PAGE_LEN expressed as a per-vertex weight class (= 104). */
export const HIGHLIGHT_MIN_WEIGHT = pageLenToWeight(HIGHLIGHT_MIN_PAGE_LEN);

/**
 * Map the article filter to the optional weight floor passed to
 * nearest-neighbor queries. "all" applies no filter.
 */
export function filterMinWeight(filter: ArticleFilter): number | undefined {
  return filter === "highlights" ? HIGHLIGHT_MIN_WEIGHT : undefined;
}
