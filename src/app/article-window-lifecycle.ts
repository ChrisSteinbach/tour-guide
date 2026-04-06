// Article window lifecycle — extracted from main.ts for testability.
// Manages the ArticleWindow instance, its AbortController, and the
// reset→create→ensureRange→render orchestration.

import type { ArticleWindow } from "./article-window";
import type { NearbyArticle, UserPosition } from "./types";
import type { NearestQuery } from "./query";
import type { TileEntry } from "../tiles";
import type { Lang } from "../lang";
import type { AppState } from "./state-machine";

export interface CreateWindowOpts {
  position: UserPosition;
  tileMap: Map<string, TileEntry>;
  lang: Lang;
  signal: AbortSignal;
  getStateMachineTiles: () => ReadonlyMap<string, NearestQuery>;
  onWindowChange?: () => void;
}

/**
 * Compute the optimistic article count for infinite scroll height.
 * Returns the best-known total: `known` when the provider reports more
 * articles than are loaded, otherwise `loaded`.  No phantom buffer is
 * added — the nearEndThreshold in the virtual list already triggers
 * onNearEnd before the user reaches the bottom.
 */
export function computeOptimisticCount(known: number, loaded: number): number {
  // When nothing is loaded yet we can't estimate a count — return 0 even if
  // known > 0, because showing scroll headroom before any articles are rendered
  // would create an empty list that jumps once the first batch arrives.
  if (loaded === 0) return 0;
  return Math.max(known, loaded);
}

/**
 * Notified whenever the lifecycle's tracked scroll count changes —
 * either from an async fetch completing (onWindowChange) or from an
 * optimistic pre-fetch (applyOptimisticCount). The caller decides
 * whether to forward the update to a live scroll surface.
 */
export type ScrollCountObserver = (
  count: number,
  loadedCount: number | undefined,
) => void;

export interface ArticleWindowLifecycleDeps {
  getState: () => AppState;
  createArticleWindow: (opts: CreateWindowOpts) => ArticleWindow;
  renderBrowsingList: () => void;
}

export interface ArticleWindowLifecycle {
  ensureArticleRange: (pos: UserPosition, count: number) => void;
  resetArticleWindow: () => void;
  getOrCreateArticleWindow: () => ArticleWindow;
  getArticleByIndex: (i: number) => NearbyArticle | undefined;
  currentWindow: () => ArticleWindow | null;
  applyOptimisticCount: (count: number) => void;
  /**
   * Attach the observer that receives scroll-count updates. Callers wire
   * this to their scroll surface (e.g. infinite-scroll.update) after
   * both the lifecycle and the scroll surface have been constructed —
   * breaking the mutual-initialization cycle between the two.
   *
   * Throws if an observer is already attached — detach first by passing
   * `null`.  There is exactly one subscriber, so silent overwrite is a bug.
   */
  attachScrollCountObserver: (observer: ScrollCountObserver | null) => void;
}

export function createArticleWindowLifecycle(
  deps: ArticleWindowLifecycleDeps,
): ArticleWindowLifecycle {
  let articleWindow: ArticleWindow | null = null;
  let articleWindowAbort: AbortController | null = null;
  let windowPosition: UserPosition | null = null;
  let lastScrollCount = 0;
  let scrollCountObserver: ScrollCountObserver | null = null;

  function resetArticleWindow(): void {
    if (articleWindow) {
      articleWindow.reset();
      articleWindow = null;
    }
    if (articleWindowAbort) {
      articleWindowAbort.abort();
      articleWindowAbort = null;
    }
    windowPosition = null;
    lastScrollCount = 0;
  }

  function getOrCreateArticleWindow(): ArticleWindow {
    if (articleWindow) return articleWindow;

    const state = deps.getState();
    if (state.query.mode !== "tiled" || !state.position) {
      throw new Error(
        "Cannot create ArticleWindow without tiled query and position",
      );
    }

    articleWindowAbort = new AbortController();

    articleWindow = deps.createArticleWindow({
      position: state.position,
      tileMap: state.query.tileMap,
      lang: state.currentLang,
      signal: articleWindowAbort.signal,
      getStateMachineTiles: () => {
        const current = deps.getState();
        if (current.query.mode === "tiled") return current.query.tiles;
        return new Map();
      },
      onWindowChange: () => {
        if (!articleWindow) return;
        // Use totalKnown (all articles from loaded tiles) rather than
        // loadedCount to provide scroll headroom beyond the fetched range.
        // Never shrink — reducing the count while the user is scrolled
        // deep causes the same scroll jump this fix exists to prevent.
        const realCount = Math.max(
          articleWindow.totalKnown(),
          articleWindow.loadedCount(),
        );
        lastScrollCount = Math.max(lastScrollCount, realCount);
        scrollCountObserver?.(lastScrollCount, articleWindow.loadedCount());
      },
    });

    return articleWindow;
  }

  function applyOptimisticCount(count: number): void {
    lastScrollCount = Math.max(lastScrollCount, count);
    scrollCountObserver?.(lastScrollCount, articleWindow?.loadedCount());
  }

  let prefixInvariantChecked = false;

  function getArticleByIndex(i: number): NearbyArticle | undefined {
    if (articleWindow) {
      const article = articleWindow.getArticle(i);
      if (article) {
        // Dev-mode assertion: verify viewport articles are a prefix of
        // ArticleWindow results. Fires at most once per lifecycle.
        if (import.meta.env.DEV && !prefixInvariantChecked) {
          const state = deps.getState();
          if (
            state.phase.phase === "browsing" &&
            state.phase.articles.length > 0
          ) {
            prefixInvariantChecked = true;
            for (let j = 0; j < state.phase.articles.length; j++) {
              const awArticle = articleWindow.getArticle(j);
              if (!awArticle) break;
              if (state.phase.articles[j].title !== awArticle.title) {
                console.assert(
                  false,
                  `Prefix invariant violated at index ${j}: viewport has "${state.phase.articles[j].title}" but ArticleWindow has "${awArticle.title}"`,
                );
                break;
              }
            }
          }
        }
        return article;
      }
    }
    // Fallback: use viewport articles while ArticleWindow is loading.
    // This is only safe when the viewport articles are a prefix of the
    // eventual ArticleWindow results. If that invariant breaks, index i
    // may refer to a different article.
    const state = deps.getState();
    if (state.phase.phase === "browsing") return state.phase.articles[i];
    return undefined;
  }

  function ensureArticleRange(pos: UserPosition, count: number): void {
    const posChanged =
      !windowPosition ||
      pos.lat !== windowPosition.lat ||
      pos.lon !== windowPosition.lon;

    if (posChanged) {
      resetArticleWindow();
    }

    const aw = getOrCreateArticleWindow();
    windowPosition = pos;
    void aw.ensureRange(0, count);
    deps.renderBrowsingList();
  }

  function attachScrollCountObserver(
    observer: ScrollCountObserver | null,
  ): void {
    if (observer !== null && scrollCountObserver !== null) {
      throw new Error("scrollCountObserver already attached — detach first");
    }
    scrollCountObserver = observer;
  }

  return {
    ensureArticleRange,
    resetArticleWindow,
    getOrCreateArticleWindow,
    getArticleByIndex,
    currentWindow: () => articleWindow,
    applyOptimisticCount,
    attachScrollCountObserver,
  };
}
