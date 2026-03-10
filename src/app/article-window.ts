// Distance-windowed data model for infinite scroll.
// Maintains a sliding window of articles sorted by distance.
// Synchronous reads, async expansion. No DOM, no network.

import type { NearbyArticle } from "./types";

export interface FetchResult {
  articles: NearbyArticle[];
  totalAvailable: number;
}

/** Provides articles by index range. Injected dependency. */
export interface ArticleProvider {
  fetchRange(start: number, end: number): Promise<FetchResult>;
}

export interface ArticleWindowOptions {
  /** Max articles to keep in memory before evicting. */
  windowSize: number;
  /** Called when the loaded data range changes. */
  onWindowChange?: (start: number, end: number) => void;
}

export interface ArticleWindow {
  /** Get an article by index, or undefined if not in the current window. */
  getArticle(index: number): NearbyArticle | undefined;
  /** Ensure articles in [start, end) are loaded. Fetches if needed. */
  ensureRange(start: number, end: number): Promise<void>;
  /** How many articles are known to exist (from the provider). */
  totalKnown(): number;
  /** The exclusive end of the contiguous loaded range. */
  loadedCount(): number;
  /** Clear all loaded data. */
  reset(): void;
}

export function createArticleWindow(
  provider: ArticleProvider,
  options: ArticleWindowOptions,
): ArticleWindow {
  const { windowSize, onWindowChange } = options;

  // Sparse storage: maps global index → article
  let articles = new Map<number, NearbyArticle>();
  // The contiguous range we've loaded: [loadedStart, loadedEnd)
  let loadedStart = 0;
  let loadedEnd = 0;
  let total = 0;
  // Serialization: concurrent ensureRange calls queue behind in-flight fetch
  let pendingFetch: Promise<void> | null = null;

  function evictIfNeeded(requestedStart: number, requestedEnd: number): void {
    if (articles.size <= windowSize) return;

    const excess = articles.size - windowSize;
    // Evict from whichever end is farthest from the requested range
    const distFromStart = requestedStart - loadedStart;
    const distFromEnd = loadedEnd - requestedEnd;

    if (distFromStart >= distFromEnd) {
      // Evict from the start (scrolling forward)
      const newStart = loadedStart + excess;
      for (let i = loadedStart; i < newStart; i++) {
        articles.delete(i);
      }
      loadedStart = newStart;
    } else {
      // Evict from the end (scrolling backward)
      const newEnd = loadedEnd - excess;
      for (let i = newEnd; i < loadedEnd; i++) {
        articles.delete(i);
      }
      loadedEnd = newEnd;
    }
  }

  return {
    getArticle(index) {
      return articles.get(index);
    },

    async ensureRange(start, end) {
      // Serialize: wait for any in-flight fetch before proceeding
      if (pendingFetch) {
        await pendingFetch;
      }

      // Re-check after awaiting — previous fetch may have loaded our range
      if (articles.size > 0 && start >= loadedStart && end <= loadedEnd) {
        return;
      }

      // Compute what we actually need to fetch
      let fetchStart: number;
      let fetchEnd: number;

      if (articles.size === 0) {
        fetchStart = start;
        fetchEnd = end;
      } else if (end > loadedEnd) {
        // Expanding forward
        fetchStart = Math.max(start, loadedEnd);
        fetchEnd = end;
      } else {
        // Expanding backward (scrolling back to evicted data)
        fetchStart = start;
        fetchEnd = Math.min(end, loadedStart);
      }

      const doFetch = async () => {
        const result = await provider.fetchRange(fetchStart, fetchEnd);
        total = result.totalAvailable;

        for (let i = 0; i < result.articles.length; i++) {
          articles.set(fetchStart + i, result.articles[i]);
        }

        // Update loaded range
        if (articles.size === result.articles.length && loadedEnd === 0) {
          // First load
          loadedStart = fetchStart;
          loadedEnd = fetchStart + result.articles.length;
        } else {
          loadedStart = Math.min(loadedStart, fetchStart);
          loadedEnd = Math.max(loadedEnd, fetchStart + result.articles.length);
        }

        evictIfNeeded(start, end);

        pendingFetch = null;

        onWindowChange?.(loadedStart, loadedEnd);
      };

      pendingFetch = doFetch();
      return pendingFetch;
    },

    totalKnown() {
      return total;
    },

    loadedCount() {
      return loadedEnd;
    },

    reset() {
      articles = new Map();
      loadedStart = 0;
      loadedEnd = 0;
      total = 0;
      pendingFetch = null;
    },
  };
}
