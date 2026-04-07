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
  onWindowChange?: () => void;
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
  /** Return articles from index 0 up to loadedEnd as a contiguous array. */
  getLoadedArticles(): NearbyArticle[];
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
      const newStart = loadedStart + excess;
      for (let i = loadedStart; i < newStart; i++) articles.delete(i);
      loadedStart = newStart;
    } else {
      const newEnd = loadedEnd - excess;
      for (let i = newEnd; i < loadedEnd; i++) articles.delete(i);
      loadedEnd = newEnd;
    }
  }

  return {
    getArticle(index) {
      return articles.get(index);
    },

    async ensureRange(start, end) {
      if (pendingFetch) await pendingFetch;

      if (articles.size > 0 && start >= loadedStart && end <= loadedEnd) return;

      let fetchStart: number;
      let fetchEnd: number;

      if (articles.size === 0) {
        fetchStart = start;
        fetchEnd = end;
      } else if (end > loadedEnd) {
        fetchStart = Math.max(start, loadedEnd);
        fetchEnd = end;
      } else {
        fetchStart = start;
        fetchEnd = Math.min(end, loadedStart);
      }

      const doFetch = async () => {
        const result = await provider.fetchRange(fetchStart, fetchEnd);
        total = result.totalAvailable;

        for (let i = 0; i < result.articles.length; i++) {
          articles.set(fetchStart + i, result.articles[i]);
        }

        // First load
        if (articles.size === result.articles.length && loadedEnd === 0) {
          loadedStart = fetchStart;
          loadedEnd = fetchStart + result.articles.length;
        } else {
          loadedStart = Math.min(loadedStart, fetchStart);
          loadedEnd = Math.max(loadedEnd, fetchStart + result.articles.length);
        }

        evictIfNeeded(start, end);
        pendingFetch = null;
        onWindowChange?.();
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

    getLoadedArticles() {
      const result: NearbyArticle[] = [];
      for (let i = 0; i < loadedEnd; i++) {
        const article = articles.get(i);
        if (article) result.push(article);
      }
      return result;
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
