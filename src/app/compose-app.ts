// Composition root — extracted from main.ts.
// Wires up mapPanel → infiniteScroll → lifecycle → renderer → bootstrap
// and returns the pieces main.ts needs (plus an executeEffect closure
// ready to be invoked by the dispatch loop).

import { APP_NAME } from "./config";
import { enrichArticleItem } from "./render";
import { watchLocation } from "./location";
import { createWikiApi } from "./wiki-api";
import { createSummaryLoader } from "./summary-loader";
import {
  tilesForPosition,
  getTileEntry,
  nearestExistingTiles,
  loadTileIndex,
  loadTile,
  findNearestTiled,
} from "./tile-loader";
import { createBrowseListLifecycle } from "./browse-list-lifecycle";
import { loadFarField } from "./farfield-loader";
import { createGroupView } from "./grouped-articles";
import {
  getNearby,
  type AppState,
  type Effect,
  type Event,
} from "./state-machine";
import { createEffectExecutor } from "./effect-executor";
import { createInfiniteScrollWiring } from "./infinite-scroll-wiring";
import { createMapPanelLifecycle } from "./map-panel-lifecycle";
import { createRenderer, type Renderer } from "./renderer";
import { createBootstrap, type Bootstrap } from "./bootstrap";
import { createEffectUIAdapter } from "./effect-ui-adapter";
import { parseLocationHash } from "./url-state";

export interface ComposeAppDeps {
  app: HTMLElement;
  getState: () => AppState;
  dispatch: (event: Event) => void;
  itemHeight: number;
  scrollPauseThreshold: number;
}

export interface ComposedApp {
  bootstrap: Bootstrap;
  executeEffect: (effect: Effect) => void;
  /** Release window-level listeners and sub-lifecycles. Safe to call twice. */
  destroy: () => void;
}

/**
 * Resolve the scroll container using a three-tier fallback:
 * infinite-scroll element → `.app-scroll` wrapper → app root.
 */
export function resolveScrollContainer(
  scrollProvider: { scrollElement(): HTMLElement | null },
  app: HTMLElement,
): HTMLElement {
  return (
    scrollProvider.scrollElement() ??
    app.querySelector<HTMLElement>(".app-scroll") ??
    app
  );
}

/**
 * Resize the virtual list to hold `articleCount` articles, skipping the
 * update while the infinite scroll is inactive — updating a destroyed virtual
 * list is a no-op at best.
 *
 * The count is article-space; the virtual list is sized in group-index space
 * (one row per coincident group), so it is converted through the GroupView.
 */
export function forwardScrollCount(
  infiniteScroll: {
    isActive(): boolean;
    update(listHeight: number): void;
  },
  groupView: {
    groupCountForArticleCount(articleCount: number): number;
  },
  articleCount: number,
): void {
  if (!infiniteScroll.isActive()) return;
  infiniteScroll.update(groupView.groupCountForArticleCount(articleCount));
}

export function composeApp(deps: ComposeAppDeps): ComposedApp {
  const { app, getState, dispatch, itemHeight, scrollPauseThreshold } = deps;

  const wikiApi = createWikiApi({ fetch: globalThis.fetch.bind(globalThis) });

  const summaryLoader = createSummaryLoader({
    fetch: wikiApi.fetchArticleSummary,
    onSummary: (title, summary) => enrichArticleItem(app, title, summary),
  });

  // Group-index view over the flat loaded list. Backed by state.phase.articles
  // (reference-stable between window syncs), so grouping is memoized without
  // explicit invalidation. Shared by the infinite-scroll wiring, the renderer,
  // and the scroll-count forwarder — the single article↔group translator.
  const groupView = createGroupView(() => {
    const state = getState();
    return state.phase.phase === "browsing" ? state.phase.articles : [];
  });

  // ── Scroll container resolution ──
  // infiniteScroll is referenced lazily — resolved by the time
  // getScrollContainer is first called (after line ~160).
  const getScrollContainer = (): HTMLElement =>
    resolveScrollContainer(infiniteScroll, app);

  // ── Map panel lifecycle ──
  // Owns the drawer, desktop media query, spatial panel (radar/map), and map picker.
  // The renderer is wired in after construction (forward-ref via
  // rendererRef, resolved when onDesktopQueryChange fires — see the
  // rendererRef declaration below for the full hazard note).
  /**
   * Forward-reference holder for the renderer.
   *
   * Both mapPanel and lifecycle (constructed below) receive
   * `() => rendererRef.current?.renderBrowsingList()` callbacks. Those
   * calls silently no-op while rendererRef is still null — i.e. during
   * this composeApp() call, before `rendererRef.current = renderer`
   * runs at the bottom. That is safe today because the real callers
   * only fire after construction completes: mapPanel's callback fires
   * on desktop-query changes, and lifecycle's callback fires on
   * article-window state transitions.
   *
   * Hazard: a future synchronous dispatch path that could fire either
   * callback during construction would silently drop the first render.
   * If that becomes possible, move the renderer assignment earlier or
   * guard the call sites.
   */
  const rendererRef: { current: Renderer | null } = { current: null };
  const mapPanel = createMapPanelLifecycle({
    getState,
    dispatch,
    app,
    getScrollContainer,
    itemHeight,
    appName: APP_NAME,
    storage: localStorage,
    renderBrowsingList: () => rendererRef.current?.renderBrowsingList(),
  });
  const {
    drawer,
    drawerPanel,
    desktopQuery,
    spatialPanel,
    mapPicker,
    onHoverArticle,
  } = mapPanel;

  // ── Browse list lifecycle ──
  // Built before infiniteScroll (without observer) so infinite-scroll-wiring
  // can reference its methods. The observer that pushes the rebuilt list is
  // attached after infiniteScroll is constructed.
  const lifecycle = createBrowseListLifecycle({
    getState,
    queryLocal: (position, minWeight, limit) => {
      const state = getState();
      if (state.query.mode !== "tiled") return [];
      return findNearestTiled(
        state.query.tiles,
        position.lat,
        position.lon,
        limit,
        minWeight === undefined ? undefined : { minWeight },
      );
    },
    loadFarField: (lang, signal) => {
      const query = getState().query;
      return loadFarField(
        import.meta.env.BASE_URL,
        lang,
        query.mode === "tiled" ? query.index.farField : undefined,
        signal,
      );
    },
    renderBrowsingList: () => rendererRef.current?.renderBrowsingList(),
  });

  // ── Infinite scroll wiring ──
  const infiniteScroll = createInfiniteScrollWiring({
    getState,
    dispatch,
    app,
    itemHeight,
    spatialPanel,
    summaryLoader,
    onHoverArticle,
    groupView,
    getScrollContainer,
  });

  // Push each rebuilt list to the state machine, then resize the virtual list
  // to match. Order matters: groupView reads state.phase.articles, so the
  // dispatch must land before the group count is computed.
  lifecycle.attachObserver((articles) => {
    dispatch({ type: "articlesSync", articles });
    forwardScrollCount(infiniteScroll, groupView, articles.length);
  });

  // ── DOM renderer ──
  const renderer = createRenderer({
    getState,
    dispatch,
    app,
    infiniteScroll,
    drawer,
    drawerPanel,
    desktopQuery,
    spatialPanel,
    mapPicker,
    resetBrowseList: () => lifecycle.reset(),
    groupView,
    updateScrollCount: (count) =>
      forwardScrollCount(infiniteScroll, groupView, count),
    getScrollContainer,
    onHoverArticle,
    itemHeight,
    scrollPauseThreshold,
    hasGeolocation: !!navigator.geolocation,
  });
  rendererRef.current = renderer;

  // ── Effect executor ──
  const executeEffect = createEffectExecutor({
    getState,
    dispatch,
    watchLocation,
    pushState: (data, title) => history.pushState(data, title),
    fetchArticleSummary: wikiApi.fetchArticleSummary,
    getNearby,
    rebuildBrowseList: (pos) => lifecycle.rebuild(pos),
    summaryLoader,
    ui: createEffectUIAdapter({
      app,
      renderer,
      mapPicker,
      spatialPanel,
      getState,
      dispatch,
      itemHeight,
      getScrollContainer,
    }),
    data: {
      loadTileIndex: (lang, signal) =>
        loadTileIndex(import.meta.env.BASE_URL, lang, signal),
      loadTile: (lang, entry, signal) =>
        loadTile(import.meta.env.BASE_URL, lang, entry, signal),
      tilesForPosition,
      getTileEntry,
      nearestExistingTiles,
    },
    storage: {
      setItem: (k, v) => localStorage.setItem(k, v),
    },
  });

  // ── Bootstrap ──
  const bootstrap = createBootstrap({
    dispatch,
    app,
    getCurrentLang: () => getState().currentLang,
    getLocationRestore: () => parseLocationHash(window.location.hash),
  });

  let destroyed = false;
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    mapPanel.destroy();
    bootstrap.destroy();
  }

  return { bootstrap, executeEffect, destroy };
}
