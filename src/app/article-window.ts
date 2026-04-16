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
  /** The exclusive end of the highest loaded segment. */
  loadedCount(): number;
  /** Return articles from index 0 up to loadedCount as a contiguous array. */
  getLoadedArticles(): NearbyArticle[];
  /** Clear all loaded data. */
  reset(): void;
}

interface Segment {
  start: number;
  end: number;
}

export function createArticleWindow(
  provider: ArticleProvider,
  options: ArticleWindowOptions,
): ArticleWindow {
  const { windowSize, onWindowChange } = options;

  // Sparse storage: maps global index → article
  let articles = new Map<number, NearbyArticle>();
  // Disjoint, sorted-by-start segments of loaded indices. An index `i` is
  // loaded iff there exists some seg with seg.start <= i < seg.end. Using a
  // segment list (rather than a single [loadedStart, loadedEnd) pair) lets us
  // correctly represent the state after a backward jump from a deep scroll,
  // where the fetched range is disjoint from previously-cached entries.
  let segments: Segment[] = [];
  let total = 0;
  // Serialization: concurrent ensureRange calls queue behind in-flight fetch
  let pendingFetch: Promise<void> | null = null;

  function isRangeCovered(start: number, end: number): boolean {
    if (start >= end) return true;
    for (const seg of segments) {
      if (seg.start <= start && end <= seg.end) return true;
      if (seg.start > start) return false;
    }
    return false;
  }

  function firstMissingSubrange(start: number, end: number): Segment | null {
    if (start >= end) return null;
    let cursor = start;
    for (const seg of segments) {
      if (seg.end <= cursor) continue;
      if (seg.start > cursor) {
        return { start: cursor, end: Math.min(seg.start, end) };
      }
      cursor = seg.end;
      if (cursor >= end) return null;
    }
    return { start: cursor, end };
  }

  function addSegment(s: number, e: number): void {
    if (s >= e) return;
    const next: Segment[] = [];
    let merged: Segment = { start: s, end: e };
    let placed = false;
    for (const seg of segments) {
      if (seg.end < merged.start) {
        next.push(seg);
      } else if (seg.start > merged.end) {
        if (!placed) {
          next.push(merged);
          placed = true;
        }
        next.push(seg);
      } else {
        merged = {
          start: Math.min(merged.start, seg.start),
          end: Math.max(merged.end, seg.end),
        };
      }
    }
    if (!placed) next.push(merged);
    segments = next;
  }

  function evictIfNeeded(requestedStart: number, requestedEnd: number): void {
    if (articles.size <= windowSize) return;
    let excess = articles.size - windowSize;
    if (segments.length === 0) return;

    const firstSeg = segments[0];
    const lastSeg = segments[segments.length - 1];
    const distFromStart = requestedStart - firstSeg.start;
    const distFromEnd = lastSeg.end - requestedEnd;

    if (distFromStart >= distFromEnd) {
      // Evict from the low-index end
      while (excess > 0 && segments.length > 0) {
        const seg = segments[0];
        const size = seg.end - seg.start;
        const take = Math.min(excess, size);
        for (let i = seg.start; i < seg.start + take; i++) articles.delete(i);
        if (take === size) segments.shift();
        else seg.start += take;
        excess -= take;
      }
    } else {
      // Evict from the high-index end
      while (excess > 0 && segments.length > 0) {
        const seg = segments[segments.length - 1];
        const size = seg.end - seg.start;
        const take = Math.min(excess, size);
        for (let i = seg.end - take; i < seg.end; i++) articles.delete(i);
        if (take === size) segments.pop();
        else seg.end -= take;
        excess -= take;
      }
    }
  }

  return {
    getArticle(index) {
      return articles.get(index);
    },

    async ensureRange(start, end) {
      if (pendingFetch) await pendingFetch;

      if (isRangeCovered(start, end)) return;

      const missing = firstMissingSubrange(start, end);
      if (!missing) return;

      const doFetch = async () => {
        try {
          const result = await provider.fetchRange(missing.start, missing.end);
          total = result.totalAvailable;

          for (let i = 0; i < result.articles.length; i++) {
            articles.set(missing.start + i, result.articles[i]);
          }
          if (result.articles.length > 0) {
            addSegment(missing.start, missing.start + result.articles.length);
          }

          evictIfNeeded(start, end);
          onWindowChange?.();
        } finally {
          pendingFetch = null;
        }
      };

      pendingFetch = doFetch();
      return pendingFetch;
    },

    totalKnown() {
      return total;
    },

    loadedCount() {
      return segments.length > 0 ? segments[segments.length - 1].end : 0;
    },

    getLoadedArticles() {
      const result: NearbyArticle[] = [];
      const end = segments.length > 0 ? segments[segments.length - 1].end : 0;
      for (let i = 0; i < end; i++) {
        const article = articles.get(i);
        if (article) result.push(article);
      }
      return result;
    },

    reset() {
      articles = new Map();
      segments = [];
      total = 0;
      pendingFetch = null;
    },
  };
}
