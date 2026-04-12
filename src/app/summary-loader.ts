// Concurrency-limited, cancellable batch fetcher for article summaries.
// Fetches summaries for a list of articles, calling back per-item as they arrive.

import { RateLimitError, type ArticleSummary } from "./wiki-api";
import type { Lang } from "../lang";

export interface SummaryLoaderDeps {
  fetch: (title: string, lang: Lang) => Promise<ArticleSummary>;
  onSummary: (title: string, summary: ArticleSummary) => void;
  /**
   * Injectable clock for deterministic tests. Defaults to Date.now.
   */
  now?: () => number;
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
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, ArticleSummary>();
  let controller: AbortController | null = null;
  let queue: string[] = [];
  let activeLang: Lang = "en";
  let activeCount = 0;
  const pending = new Set<string>();

  // Global circuit breaker: when Wikipedia returns 429, pause the entire
  // queue until Retry-After elapses. The rate limit is per-client across
  // the whole endpoint, so retrying any title inside the window just
  // burns requests against an already-blocked wall.
  let rateLimitUntil = 0;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;

  function cacheKey(title: string, lang: Lang): string {
    return `${lang}:${title}`;
  }

  function scheduleResume(): void {
    if (resumeTimer !== null) return;
    const delay = Math.max(0, rateLimitUntil - now());
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      // Do not clear rateLimitUntil here: a concurrent 429 may have
      // extended the window. drain() checks the current value and will
      // reschedule the timer if we still need to wait.
      drain();
    }, delay);
  }

  function drain(): void {
    if (!controller) return;
    const signal = controller.signal;

    if (rateLimitUntil > now()) {
      scheduleResume();
      return;
    }

    while (activeCount < concurrency && queue.length > 0) {
      const title = queue.shift()!;
      const key = cacheKey(title, activeLang);
      if (cache.has(key) || signal.aborted) {
        pending.delete(title);
        if (cache.has(key)) deps.onSummary(title, cache.get(key)!);
        continue;
      }

      activeCount++;
      void runFetch(title, signal);
    }
  }

  async function runFetch(title: string, signal: AbortSignal): Promise<void> {
    const key = cacheKey(title, activeLang);
    try {
      const summary = await deps.fetch(title, activeLang);
      // Clear pending before the abort check: a cancel() or load() that
      // interleaves between fetch resolution and this continuation must
      // not leave the title stuck in `pending`, or a later request() would
      // see it as "already queued" and silently no-op.
      pending.delete(title);
      if (signal.aborted) return;
      cache.set(key, summary);
      deps.onSummary(title, summary);
    } catch (err) {
      if (err instanceof RateLimitError) {
        rateLimitUntil = Math.max(rateLimitUntil, now() + err.retryAfterMs);
        // Keep title in `pending` and re-queue so it retries once the
        // window reopens. Guard with `includes` because an overlapping
        // load() can start a second runFetch for the same title while
        // this (now-stale) one is still resolving; both would otherwise
        // re-push. A fresh load() or cancel() clears pending+queue.
        if (!queue.includes(title)) {
          queue.push(title);
        }
      } else {
        // Graceful degradation: item stays rendered with title+distance.
        pending.delete(title);
      }
    } finally {
      if (!signal.aborted) {
        activeCount--;
        drain();
      }
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
    if (resumeTimer !== null) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
    }
    // Deliberately do NOT reset rateLimitUntil: the rate limit is
    // remote-server state and outlives any local batch. A subsequent
    // load() or request() will re-schedule the resume timer.
  }

  return { load, request, get, cancel };
}
