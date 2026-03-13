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
 * Used to expand the list before an async fetch completes so the
 * user never hits the bottom while waiting.
 */
export function computeOptimisticCount(
  known: number,
  loaded: number,
  buffer: number,
  maxLimit: number,
): number {
  if (known > loaded) return known;
  if (loaded === 0) return 0;
  return Math.min(loaded + buffer, maxLimit);
}

export interface ArticleWindowLifecycleDeps {
  getState: () => AppState;
  createArticleWindow: (opts: CreateWindowOpts) => ArticleWindow;
  renderBrowsingList: () => void;
  infiniteScroll: {
    isActive: () => boolean;
    update: (count: number) => void;
  };
}

export interface ArticleWindowLifecycle {
  ensureArticleRange: (count: number) => void;
  resetArticleWindow: () => void;
  getOrCreateArticleWindow: () => ArticleWindow;
  getArticleByIndex: (i: number) => NearbyArticle | undefined;
  currentWindow: () => ArticleWindow | null;
}

export function createArticleWindowLifecycle(
  deps: ArticleWindowLifecycleDeps,
): ArticleWindowLifecycle {
  let articleWindow: ArticleWindow | null = null;
  let articleWindowAbort: AbortController | null = null;

  function resetArticleWindow(): void {
    if (articleWindow) {
      articleWindow.reset();
      articleWindow = null;
    }
    if (articleWindowAbort) {
      articleWindowAbort.abort();
      articleWindowAbort = null;
    }
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
        if (articleWindow && deps.infiniteScroll.isActive()) {
          // Use totalKnown (all articles from loaded tiles) rather than
          // loadedCount to provide scroll headroom beyond the fetched range.
          // Never shrink — reducing the count while the user is scrolled
          // deep causes the same scroll jump this fix exists to prevent.
          const realCount = Math.max(
            articleWindow.totalKnown(),
            articleWindow.loadedCount(),
          );
          lastScrollCount = Math.max(lastScrollCount, realCount);
          deps.infiniteScroll.update(lastScrollCount);
        }
      },
    });

    return articleWindow;
  }

  let lastScrollCount = 0;
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
              console.assert(
                state.phase.articles[j].title === awArticle.title,
                `Prefix invariant violated at index ${j}: viewport has "${state.phase.articles[j].title}" but ArticleWindow has "${awArticle.title}"`,
              );
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

  function ensureArticleRange(count: number): void {
    resetArticleWindow();
    const aw = getOrCreateArticleWindow();
    void aw.ensureRange(0, count);
    deps.renderBrowsingList();
  }

  return {
    ensureArticleRange,
    resetArticleWindow,
    getOrCreateArticleWindow,
    getArticleByIndex,
    currentWindow: () => articleWindow,
  };
}
