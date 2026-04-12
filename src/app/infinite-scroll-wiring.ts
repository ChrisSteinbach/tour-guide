// Infinite scroll wiring — extracted from main.ts.
// Configures and owns the infinite-scroll lifecycle: per-item
// rendering, header rendering, map sync, enrichment, and the
// near-end handler that grows the ArticleWindow.

import {
  renderNearbyHeader,
  createArticleItemContent,
  applyEnrichment,
} from "./render";
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

  /** Extra articles to prefetch before the visible range start on backward scroll. */
  const BACKWARD_PREFETCH_BUFFER = 200;

  // Remembers the last visible start so onVisibleRangeChange can detect
  // backward scrolls and prefetch ahead of the viewport in that direction.
  // Reset whenever a new ArticleWindow becomes active (tracked via
  // lastSeenWindow below) — otherwise the fresh window's first range event
  // at start ≈ 0 would be compared against the previous window's last start
  // and misread as a backward scroll.
  let lastVisibleStart: number | null = null;
  let lastSeenWindow: ArticleWindow | null = null;

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
      cancelEnrich: () => deps.summaryLoader.cancel(),
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
      onVisibleRangeChange: (range) => {
        // Re-fetch articles that were evicted from the ArticleWindow
        // when the user scrolled away. ensureRange is a no-op when the
        // range is already loaded, so this is cheap on normal scrolls.
        //
        // Forward scrolls rely on onNearEnd (PREFETCH_BUFFER past the end)
        // to stay ahead of the viewport. Backward scrolls have no such
        // trigger, so on a fast upward sweep into evicted territory we'd
        // re-fetch exactly the viewport range on every event. Detect
        // direction from the last seen start and pad the backward side.
        const aw = deps.getCurrentWindow();
        if (aw !== lastSeenWindow) {
          lastVisibleStart = null;
          lastSeenWindow = aw;
        }
        const scrollingBackward =
          lastVisibleStart !== null && range.start < lastVisibleStart;
        lastVisibleStart = range.start;
        if (aw) {
          const fetchStart = scrollingBackward
            ? Math.max(0, range.start - BACKWARD_PREFETCH_BUFFER)
            : range.start;
          void aw.ensureRange(fetchStart, range.end);
        }
      },
      onNearEnd: () => {
        const aw = deps.getCurrentWindow();
        if (aw) {
          const vl = infiniteScroll.virtualList();
          if (!vl) return;
          const range = vl.visibleRange();

          // Optimistically expand the list height so the user never hits
          // the bottom while the async fetch is in progress.  Route through
          // the lifecycle ratchet so onWindowChange can't shrink below this.
          deps.applyOptimisticCount(aw.loadedCount());

          // onWindowChange fires when the fetch completes, updating the
          // height to the real value — no .then() callback needed.
          void aw.ensureRange(range.start, range.end + PREFETCH_BUFFER);
        } else {
          deps.dispatch({ type: "expandInfiniteScroll" });
        }
      },
    },
  );

  return infiniteScroll;
}
