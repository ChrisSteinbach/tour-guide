// Concurrency-limited, cancellable batch fetcher for article summaries.
// Fetches summaries for a list of articles, calling back per-item as they arrive.

import type { ArticleSummary } from "./wiki-api";
import type { Lang } from "../lang";

export interface SummaryLoaderDeps {
  fetch: (title: string, lang: Lang) => Promise<ArticleSummary>;
  onSummary: (title: string, summary: ArticleSummary) => void;
}

const DEFAULT_CONCURRENCY = 3;

export interface SummaryLoader {
  /** Start fetching summaries for articles. Cancels any previous batch. */
  load: (titles: string[], lang: Lang) => void;
  /**
   * Request a single summary (e.g. from IntersectionObserver). No-op if
   * already fetched/queued. Does NOT invoke `onSummary` for cache hits —
   * callers that want the cached value should use `get()` explicitly.
   * This keeps scroll-settle callbacks from re-firing DOM patches over
   * items whose summaries have already been delivered.
   */
  request: (title: string, lang: Lang) => void;
  /** Get a previously fetched summary, or undefined. */
  get: (title: string) => ArticleSummary | undefined;
  /** Cancel all in-flight fetches. */
  cancel: () => void;
}

export function createSummaryLoader(
  deps: SummaryLoaderDeps,
  concurrency = DEFAULT_CONCURRENCY,
): SummaryLoader {
  const cache = new Map<string, ArticleSummary>();
  let controller: AbortController | null = null;
  let queue: string[] = [];
  let activeLang: Lang = "en";
  let activeCount = 0;
  const pending = new Set<string>();

  function cacheKey(title: string, lang: Lang): string {
    return `${lang}:${title}`;
  }

  function drain(): void {
    if (!controller) return;
    const signal = controller.signal;

    while (activeCount < concurrency && queue.length > 0) {
      const title = queue.shift()!;
      const key = cacheKey(title, activeLang);
      if (cache.has(key) || signal.aborted) {
        pending.delete(title);
        if (cache.has(key)) deps.onSummary(title, cache.get(key)!);
        continue;
      }

      activeCount++;
      deps
        .fetch(title, activeLang)
        .then((summary) => {
          if (signal.aborted) return;
          cache.set(key, summary);
          deps.onSummary(title, summary);
        })
        .catch(() => {
          // Graceful degradation: item stays rendered with title+distance
        })
        .finally(() => {
          pending.delete(title);
          if (!signal.aborted) {
            activeCount--;
            drain();
          }
        });
    }
  }

  function load(titles: string[], lang: Lang): void {
    // Cancel previous batch
    controller?.abort();
    controller = new AbortController();
    cache.clear();
    queue = [];
    activeCount = 0;
    pending.clear();
    activeLang = lang;

    for (const title of titles) {
      if (!pending.has(title)) {
        pending.add(title);
        queue.push(title);
      }
    }

    drain();
  }

  function request(title: string, lang: Lang): void {
    const key = cacheKey(title, lang);
    if (cache.has(key)) return;
    activeLang = lang;
    if (pending.has(title)) {
      // Already queued (e.g. from load()) — move to front so viewport items
      // are fetched before off-screen items still waiting in the queue.
      const idx = queue.indexOf(title);
      if (idx > 0) {
        queue.splice(idx, 1);
        queue.unshift(title);
      }
      return;
    }
    if (!controller || controller.signal.aborted) {
      controller = new AbortController();
    }
    pending.add(title);
    queue.unshift(title);
    drain();
  }

  function get(title: string): ArticleSummary | undefined {
    return cache.get(cacheKey(title, activeLang));
  }

  function cancel(): void {
    controller?.abort();
    controller = null;
    queue = [];
    activeCount = 0;
    pending.clear();
  }

  return { load, request, get, cancel };
}
