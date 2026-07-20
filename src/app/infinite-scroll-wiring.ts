// Infinite scroll wiring — extracted from main.ts.
// Configures and owns the infinite-scroll lifecycle: per-item
// rendering, header rendering, map sync, enrichment, and the
// near-end handler that grows the ArticleWindow.

import {
  renderNearbyHeader,
  createArticleItemContent,
  createClusterMoreButton,
  applyEnrichment,
  createEmptyHighlightsHint,
} from "./render";
import { openClusterPopover } from "./cluster-popover";
import {
  createInfiniteScrollLifecycle,
  type InfiniteScrollLifecycle,
} from "./infinite-scroll-lifecycle";
import type { NearbyArticle } from "./types";
import type { AppState, Event } from "./state-machine";
import type { SpatialPanelLifecycle } from "./spatial-panel-lifecycle";
import type { SummaryLoader } from "./summary-loader";
import type { GroupView } from "./grouped-articles";
import type { Lang } from "../lang";

export interface InfiniteScrollWiringDeps {
  getState: () => AppState;
  dispatch: (event: Event) => void;
  app: HTMLElement;
  itemHeight: number;
  spatialPanel: SpatialPanelLifecycle;
  summaryLoader: SummaryLoader;
  onHoverArticle: (title: string | null) => void;
  /**
   * Group-index view over the flat loaded list. The virtual scroll renders one
   * row per coincident group; this translates group indices (rows) to the
   * representative/members and back to article indices for fetching.
   */
  groupView: GroupView;
  getScrollContainer: () => HTMLElement;
}

export function createInfiniteScrollWiring(
  deps: InfiniteScrollWiringDeps,
): InfiniteScrollLifecycle {
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
      enrichSettleMs: ENRICH_SETTLE_MS,
      mapSyncSettleMs: MAP_SYNC_SETTLE_MS,
      getTitle: (i) => {
        return deps.groupView.titleAt(i);
      },
      enrich: (title) =>
        deps.summaryLoader.request(title, deps.getState().currentLang),
      getVisibleArticles: (range) => {
        const state = deps.getState();
        if (state.phase.phase !== "browsing" || !state.position) return null;
        // Expand the visible groups back to their flat members so the map/radar
        // (which re-collapse independently) draw the correct cluster counts.
        return deps.groupView.membersInRange(range.start, range.end);
      },
      syncMapMarkers: (articles) => {
        const state = deps.getState();
        if (state.position) {
          deps.spatialPanel.update(
            state.position,
            articles as NearbyArticle[],
            state.positionSource ?? "gps",
            state.primaryTileFailed,
          );
        }
      },
      renderItem: (i) => {
        const state = deps.getState();
        if (state.phase.phase !== "browsing") return null;
        const group = deps.groupView.getGroup(i);
        if (!group) return null;
        const rep = group.representative;
        const onSelect = (a: NearbyArticle) =>
          deps.dispatch({
            type: "selectArticle",
            article: a,
            firstVisibleIndex: Math.floor(
              deps.getScrollContainer().scrollTop / deps.itemHeight,
            ),
          });
        const el = createArticleItemContent(rep, onSelect, deps.onHoverArticle);
        const cached = deps.summaryLoader.get(rep.title);
        if (cached) applyEnrichment(el, cached);

        // Coincident cluster: append a "+N" chip that opens the member popover.
        // Fixed-height virtual rows can't grow inline (as the viewport list
        // does), so members are revealed in a popover instead.
        const others = group.members.filter((m) => m !== rep);
        if (others.length > 0) {
          el.classList.add("has-cluster");
          el.appendChild(
            createClusterMoreButton(others.length, (anchor) => {
              openClusterPopover({
                anchor,
                members: others,
                onSelect,
                scrollContainer: deps.getScrollContainer(),
              });
            }),
          );
        }
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
        const isGps = state.positionSource !== "picked";
        return renderNearbyHeader({
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
          filter: state.filter,
          onToggleFilter: () => deps.dispatch({ type: "toggleFilter" }),
          onShowAbout: () => deps.dispatch({ type: "showAbout" }),
        });
      },
      renderEmptyState: () => {
        const state = deps.getState();
        if (state.phase.phase !== "browsing") return null;
        if (state.filter !== "highlights") return null;
        return createEmptyHighlightsHint(() =>
          deps.dispatch({ type: "toggleFilter" }),
        );
      },
      initSpatialView: () => {
        const state = deps.getState();
        if (state.position) {
          deps.spatialPanel.update(
            state.position,
            [],
            state.positionSource ?? "gps",
            state.primaryTileFailed,
          );
        }
      },
      destroySpatialView: () => deps.spatialPanel.destroy(),
    },
  );

  return infiniteScroll;
}
