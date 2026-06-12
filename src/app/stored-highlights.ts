import type { ArticleFilter } from "./types";

/** localStorage key for the user's preferred article filter. */
export const HIGHLIGHTS_STORAGE_KEY = "tour-guide-highlights";

/** The filter applied when nothing (valid) is stored. */
export const DEFAULT_FILTER: ArticleFilter = "highlights";

/**
 * Read the user's preferred article filter from localStorage. Unknown values
 * and missing entries fall back to DEFAULT_FILTER ("highlights").
 *
 * Mirrors getStoredLang in stored-lang.ts.
 */
export function getStoredHighlights(
  storage: Pick<Storage, "getItem">,
): ArticleFilter {
  const stored = storage.getItem(HIGHLIGHTS_STORAGE_KEY);
  if (stored === "highlights" || stored === "all") {
    return stored;
  }
  return DEFAULT_FILTER;
}
