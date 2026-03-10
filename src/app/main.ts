import "./style.css";
import { APP_NAME } from "./config";
import {
  renderNearbyList,
  renderNearbyHeader,
  createArticleItemContent,
  applyEnrichment,
  updateNearbyDistances,
  enrichArticleItem,
} from "./render";
import type { NearbyArticle } from "./types";
import {
  renderLoading,
  renderLoadingProgress,
  renderError,
  renderDataUnavailable,
  renderWelcome,
} from "./status";
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
  loadTileIndex,
  loadTile,
} from "./tile-loader";
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
import { createScrollPauseDetector } from "./scroll-pause-detector";
import type { ScrollPauseDetector } from "./scroll-pause-detector";
import { createInfiniteScrollLifecycle } from "./infinite-scroll-lifecycle";
import { createBrowseMapLifecycle } from "./browse-map-lifecycle";
import { createMapPickerLifecycle } from "./map-picker-lifecycle";

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
  summaryLoader,
  ui: {
    render: renderPhase,
    renderBrowsingList: renderBrowsingListDOM,
    updateDistances: (articles) => updateNearbyDistances(app, articles),
    renderDetailLoading: (article) => renderDetailLoading(app, article, goBack),
    renderDetailReady: (article, summary) =>
      renderDetailReady(app, article, summary, goBack),
    renderDetailError: (article, msg, retry, lang) =>
      renderDetailError(app, article, msg, goBack, retry, lang),
    renderAppUpdateBanner,
    showMapPicker: () => {
      mapPicker.destroy();
      browseMap.destroy();
      mapPicker.show();
    },
    scrollToTop: () => {
      window.scrollTo(0, 0);
      // Also reset container scroll in desktop split-view
      app.querySelector<HTMLElement>(".nearby-list")?.scrollTo(0, 0);
    },
  },
  data: {
    loadTileIndex: (lang, signal) =>
      loadTileIndex(import.meta.env.BASE_URL, lang, signal),
    loadTile: (lang, entry, signal) =>
      loadTile(import.meta.env.BASE_URL, lang, entry, signal),
    tilesForPosition,
    getTileEntry,
  },
  storage: {
    setItem: (k, v) => localStorage.setItem(k, v),
  },
});

// ── Helpers ──────────────────────────────────────────────────

function getStoredLang(): Lang {
  const stored = localStorage.getItem(LANG_STORAGE_KEY);
  if (stored && (SUPPORTED_LANGS as readonly string[]).includes(stored)) {
    return stored as Lang;
  }
  return DEFAULT_LANG;
}

// ── Lifecycle managers ───────────────────────────────────────

const desktopQuery = window.matchMedia("(min-width: 1024px)");
desktopQuery.addEventListener("change", () => {
  if (appState.phase.phase === "browsing") renderBrowsingListDOM();
});

const browseMap = createBrowseMapLifecycle({
  container: app,
  isDesktop: () => desktopQuery.matches,
  onSelectArticle: (article) => dispatch({ type: "selectArticle", article }),
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
  enrichSettleMs: 300,
  mapSyncSettleMs: 150,
  isDesktop: () => desktopQuery.matches,
  getTitle: (i) => {
    if (appState.phase.phase !== "browsing") return null;
    return appState.phase.articles[i]?.title ?? null;
  },
  enrich: (title) => summaryLoader.request(title, appState.currentLang),
  cancelEnrich: () => summaryLoader.cancel(),
  getVisibleArticles: (range) => {
    if (appState.phase.phase !== "browsing" || !appState.position) return null;
    if (!desktopQuery.matches) return null;
    return appState.phase.articles.slice(range.start, range.end);
  },
  syncMapMarkers: (articles) => {
    if (appState.position) {
      browseMap.update(appState.position, articles as NearbyArticle[]);
    }
  },
  renderItem: (i) => {
    if (appState.phase.phase !== "browsing") return null;
    const article = appState.phase.articles[i];
    if (!article) return null;
    const onSelect = (a: NearbyArticle) =>
      dispatch({ type: "selectArticle", article: a });
    const el = createArticleItemContent(article, onSelect);
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
    const { articles, paused, pauseReason } = appState.phase;
    const isGps = appState.positionSource !== "picked";
    return renderNearbyHeader({
      articleCount: articles.length,
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
    });
  },
  initBrowseMap: () => {
    if (appState.position) {
      browseMap.update(appState.position, []);
    }
  },
  destroyBrowseMap: () => browseMap.destroy(),
});

// ── DOM rendering ────────────────────────────────────────────

function renderBrowsingListDOM(): void {
  if (appState.phase.phase !== "browsing" || !appState.position) return;

  if (appState.phase.scrollMode === "infinite") {
    renderInfiniteScrollDOM();
  } else {
    infiniteScroll.destroy();
    renderViewportListDOM();
  }
}

/** Dead zone for scroll-pause detection (px). */
const SCROLL_PAUSE_THRESHOLD = VIRTUAL_ITEM_HEIGHT * 2;

let scrollPauseDetector: ScrollPauseDetector | null = null;

function setupScrollPauseListener(): void {
  teardownScrollPauseListener();
  const listEl = app.querySelector<HTMLElement>(".nearby-list");
  scrollPauseDetector = createScrollPauseDetector({
    threshold: SCROLL_PAUSE_THRESHOLD,
    onPause: () => {
      scrollPauseDetector = null;
      dispatch({ type: "scrollPause" });
    },
    container: listEl ?? undefined,
  });
}

function teardownScrollPauseListener(): void {
  if (scrollPauseDetector) {
    scrollPauseDetector.destroy();
    scrollPauseDetector = null;
  }
}

function renderViewportListDOM(): void {
  if (appState.phase.phase !== "browsing" || !appState.position) return;
  const isGps = appState.positionSource !== "picked";
  renderNearbyList(app, appState.phase.articles, {
    onSelectArticle: (article) => dispatch({ type: "selectArticle", article }),
    currentLang: appState.currentLang,
    onLangChange: (lang) => dispatch({ type: "langChanged", lang }),
    paused: appState.phase.paused,
    pauseReason: appState.phase.pauseReason,
    onTogglePause: isGps ? () => dispatch({ type: "togglePause" }) : undefined,
    positionSource: appState.positionSource ?? "gps",
    onUseGps: () => dispatch({ type: "useGps" }),
    onPickLocation: () => dispatch({ type: "showMapPicker" }),
    gpsSignalLost: appState.gpsSignalLost,
  });
  browseMap.update(appState.position, appState.phase.articles);
  // Listen for user scroll to auto-pause GPS and transition to infinite scroll
  if (isGps && !appState.phase.paused) {
    setupScrollPauseListener();
  }
}

function renderInfiniteScrollDOM(): void {
  if (appState.phase.phase !== "browsing" || !appState.position) return;
  teardownScrollPauseListener();

  // If the DOM was destroyed (e.g., by detail view clearing #app), discard stale lifecycle
  if (
    infiniteScroll.isActive() &&
    !app.querySelector(".virtual-scroll-container")
  ) {
    infiniteScroll.destroy();
  }

  const { articles } = appState.phase;

  if (!infiniteScroll.isActive()) {
    infiniteScroll.init(articles.length);
  } else {
    infiniteScroll.update(articles.length);

    // Sync browse map markers with current viewport after article list changes
    if (desktopQuery.matches && appState.position) {
      const vl = infiniteScroll.virtualList();
      if (vl) {
        const range = vl.visibleRange();
        const visible = articles.slice(range.start, range.end);
        browseMap.update(appState.position, visible);
      }
    }
  }
}

function renderPhase(): void {
  infiniteScroll.destroy();
  teardownScrollPauseListener();
  mapPicker.destroy();
  browseMap.destroy();
  switch (appState.phase.phase) {
    case "welcome":
      renderWelcome(
        app,
        () =>
          dispatch({ type: "start", hasGeolocation: !!navigator.geolocation }),
        () => dispatch({ type: "showMapPicker" }),
        appState.currentLang,
        (lang) => dispatch({ type: "langChanged", lang }),
      );
      return;
    case "downloading":
      renderLoadingProgress(app, appState.phase.progress);
      return;
    case "locating":
      renderLoading(app);
      return;
    case "loadingTiles":
      renderLoading(app, "Loading nearby articles\u2026");
      return;
    case "dataUnavailable":
      renderDataUnavailable(app, appState.currentLang, (lang) =>
        dispatch({ type: "langChanged", lang }),
      );
      return;
    case "error":
      renderError(app, appState.phase.error, () =>
        dispatch({ type: "showMapPicker" }),
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

// Clean up orphaned IDB keys from old schema versions
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
  renderWelcome(
    app,
    () => dispatch({ type: "start", hasGeolocation: !!navigator.geolocation }),
    () => dispatch({ type: "showMapPicker" }),
    appState.currentLang,
    (lang) => dispatch({ type: "langChanged", lang }),
  );
}
