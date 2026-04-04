import "./style.css";
import { hideAbout, showAbout } from "./about";
import { APP_NAME } from "./config";
import {
  renderNearbyHeader,
  createArticleItemContent,
  applyEnrichment,
  updateNearbyDistances,
  enrichArticleItem,
} from "./render";
import type { NearbyArticle, UserPosition } from "./types";
import { renderWelcome } from "./status";
import { watchLocation } from "./location";
import { fetchArticleSummary } from "./wiki-api";
import { createSummaryLoader } from "./summary-loader";
import {
  renderDetailLoading,
  renderDetailReady,
  renderDetailError,
} from "./detail";
import { idbOpen, idbCleanupOldKeys } from "./idb";
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
  computeOptimisticCount,
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
import {
  createEffectExecutor,
  LANG_STORAGE_KEY,
  STARTED_STORAGE_KEY,
  STARTED_TTL_MS,
} from "./effect-executor";
import { createInfiniteScrollLifecycle } from "./infinite-scroll-lifecycle";
import { createBrowseMapLifecycle } from "./browse-map-lifecycle";
import { createMapPickerLifecycle } from "./map-picker-lifecycle";
import { createMapDrawer } from "./map-drawer";
import { createRenderer } from "./renderer";

const app =
  document.getElementById("app") ??
  (() => {
    throw new Error("Missing #app element in document");
  })();

// ── State ────────────────────────────────────────────────────

/** Item height for virtual scroll (px). Matches .nearby-item (64px) + gap (4px). */
const VIRTUAL_ITEM_HEIGHT = 68;

/** Extra articles to prefetch beyond the visible range end. */
const PREFETCH_BUFFER = 200;

/** Scroll-near-end detection threshold (items from bottom). */
const NEAR_END_THRESHOLD = 100;

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

const desktopQuery = window.matchMedia("(min-width: 1024px)");
desktopQuery.addEventListener("change", () => {
  if (appState.phase.phase === "browsing") {
    if (desktopQuery.matches) {
      drawer.open();
    } else {
      drawer.close();
    }
    renderer.renderBrowsingList();
  }
});

const drawer = createMapDrawer(document.body);

const drawerPanel = drawer.panel;
drawerPanel.addEventListener("transitionend", (e: TransitionEvent) => {
  if (e.propertyName === "transform" && drawer.isOpen()) browseMap.resize();
});

drawerPanel.setAttribute("hidden", "");

const onHoverArticle = (title: string | null) => browseMap.highlight(title);

const browseMap = createBrowseMapLifecycle({
  container: drawer.element,
  onSelectArticle: (article) =>
    dispatch({
      type: "selectArticle",
      article,
      firstVisibleIndex: Math.floor(
        getScrollContainer().scrollTop / VIRTUAL_ITEM_HEIGHT,
      ),
    }),
  importBrowseMap: () => import("./browse-map"),
});

const mapPicker = createMapPickerLifecycle({
  container: app,
  appName: APP_NAME,
  getPosition: () => appState.position,
  onPick: (lat, lon) =>
    dispatch({ type: "pickPosition", position: { lat, lon } }),
  importMapPicker: () => import("./map-picker"),
});

// ── Infinite scroll lifecycle ─────────────────────────────────

const infiniteScroll = createInfiniteScrollLifecycle({
  container: app,
  itemHeight: VIRTUAL_ITEM_HEIGHT,
  overscan: 5,
  nearEndThreshold: NEAR_END_THRESHOLD,
  enrichSettleMs: 300,
  mapSyncSettleMs: 150,
  getTitle: (i) => {
    return getArticleByIndex(i)?.title ?? null;
  },
  enrich: (title) => summaryLoader.request(title, appState.currentLang),
  cancelEnrich: () => summaryLoader.cancel(),
  getVisibleArticles: (range) => {
    if (appState.phase.phase !== "browsing" || !appState.position) return null;
    const result: NearbyArticle[] = [];
    for (let i = range.start; i < range.end; i++) {
      const a = getArticleByIndex(i);
      if (a) result.push(a);
    }
    return result;
  },
  syncMapMarkers: (articles) => {
    if (appState.position) {
      browseMap.update(appState.position, articles as NearbyArticle[]);
    }
  },
  renderItem: (i) => {
    if (appState.phase.phase !== "browsing") return null;
    const article = getArticleByIndex(i);
    if (!article) return null;
    const onSelect = (a: NearbyArticle) =>
      dispatch({
        type: "selectArticle",
        article: a,
        firstVisibleIndex: Math.floor(
          getScrollContainer().scrollTop / VIRTUAL_ITEM_HEIGHT,
        ),
      });
    const el = createArticleItemContent(article, onSelect, onHoverArticle);
    const cached = summaryLoader.get(article.title);
    if (cached) applyEnrichment(el, cached);
    return el;
  },
  renderHeader: () => {
    if (appState.phase.phase !== "browsing") {
      const h = document.createElement("header");
      h.className = "app-header";
      return h;
    }
    const { paused, pauseReason } = appState.phase;
    const articleCount =
      lifecycle.currentWindow()?.totalKnown() || appState.phase.articles.length;
    const isGps = appState.positionSource !== "picked";
    return renderNearbyHeader({
      articleCount,
      currentLang: appState.currentLang,
      onLangChange: (lang: Lang) => dispatch({ type: "langChanged", lang }),
      paused,
      pauseReason,
      onTogglePause: isGps
        ? () => dispatch({ type: "togglePause" })
        : undefined,
      positionSource: appState.positionSource ?? "gps",
      onPickLocation: () => dispatch({ type: "showMapPicker" }),
      onUseGps: () => dispatch({ type: "useGps" }),
      gpsSignalLost: appState.gpsSignalLost,
      onShowAbout: () => dispatch({ type: "showAbout" }),
    });
  },
  initBrowseMap: () => {
    if (appState.position) {
      browseMap.update(appState.position, []);
    }
  },
  destroyBrowseMap: () => browseMap.destroy(),
  onNearEnd: () => {
    const aw = lifecycle.currentWindow();
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
      lifecycle.applyOptimisticCount(optimistic);

      // onWindowChange fires when the fetch completes, updating the
      // height to the real value — no .then() callback needed.
      void aw.ensureRange(range.start, range.end + PREFETCH_BUFFER);
    } else {
      dispatch({ type: "expandInfiniteScroll" });
    }
  },
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

const renderer = createRenderer({
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
});

function listenForSwUpdate(): void {
  if (!("serviceWorker" in navigator)) return;
  const initialController = navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!initialController) return;
    dispatch({ type: "swUpdateAvailable" });
  });
}

// ── Popstate handler ─────────────────────────────────────────

window.addEventListener("popstate", () => {
  dispatch({ type: "back" });
});

// ── Bootstrap ────────────────────────────────────────────────

void idbOpen().then((db) => {
  if (!db) return;
  idbCleanupOldKeys(db).catch(() => {});
});

listenForSwUpdate();
dispatch({ type: "langChanged", lang: appState.currentLang });

const startedAt = Number(localStorage.getItem(STARTED_STORAGE_KEY));
if (startedAt && Date.now() - startedAt < STARTED_TTL_MS) {
  dispatch({ type: "start", hasGeolocation: !!navigator.geolocation });
} else {
  renderWelcome(app, {
    onStart: () =>
      dispatch({ type: "start", hasGeolocation: !!navigator.geolocation }),
    onPickLocation: () => dispatch({ type: "showMapPicker" }),
    currentLang: appState.currentLang,
    onLangChange: (lang) => dispatch({ type: "langChanged", lang }),
    onShowAbout: () => dispatch({ type: "showAbout" }),
  });
}
