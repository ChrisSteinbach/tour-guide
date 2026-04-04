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
import type { InfiniteScrollLifecycle } from "./infinite-scroll-lifecycle";
import type { MapDrawer } from "./map-drawer";
import type { BrowseMapLifecycle } from "./browse-map-lifecycle";
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
  browseMap: BrowseMapLifecycle;
  mapPicker: MapPickerLifecycle;
  resetArticleWindow: () => void;
  getCurrentWindow: () => ArticleWindow | null;
  getArticleByIndex: (i: number) => NearbyArticle | undefined;
  getScrollContainer: () => HTMLElement;
  onHoverArticle: (title: string | null) => void;
  itemHeight: number;
  scrollPauseThreshold: number;
}

export interface Renderer {
  renderPhase: () => void;
  renderBrowsingList: () => void;
  renderBrowsingHeader: () => void;
  renderAppUpdateBanner: () => void;
  teardownScrollPause: () => void;
  /** Reset drawer state before showing the map picker. */
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

  function renderBrowsingHeaderDOM(): void {
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
        // so transitionend never triggers browseMap.resize(). Schedule
        // it manually so Leaflet picks up the correct container size.
        requestAnimationFrame(() => deps.browseMap.resize());
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
      onShowAbout: () => deps.dispatch({ type: "showAbout" }),
    });
    deps.browseMap.update(state.position, state.phase.articles);
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
    const totalCount =
      knownTotal > 0
        ? Math.max(loadedCount, knownTotal)
        : Math.max(
            loadedCount,
            state.phase.articles.length,
            state.phase.infiniteScrollLimit,
          );

    if (!deps.infiniteScroll.isActive()) {
      deps.infiniteScroll.init(totalCount);
    } else {
      deps.infiniteScroll.update(totalCount);

      if (state.position) {
        const vl = deps.infiniteScroll.virtualList();
        if (vl) {
          const range = vl.visibleRange();
          const visible: NearbyArticle[] = [];
          for (let i = range.start; i < range.end; i++) {
            const a = deps.getArticleByIndex(i);
            if (a) visible.push(a);
          }
          deps.browseMap.update(state.position, visible);
        }
      }
    }
  }

  function renderPhase(): void {
    deps.resetArticleWindow();
    deps.infiniteScroll.destroy();
    teardownScrollPauseListener();
    deps.mapPicker.destroy();
    deps.browseMap.destroy();
    deps.drawerPanel.setAttribute("hidden", "");
    deps.drawer.close();
    drawerInitialized = false;
    const state = deps.getState();
    switch (state.phase.phase) {
      case "welcome":
        renderWelcome(deps.app, {
          onStart: () =>
            deps.dispatch({
              type: "start",
              hasGeolocation: !!navigator.geolocation,
            }),
          onPickLocation: () => deps.dispatch({ type: "showMapPicker" }),
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

  function renderAppUpdateBanner(): void {
    if (document.getElementById("app-update-banner")) return;
    const banner = document.createElement("div");
    banner.id = "app-update-banner";
    banner.className = "update-banner";
    const text = document.createElement("span");
    text.className = "update-banner-text";
    text.textContent = "App update available";

    const actions = document.createElement("div");
    actions.className = "update-banner-actions";

    const reloadBtn = document.createElement("button");
    reloadBtn.className = "update-banner-btn update-banner-accept";
    reloadBtn.textContent = "Reload";
    reloadBtn.addEventListener("click", () => {
      window.location.reload();
    });

    actions.appendChild(reloadBtn);
    banner.append(text, actions);
    document.body.appendChild(banner);
  }

  function resetDrawerForMapPicker(): void {
    deps.mapPicker.destroy();
    deps.browseMap.destroy();
    deps.drawerPanel.setAttribute("hidden", "");
    deps.drawer.close();
    drawerInitialized = false;
  }

  return {
    renderPhase,
    renderBrowsingList: renderBrowsingListDOM,
    renderBrowsingHeader: renderBrowsingHeaderDOM,
    renderAppUpdateBanner,
    teardownScrollPause: teardownScrollPauseListener,
    resetDrawerForMapPicker,
  };
}
