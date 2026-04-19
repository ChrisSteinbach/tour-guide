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
} from "./tile-loader";
import { createArticleWindowFactory } from "./article-window-factory";
import { createTileSource } from "./tile-source";
import { createArticleWindowLifecycle } from "./article-window-lifecycle";
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
 * Create a scroll-count observer that only forwards updates
 * while the infinite scroll is active — updating a destroyed
 * virtual list is a no-op at best.
 */
export function createScrollCountForwarder(infiniteScroll: {
  isActive(): boolean;
  update(listHeight: number, nearEndAnchor: number | undefined): void;
}): (listHeight: number, nearEndAnchor: number | undefined) => void {
  return (listHeight, nearEndAnchor) => {
    if (infiniteScroll.isActive())
      infiniteScroll.update(listHeight, nearEndAnchor);
  };
}

export function composeApp(deps: ComposeAppDeps): ComposedApp {
  const { app, getState, dispatch, itemHeight, scrollPauseThreshold } = deps;

  const wikiApi = createWikiApi({ fetch: globalThis.fetch.bind(globalThis) });

  const summaryLoader = createSummaryLoader({
    fetch: wikiApi.fetchArticleSummary,
    onSummary: (title, summary) => enrichArticleItem(app, title, summary),
  });

  // ── Scroll container resolution ──
  // infiniteScroll is referenced lazily — resolved by the time
  // getScrollContainer is first called (after line ~160).
  const getScrollContainer = (): HTMLElement =>
    resolveScrollContainer(infiniteScroll, app);

  // ── Map panel lifecycle ──
  // Owns the drawer, desktop media query, browse map, and map picker.
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
    renderBrowsingList: () => rendererRef.current?.renderBrowsingList(),
  });
  const {
    drawer,
    drawerPanel,
    desktopQuery,
    browseMap,
    mapPicker,
    onHoverArticle,
  } = mapPanel;

  // ── Article window lifecycle ──
  // Built before infiniteScroll (without observer) so
  // infinite-scroll-wiring can reference its methods.  The observer
  // that drives scroll-count updates is attached after infiniteScroll
  // is constructed.
  const lifecycle = createArticleWindowLifecycle({
    getState,
    createArticleWindow: (opts) => {
      const source = createTileSource({
        position: opts.position,
        tileMap: opts.tileMap,
        getStateMachineTiles: opts.getStateMachineTiles,
        loadTile: (entry, signal) =>
          loadTile(import.meta.env.BASE_URL, opts.lang, entry, signal),
      });
      return createArticleWindowFactory({
        position: opts.position,
        signal: opts.signal,
        source,
        onWindowChange: opts.onWindowChange,
      });
    },
    renderBrowsingList: () => rendererRef.current?.renderBrowsingList(),
  });

  // ── Infinite scroll wiring ──
  const infiniteScroll = createInfiniteScrollWiring({
    getState,
    dispatch,
    app,
    itemHeight,
    browseMap,
    summaryLoader,
    onHoverArticle,
    getArticleByIndex: (i) => lifecycle.getArticleByIndex(i),
    getScrollContainer,
    getCurrentWindow: () => lifecycle.currentWindow(),
    applyOptimisticCount: (count) => lifecycle.applyOptimisticCount(count),
  });

  // Now that infiniteScroll exists, wire the lifecycle's scroll-count
  // observer.  createScrollCountForwarder guards against forwarding
  // to a destroyed virtual list (see its doc comment).
  //
  // The isActive() gate applies to ALL paths that fire through
  // this observer — both onWindowChange and applyOptimisticCount.
  // This is safe because applyOptimisticCount is only called from
  // infinite-scroll-wiring's onNearEnd, which by construction only
  // fires while the infinite scroll lifecycle is active.
  lifecycle.attachScrollCountObserver(
    createScrollCountForwarder(infiniteScroll),
  );

  // Sync ArticleWindow's loaded articles to the state machine so
  // state.phase.articles stays in sync after tile loads re-sort.
  lifecycle.attachArticlesObserver((articles) => {
    dispatch({ type: "articlesSync", articles });
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
    browseMap,
    mapPicker,
    resetArticleWindow: () => lifecycle.resetArticleWindow(),
    getCurrentWindow: () => lifecycle.currentWindow(),
    getArticleByIndex: (i) => lifecycle.getArticleByIndex(i),
    updateScrollCount: (count) => lifecycle.applyOptimisticCount(count),
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
    ensureArticleRange: (pos, count) =>
      lifecycle.ensureArticleRange(pos, count),
    summaryLoader,
    ui: createEffectUIAdapter({
      app,
      renderer,
      mapPicker,
      browseMap,
      getState,
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
