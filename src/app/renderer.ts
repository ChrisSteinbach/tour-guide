// DOM renderer — extracted from main.ts for testability.
// Translates app state into DOM updates. All I/O boundaries are
// injected via RendererDeps; the factory encapsulates operational
// state (drawerInitialized, scrollPauseDetector).

import { renderNearbyList } from "./render";
import {
  renderLoading,
  renderLoadingProgress,
  renderError,
  renderDataUnavailable,
  renderWelcome,
} from "./status";
import {
  createScrollPauseDetector,
  type ScrollPauseDetector,
} from "./scroll-pause-detector";
import type { NearbyArticle } from "./types";
import type { AppState, Event } from "./state-machine";
import type { ArticleWindow } from "./article-window";
import type { GroupView } from "./grouped-articles";
import type { InfiniteScrollLifecycle } from "./infinite-scroll-lifecycle";
import type { MapDrawer } from "./map-drawer";
import type { SpatialPanelLifecycle } from "./spatial-panel-lifecycle";
import type { MapPickerLifecycle } from "./map-picker-lifecycle";
import type { Lang } from "../lang";

export interface RendererDeps {
  getState: () => AppState;
  dispatch: (event: Event) => void;
  app: HTMLElement;
  infiniteScroll: InfiniteScrollLifecycle;
  drawer: MapDrawer;
  drawerPanel: HTMLElement;
  desktopQuery: MediaQueryList;
  spatialPanel: SpatialPanelLifecycle;
  mapPicker: MapPickerLifecycle;
  resetArticleWindow: () => void;
  getCurrentWindow: () => ArticleWindow | null;
  /** Group-index view over the flat loaded list (see grouped-articles.ts). */
  groupView: GroupView;
  getScrollContainer: () => HTMLElement;
  onHoverArticle: (title: string | null) => void;
  /** Push a scroll count through the lifecycle's monotonicity floor. */
  updateScrollCount: (count: number) => void;
  itemHeight: number;
  scrollPauseThreshold: number;
  hasGeolocation: boolean;
}

export interface Renderer {
  renderPhase: () => void;
  renderBrowsingList: () => void;
  renderBrowsingHeader: () => void;
  /**
   * Show or remove the tile-load failure notice from the current state. Safe to
   * call in any phase — it only appears while browsing with a failed primary
   * tile. Exposed so the detail render path can clear it when the user opens an
   * article (entering detail emits no render effect of its own).
   */
  syncTileFailureNotice: () => void;
  /**
   * Reset drawer state before showing the map picker. This destroys the
   * existing mapPicker and spatialPanel instances and closes the drawer; the
   * caller is responsible for calling mapPicker.show() (or otherwise
   * re-initializing the map picker) immediately afterward.
   */
  resetDrawerForMapPicker: () => void;
}

export function createRenderer(deps: RendererDeps): Renderer {
  let drawerInitialized = false;
  let scrollPauseDetector: ScrollPauseDetector | null = null;

  function teardownScrollPauseListener(): void {
    if (scrollPauseDetector) {
      scrollPauseDetector.destroy();
      scrollPauseDetector = null;
    }
  }

  function setupScrollPauseListener(): void {
    teardownScrollPauseListener();
    scrollPauseDetector = createScrollPauseDetector({
      threshold: deps.scrollPauseThreshold,
      onPause: () => {
        scrollPauseDetector = null;
        deps.dispatch({ type: "scrollPause" });
      },
      container: deps.getScrollContainer(),
    });
  }

  function firstVisibleIndex(): number {
    return Math.floor(deps.getScrollContainer().scrollTop / deps.itemHeight);
  }

  // Mode-independent tile-load failure notice. A body-level fixed banner so it
  // works identically in viewport and infinite-scroll modes (and while the
  // radar/map drawer is open). Rebuilt from state on every browsing render.
  function syncTileFailureNotice(): void {
    const state = deps.getState();
    const existing = document.getElementById("tile-failure-notice");
    if (state.phase.phase !== "browsing" || !state.primaryTileFailed) {
      existing?.remove();
      return;
    }
    const empty = state.phase.articles.length === 0;
    // Degraded (real but distant results) is dismissible; the empty-failure
    // state is the whole content, so it stays until a retry succeeds.
    if (!empty && state.tileFailureDismissed) {
      existing?.remove();
      return;
    }

    existing?.remove();
    const notice = document.createElement("div");
    notice.id = "tile-failure-notice";
    notice.className = "tile-failure-notice";
    notice.setAttribute("role", "status");

    const text = document.createElement("span");
    text.className = "tile-failure-text";
    text.textContent = empty
      ? "Couldn’t load nearby articles."
      : "Couldn’t load nearby articles — showing more distant results.";

    const actions = document.createElement("div");
    actions.className = "tile-failure-actions";

    const retry = document.createElement("button");
    retry.className = "tile-failure-btn tile-failure-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      retry.disabled = true;
      retry.textContent = "Retrying…";
      deps.dispatch({ type: "retryTiles" });
    });
    actions.appendChild(retry);

    if (!empty) {
      const dismiss = document.createElement("button");
      dismiss.className = "tile-failure-btn tile-failure-dismiss";
      dismiss.setAttribute("aria-label", "Dismiss");
      dismiss.textContent = "×";
      dismiss.addEventListener("click", () =>
        deps.dispatch({ type: "dismissTileFailure" }),
      );
      actions.appendChild(dismiss);
    }

    notice.append(text, actions);
    document.body.appendChild(notice);
  }

  function renderBrowsingHeaderDOM(): void {
    syncTileFailureNotice();
    if (deps.getState().phase.phase !== "browsing") return;
    if (deps.infiniteScroll.isActive()) {
      deps.infiniteScroll.updateHeader();
    }
  }

  function renderBrowsingListDOM(): void {
    const state = deps.getState();
    if (state.phase.phase !== "browsing" || !state.position) return;

    deps.drawerPanel.removeAttribute("hidden");
    if (!drawerInitialized) {
      drawerInitialized = true;
      if (deps.desktopQuery.matches) {
        deps.drawer.open();
        // No CSS transition fires when going from hidden to visible,
        // so transitionend never triggers spatialPanel.resize(). Schedule
        // it manually so Leaflet picks up the correct container size.
        requestAnimationFrame(() => deps.spatialPanel.resize());
      } else {
        deps.drawer.close();
      }
    }

    if (state.phase.scrollMode === "infinite") {
      renderInfiniteScrollDOM();
    } else {
      deps.resetArticleWindow();
      deps.infiniteScroll.destroy();
      renderViewportListDOM();
    }
    syncTileFailureNotice();
  }

  function renderViewportListDOM(): void {
    const state = deps.getState();
    if (state.phase.phase !== "browsing" || !state.position) return;
    const isGps = state.positionSource !== "picked";
    renderNearbyList(deps.app, state.phase.articles, {
      onSelectArticle: (article: NearbyArticle) =>
        deps.dispatch({
          type: "selectArticle",
          article,
          firstVisibleIndex: firstVisibleIndex(),
        }),
      onHoverArticle: deps.onHoverArticle,
      currentLang: state.currentLang,
      onLangChange: (lang: Lang) =>
        deps.dispatch({ type: "langChanged", lang }),
      paused: state.phase.paused,
      pauseReason: state.phase.pauseReason,
      onTogglePause: isGps
        ? () => deps.dispatch({ type: "togglePause" })
        : undefined,
      positionSource: state.positionSource ?? "gps",
      onUseGps: () => deps.dispatch({ type: "useGps" }),
      onPickLocation: () => deps.dispatch({ type: "showMapPicker" }),
      gpsSignalLost: state.gpsSignalLost,
      filter: state.filter,
      onToggleFilter: () => deps.dispatch({ type: "toggleFilter" }),
      onShowAbout: () => deps.dispatch({ type: "showAbout" }),
    });
    deps.spatialPanel.update(
      state.position,
      state.phase.articles,
      state.positionSource ?? "gps",
      state.primaryTileFailed,
    );
    if (isGps && !state.phase.paused) {
      setupScrollPauseListener();
    }
  }

  function renderInfiniteScrollDOM(): void {
    const state = deps.getState();
    if (state.phase.phase !== "browsing" || !state.position) return;
    teardownScrollPauseListener();

    if (
      deps.infiniteScroll.isActive() &&
      !deps.app.querySelector(".virtual-scroll-container")
    ) {
      deps.infiniteScroll.destroy();
    }

    // When the ArticleWindow knows the true article count, use it so the
    // list never extends past the last real article.  Before the first
    // fetch completes (knownTotal === 0) fall back to the state-machine
    // limit as a placeholder that will be corrected by onWindowChange.
    const aw = deps.getCurrentWindow();
    const loadedCount = aw?.loadedCount() ?? 0;
    const knownTotal = aw?.totalKnown() ?? 0;
    const articleTotal =
      knownTotal > 0
        ? Math.max(loadedCount, knownTotal)
        : Math.max(
            loadedCount,
            state.phase.articles.length,
            state.phase.infiniteScrollLimit,
          );

    if (!deps.infiniteScroll.isActive()) {
      // The virtual list is sized in group-index space (one row per coincident
      // group). updateScrollCount routes through the group-aware forwarder, but
      // init bypasses it, so convert here.
      deps.infiniteScroll.init(
        deps.groupView.groupCountForArticleCount(articleTotal),
      );
    } else {
      deps.updateScrollCount(articleTotal);

      if (state.position) {
        const vl = deps.infiniteScroll.virtualList();
        if (vl) {
          // visibleRange() is group-index space; expand to flat members so the
          // map/radar re-collapse to the correct cluster counts.
          const range = vl.visibleRange();
          const visible = deps.groupView.membersInRange(range.start, range.end);
          deps.spatialPanel.update(
            state.position,
            visible,
            state.positionSource ?? "gps",
            state.primaryTileFailed,
          );
        }
      }
    }
  }

  function renderPhase(): void {
    deps.resetArticleWindow();
    deps.infiniteScroll.destroy();
    teardownScrollPauseListener();
    deps.mapPicker.destroy();
    const state = deps.getState();
    syncTileFailureNotice();
    // spatialPanel + drawer persist across browsing↔detail so the map/radar stays
    // visible while viewing an article. Teardown only fires when the next
    // phase is outside that pair (welcome, mapPicker, error, etc.).
    const inBrowsePair =
      state.phase.phase === "browsing" || state.phase.phase === "detail";
    if (!inBrowsePair) {
      deps.spatialPanel.destroy();
      deps.drawerPanel.setAttribute("hidden", "");
      deps.drawer.close();
      drawerInitialized = false;
    }
    switch (state.phase.phase) {
      case "welcome":
        renderWelcome(deps.app, {
          onStart: () =>
            deps.dispatch({
              type: "start",
              hasGeolocation: deps.hasGeolocation,
            }),
          onPickLocation: () => deps.dispatch({ type: "showMapPicker" }),
          onExplore: (position) =>
            deps.dispatch({ type: "pickPosition", position }),
          currentLang: state.currentLang,
          onLangChange: (lang) => deps.dispatch({ type: "langChanged", lang }),
          onShowAbout: () => deps.dispatch({ type: "showAbout" }),
        });
        return;
      case "downloading":
        renderLoadingProgress(deps.app, state.phase.progress);
        return;
      case "locating":
        renderLoading(deps.app);
        return;
      case "loadingTiles":
        renderLoading(deps.app, "Loading articles\u2026");
        return;
      case "dataUnavailable":
        renderDataUnavailable(deps.app, state.currentLang, (lang) =>
          deps.dispatch({ type: "langChanged", lang }),
        );
        return;
      case "error":
        renderError(deps.app, state.phase.error, () =>
          deps.dispatch({ type: "showMapPicker" }),
        );
        return;
      case "detail":
      case "browsing":
      case "mapPicker":
        return;
    }
  }

  function resetDrawerForMapPicker(): void {
    deps.mapPicker.destroy();
    deps.spatialPanel.destroy();
    deps.drawerPanel.setAttribute("hidden", "");
    deps.drawer.close();
    drawerInitialized = false;
  }

  return {
    renderPhase,
    renderBrowsingList: renderBrowsingListDOM,
    renderBrowsingHeader: renderBrowsingHeaderDOM,
    syncTileFailureNotice,
    resetDrawerForMapPicker,
  };
}
