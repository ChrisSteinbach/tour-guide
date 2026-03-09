// Debounced map-marker sync: batches visible-range changes and
// syncs browse map markers after a settle period.

import type { VisibleRange } from "./virtual-scroll";

export interface DebouncedMapSyncOptions {
  /** Debounce period in ms before syncing markers. */
  settleMs: number;
  /** Return the article slice for the given range, or null to skip. */
  getVisibleArticles: (range: VisibleRange) => unknown[] | null;
  /** Actually sync the markers with the given articles. */
  syncMarkers: (articles: unknown[]) => void;
}

export interface DebouncedMapSync {
  /** Schedule a debounced sync for the given visible range. */
  sync: (range: VisibleRange) => void;
  /** Cancel any pending sync. */
  cancel: () => void;
}

export function createDebouncedMapSync(
  options: DebouncedMapSyncOptions,
): DebouncedMapSync {
  const { settleMs, getVisibleArticles, syncMarkers } = options;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancel(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function sync(range: VisibleRange): void {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      const articles = getVisibleArticles(range);
      if (articles) syncMarkers(articles);
    }, settleMs);
  }

  return { sync, cancel };
}
