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
 * Notified whenever the lifecycle's tracked scroll count changes —
 * either from an async fetch completing (onWindowChange) or from an
 * optimistic pre-fetch (applyOptimisticCount). The caller decides
 * whether to forward the update to a live scroll surface.
 */
export type ScrollCountObserver = (
  count: number,
  loadedCount: number | undefined,
) => void;

/**
 * Notified whenever the ArticleWindow's loaded articles change.
 * The caller wires this to the state machine so it can sync
 * `state.phase.articles` with the ArticleWindow's ordering.
 */
export type ArticlesObserver = (articles: NearbyArticle[]) => void;

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
  /**
   * Attach the observer that receives article-list updates when the
   * ArticleWindow loads new tiles and re-sorts. Follows the same
   * attach/detach contract as scrollCountObserver.
   */
  attachArticlesObserver: (observer: ArticlesObserver | null) => void;
}

export function createArticleWindowLifecycle(
  deps: ArticleWindowLifecycleDeps,
): ArticleWindowLifecycle {
  let articleWindow: ArticleWindow | null = null;
  let articleWindowAbort: AbortController | null = null;
  let windowPosition: UserPosition | null = null;
  let lastScrollCount = 0;
  let scrollCountObserver: ScrollCountObserver | null = null;
  let articlesObserver: ArticlesObserver | null = null;

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
        lastScrollCount = articleWindow.loadedCount();
        scrollCountObserver?.(lastScrollCount, articleWindow.loadedCount());

        const loadedArticles = articleWindow.getLoadedArticles();
        if (loadedArticles.length > 0) {
          articlesObserver?.(loadedArticles);
        }
      },
    });

    return articleWindow;
  }

  function applyOptimisticCount(count: number): void {
    lastScrollCount = Math.max(lastScrollCount, count);
    scrollCountObserver?.(lastScrollCount, articleWindow?.loadedCount());
  }

  function getArticleByIndex(i: number): NearbyArticle | undefined {
    if (articleWindow) {
      const article = articleWindow.getArticle(i);
      if (article) return article;
    }
    // Fallback: use viewport articles before the ArticleWindow's first
    // onWindowChange fires (i.e. during the brief window between
    // ensureRange and the first tile load completing). Once
    // onWindowChange fires, articlesObserver syncs the state machine's
    // articles from the ArticleWindow, so the two stay in sync.
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

  function attachArticlesObserver(observer: ArticlesObserver | null): void {
    if (observer !== null && articlesObserver !== null) {
      throw new Error("articlesObserver already attached — detach first");
    }
    articlesObserver = observer;
  }

  return {
    ensureArticleRange,
    resetArticleWindow,
    getOrCreateArticleWindow,
    getArticleByIndex,
    currentWindow: () => articleWindow,
    applyOptimisticCount,
    attachScrollCountObserver,
    attachArticlesObserver,
  };
}
