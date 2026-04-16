// Infinite scroll wiring — extracted from main.ts.
// Configures and owns the infinite-scroll lifecycle: per-item
// rendering, header rendering, map sync, enrichment, and the
// near-end handler that grows the ArticleWindow.

import {
  renderNearbyHeader,
  createArticleItemContent,
  applyEnrichment,
} from "./render";
import { computeOptimisticCount } from "./article-window-lifecycle";
import {
  createInfiniteScrollLifecycle,
  type InfiniteScrollLifecycle,
} from "./infinite-scroll-lifecycle";
import type { NearbyArticle } from "./types";
import type { AppState, Event } from "./state-machine";
import type { BrowseMapLifecycle } from "./browse-map-lifecycle";
import type { SummaryLoader } from "./summary-loader";
import type { ArticleWindow } from "./article-window";
import type { Lang } from "../lang";

export interface InfiniteScrollWiringDeps {
  getState: () => AppState;
  dispatch: (event: Event) => void;
  app: HTMLElement;
  itemHeight: number;
  browseMap: BrowseMapLifecycle;
  summaryLoader: SummaryLoader;
  onHoverArticle: (title: string | null) => void;
  getArticleByIndex: (i: number) => NearbyArticle | undefined;
  getScrollContainer: () => HTMLElement;
  getCurrentWindow: () => ArticleWindow | null;
  applyOptimisticCount: (count: number) => void;
}

export function createInfiniteScrollWiring(
  deps: InfiniteScrollWiringDeps,
): InfiniteScrollLifecycle {
  /** Extra articles to prefetch beyond the visible range end. */
  const PREFETCH_BUFFER = 200;

  /** Scroll-near-end detection threshold (items from bottom). */
  const NEAR_END_THRESHOLD = 100;

  /** Extra items to render above/below viewport. */
  const OVERSCAN = 5;

  /** Debounce period for enrichment after scroll settles (ms). */
  const ENRICH_SETTLE_MS = 300;

  /** Debounce period for map marker sync after scroll (ms). */
  const MAP_SYNC_SETTLE_MS = 150;

  const infiniteScroll: InfiniteScrollLifecycle = createInfiniteScrollLifecycle(
    {
      container: deps.app,
      itemHeight: deps.itemHeight,
      overscan: OVERSCAN,
      nearEndThreshold: NEAR_END_THRESHOLD,
      enrichSettleMs: ENRICH_SETTLE_MS,
      mapSyncSettleMs: MAP_SYNC_SETTLE_MS,
      getTitle: (i) => {
        return deps.getArticleByIndex(i)?.title ?? null;
      },
      enrich: (title) =>
        deps.summaryLoader.request(title, deps.getState().currentLang),
      getVisibleArticles: (range) => {
        const state = deps.getState();
        if (state.phase.phase !== "browsing" || !state.position) return null;
        const result: NearbyArticle[] = [];
        for (let i = range.start; i < range.end; i++) {
          const a = deps.getArticleByIndex(i);
          if (a) result.push(a);
        }
        return result;
      },
      syncMapMarkers: (articles) => {
        const state = deps.getState();
        if (state.position) {
          deps.browseMap.update(state.position, articles as NearbyArticle[]);
        }
      },
      renderItem: (i) => {
        const state = deps.getState();
        if (state.phase.phase !== "browsing") return null;
        const article = deps.getArticleByIndex(i);
        if (!article) return null;
        const onSelect = (a: NearbyArticle) =>
          deps.dispatch({
            type: "selectArticle",
            article: a,
            firstVisibleIndex: Math.floor(
              deps.getScrollContainer().scrollTop / deps.itemHeight,
            ),
          });
        const el = createArticleItemContent(
          article,
          onSelect,
          deps.onHoverArticle,
        );
        const cached = deps.summaryLoader.get(article.title);
        if (cached) applyEnrichment(el, cached);
        return el;
      },
      renderHeader: () => {
        const state = deps.getState();
        if (state.phase.phase !== "browsing") {
          const h = document.createElement("header");
          h.className = "app-header";
          return h;
        }
        const { paused, pauseReason } = state.phase;
        const articleCount =
          deps.getCurrentWindow()?.totalKnown() || state.phase.articles.length;
        const isGps = state.positionSource !== "picked";
        return renderNearbyHeader({
          articleCount,
          currentLang: state.currentLang,
          onLangChange: (lang: Lang) =>
            deps.dispatch({ type: "langChanged", lang }),
          paused,
          pauseReason,
          onTogglePause: isGps
            ? () => deps.dispatch({ type: "togglePause" })
            : undefined,
          positionSource: state.positionSource ?? "gps",
          onPickLocation: () => deps.dispatch({ type: "showMapPicker" }),
          onUseGps: () => deps.dispatch({ type: "useGps" }),
          gpsSignalLost: state.gpsSignalLost,
          onShowAbout: () => deps.dispatch({ type: "showAbout" }),
        });
      },
      initBrowseMap: () => {
        const state = deps.getState();
        if (state.position) {
          deps.browseMap.update(state.position, []);
        }
      },
      destroyBrowseMap: () => deps.browseMap.destroy(),
      onNearEnd: () => {
        const aw = deps.getCurrentWindow();
        if (aw) {
          const vl = infiniteScroll.virtualList();
          if (!vl) return;
          const range = vl.visibleRange();

          // Optimistically expand the list height so the user never hits
          // the bottom while the async fetch is in progress.  Route through
          // the lifecycle ratchet so onWindowChange can't shrink below this.
          const optimistic = computeOptimisticCount(
            aw.totalKnown(),
            aw.loadedCount(),
          );
          deps.applyOptimisticCount(optimistic);

          // onWindowChange fires when the fetch completes, updating the
          // height to the real value — no .then() callback needed.
          aw.ensureRange(range.start, range.end + PREFETCH_BUFFER).catch(
            (err) => console.warn("ensureRange failed:", err),
          );
        } else {
          deps.dispatch({ type: "expandInfiniteScroll" });
        }
      },
    },
  );

  return infiniteScroll;
}
