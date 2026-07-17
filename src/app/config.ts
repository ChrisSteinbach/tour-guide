import type { ArticleFilter } from "./types";

/** User-visible application name (PWA manifest, headers, title). */
export const APP_NAME = "WikiRadar";

// ── Highlights filter ────────────────────────────────────────

/**
 * Fraction of a language's articles (by monthly pageviews) that count as
 * "highlights". Weight classes are popularity percentiles (0-255, see
 * src/pipeline/popularity.ts), so this single knob calibrates per language
 * automatically. The old fixed 8 KiB page_len threshold passed wildly
 * different fractions per language (en 22%, de 19%, ja 28%, sv 4% — Swedish
 * is dominated by bot-created stubs); a uniform top-20% keeps the Highlights
 * density consistent everywhere.
 */
export const HIGHLIGHT_TOP_FRACTION = 0.2;

/** HIGHLIGHT_TOP_FRACTION expressed as a per-vertex weight-class floor (= 204). */
export const HIGHLIGHT_MIN_WEIGHT = Math.round(
  255 * (1 - HIGHLIGHT_TOP_FRACTION),
);

/**
 * Map the article filter to the optional weight floor passed to
 * nearest-neighbor queries. "all" applies no filter.
 */
export function filterMinWeight(filter: ArticleFilter): number | undefined {
  return filter === "highlights" ? HIGHLIGHT_MIN_WEIGHT : undefined;
}
