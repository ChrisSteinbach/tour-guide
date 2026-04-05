import "./style.css";
import { hideAbout, showAbout } from "./about";
import { APP_NAME } from "./config";
import { updateNearbyDistances, enrichArticleItem } from "./render";
import type { NearbyArticle, UserPosition } from "./types";
import { watchLocation } from "./location";
import { fetchArticleSummary } from "./wiki-api";
import { createSummaryLoader } from "./summary-loader";
import {
  renderDetailLoading,
  renderDetailReady,
  renderDetailError,
} from "./detail";
import {
  tilesForPosition,
  getTileEntry,
  nearestExistingTiles,
  loadTileIndex,
  loadTile,
  findNearestTiled,
} from "./tile-loader";
import { tileFor } from "../tiles";
import { tilesAtRing } from "./tile-radius";
import { createArticleWindowFactory } from "./article-window-factory";
import {
  createArticleWindowLifecycle,
  type ArticleWindowLifecycle,
} from "./article-window-lifecycle";
import { DEFAULT_LANG, SUPPORTED_LANGS } from "../lang";
import type { Lang } from "../lang";
import {
  transition,
  getNearby,
  DEFAULT_VIEWPORT_FILL,
  type AppState,
  type Event,
} from "./state-machine";
import { createEffectExecutor, LANG_STORAGE_KEY } from "./effect-executor";
import { createInfiniteScrollWiring } from "./infinite-scroll-wiring";
import { createMapPanelLifecycle } from "./map-panel-lifecycle";
import { createRenderer, type Renderer } from "./renderer";
import { createBootstrap } from "./bootstrap";

const app =
  document.getElementById("app") ??
  (() => {
    throw new Error("Missing #app element in document");
  })();

// ── State ────────────────────────────────────────────────────

/** Item height for virtual scroll (px). Matches .nearby-item (64px) + gap (4px). */
const VIRTUAL_ITEM_HEIGHT = 68;

/** Compute how many articles fill the viewport, plus a few extra for scroll trigger. */
const viewportFillCount = Math.max(
  DEFAULT_VIEWPORT_FILL,
  Math.ceil(window.innerHeight / VIRTUAL_ITEM_HEIGHT) + 3,
);

let appState: AppState = {
  phase: { phase: "welcome" },
  query: { mode: "none" },
  position: null,
  positionSource: null,
  currentLang: getStoredLang(),
  loadGeneration: 0,
  loadingTiles: new Set(),
  downloadProgress: -1,
  updateBanner: null,
  hasGeolocation: true,
  gpsSignalLost: false,
  viewportFillCount,
  aboutOpen: false,
};

// ── Dispatch ─────────────────────────────────────────────────

function dispatch(event: Event): void {
  const { next, effects } = transition(appState, event);
  appState = next;
  for (const effect of effects) {
    executeEffect(effect);
  }
}

// ── Effect executor ──────────────────────────────────────────

const summaryLoader = createSummaryLoader({
  fetch: fetchArticleSummary,
  onSummary: (title, summary) => enrichArticleItem(app, title, summary),
});

const goBack = () => history.back();

const executeEffect = createEffectExecutor({
  getState: () => appState,
  dispatch: (event) => dispatch(event),
  watchLocation,
  pushState: (data, title) => history.pushState(data, title),
  fetchArticleSummary,
  getNearby,
  ensureArticleRange,
  summaryLoader,
  ui: {
    render: () => renderer.renderPhase(),
    renderBrowsingList: () => renderer.renderBrowsingList(),
    renderBrowsingHeader: () => renderer.renderBrowsingHeader(),
    updateDistances: (articles) => updateNearbyDistances(app, articles),
    showAbout,
    hideAbout,
    renderDetailLoading: (article) => renderDetailLoading(app, article, goBack),
    renderDetailReady: (article, summary) => {
      const origin =
        appState.positionSource === "picked" ? appState.position : null;
      renderDetailReady(app, article, summary, goBack, origin ?? undefined);
    },
    renderDetailError: (article, msg, retry, lang) => {
      const origin =
        appState.positionSource === "picked" ? appState.position : null;
      renderDetailError(
        app,
        article,
        msg,
        goBack,
        retry,
        lang,
        origin ?? undefined,
      );
    },
    renderAppUpdateBanner: () => renderer.renderAppUpdateBanner(),
    showMapPicker: () => {
      // resetDrawerForMapPicker() destroys the prior mapPicker/browseMap;
      // mapPicker.show() re-initializes it. The destroy-then-show sequence
      // is intentional — see Renderer.resetDrawerForMapPicker.
      renderer.resetDrawerForMapPicker();
      mapPicker.show();
    },
    scrollToTop: () => {
      getScrollContainer().scrollTo(0, 0);
    },
    restoreScrollTop: (firstVisibleIndex) => {
      getScrollContainer().scrollTop = firstVisibleIndex * VIRTUAL_ITEM_HEIGHT;
    },
  },
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

// ── Helpers ──────────────────────────────────────────────────

/** Resolve the current scroll container: infinite-scroll wrapper, viewport-mode wrapper, or #app fallback. */
function getScrollContainer(): HTMLElement {
  return (
    infiniteScroll.scrollElement() ??
    app.querySelector<HTMLElement>(".app-scroll") ??
    app
  );
}

function getStoredLang(): Lang {
  const stored = localStorage.getItem(LANG_STORAGE_KEY);
  if (stored && (SUPPORTED_LANGS as readonly string[]).includes(stored)) {
    return stored as Lang;
  }
  return DEFAULT_LANG;
}

// ── ArticleWindow lifecycle (wrapper functions; lifecycle initialized after infiniteScroll) ──

// eslint-disable-next-line prefer-const -- initialized after infiniteScroll is declared
let lifecycle: ArticleWindowLifecycle;

function getArticleByIndex(i: number): NearbyArticle | undefined {
  return lifecycle.getArticleByIndex(i);
}

function resetArticleWindow(): void {
  lifecycle.resetArticleWindow();
}

/** Called by the effect executor when requery fires in infinite scroll mode. */
function ensureArticleRange(pos: UserPosition, count: number): void {
  lifecycle.ensureArticleRange(pos, count);
}

// ── Lifecycle managers ───────────────────────────────────────

// eslint-disable-next-line prefer-const -- initialized after createMapPanelLifecycle returns
let renderer: Renderer;

const mapPanel = createMapPanelLifecycle({
  getState: () => appState,
  dispatch: (event) => dispatch(event),
  app,
  getScrollContainer,
  itemHeight: VIRTUAL_ITEM_HEIGHT,
  appName: APP_NAME,
  renderBrowsingList: () => renderer.renderBrowsingList(),
});
const {
  drawer,
  drawerPanel,
  desktopQuery,
  browseMap,
  mapPicker,
  onHoverArticle,
} = mapPanel;

// Release the window-level listeners owned by the map panel when the module
// is disposed (HMR in dev).  Without this, editing any file imported by
// main.ts would leak a new pair of listeners on every reload.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    mapPanel.destroy();
  });
}

// ── Infinite scroll lifecycle ─────────────────────────────────

const infiniteScroll = createInfiniteScrollWiring({
  getState: () => appState,
  dispatch: (event) => dispatch(event),
  app,
  itemHeight: VIRTUAL_ITEM_HEIGHT,
  browseMap,
  summaryLoader,
  onHoverArticle,
  getArticleByIndex,
  getScrollContainer,
  getCurrentWindow: () => lifecycle.currentWindow(),
  applyOptimisticCount: (count) => lifecycle.applyOptimisticCount(count),
});

// ── Initialize ArticleWindow lifecycle ────────────────────────

lifecycle = createArticleWindowLifecycle({
  getState: () => appState,
  createArticleWindow: (opts) => {
    const result = createArticleWindowFactory({
      ...opts,
      loadTile: (_basePath, lang, entry, signal) =>
        loadTile(import.meta.env.BASE_URL, lang, entry, signal),
      getTileEntry,
      findNearestTiled,
      tilesAtRing,
      tileFor,
    });
    return result.articleWindow;
  },
  renderBrowsingList: () => renderer.renderBrowsingList(),
  infiniteScroll: {
    isActive: () => infiniteScroll.isActive(),
    update: (count, loadedCount) => infiniteScroll.update(count, loadedCount),
  },
});

// ── DOM renderer ─────────────────────────────────────────────

const SCROLL_PAUSE_THRESHOLD = VIRTUAL_ITEM_HEIGHT * 2;

renderer = createRenderer({
  getState: () => appState,
  dispatch: (event) => dispatch(event),
  app,
  infiniteScroll,
  drawer,
  drawerPanel,
  desktopQuery,
  browseMap,
  mapPicker,
  resetArticleWindow,
  getCurrentWindow: () => lifecycle.currentWindow(),
  getArticleByIndex,
  getScrollContainer,
  onHoverArticle,
  itemHeight: VIRTUAL_ITEM_HEIGHT,
  scrollPauseThreshold: SCROLL_PAUSE_THRESHOLD,
  hasGeolocation: !!navigator.geolocation,
});

// ── Bootstrap ────────────────────────────────────────────────

const bootstrap = createBootstrap({
  dispatch: (event) => dispatch(event),
  app,
  getCurrentLang: () => appState.currentLang,
});
bootstrap.run();

// Release window-level listeners owned by bootstrap on HMR dispose.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    bootstrap.destroy();
  });
}
