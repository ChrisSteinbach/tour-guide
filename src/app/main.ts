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
import type { MapPickerHandle } from "./map-picker";
import type { BrowseMapHandle } from "./browse-map";
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
  getNextTier,
  type AppState,
  type Event,
} from "./state-machine";
import {
  createVirtualList,
  connectWindowScroll,
  windowScrollState,
  type VirtualList,
  type VisibleRange,
} from "./virtual-scroll";
import {
  createEnrichScheduler,
  type EnrichScheduler,
} from "./enrich-scheduler";
import {
  createEffectExecutor,
  LANG_STORAGE_KEY,
  STARTED_STORAGE_KEY,
  STARTED_TTL_MS,
} from "./effect-executor";

const app =
  document.getElementById("app") ??
  (() => {
    throw new Error("Missing #app element in document");
  })();

// ── State ────────────────────────────────────────────────────

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
    showMapPicker,
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

// ── Infinite scroll infrastructure ───────────────────────────

interface InfiniteScrollHandle {
  virtualList: VirtualList;
  enrichScheduler: EnrichScheduler;
  disconnectScroll: () => void;
  /** Cancel any pending debounced map-marker sync. */
  cancelMapSync: () => void;
}

let infiniteScrollHandle: InfiniteScrollHandle | null = null;

/** Item height for virtual scroll (px). Matches .nearby-item padding + content. */
const VIRTUAL_ITEM_HEIGHT = 72;
const VIRTUAL_OVERSCAN = 5;
const ENRICH_SETTLE_MS = 300;
/** Debounce for syncing browse map markers with viewport-visible articles. */
const MAP_SYNC_SETTLE_MS = 150;

function teardownInfiniteScroll(): void {
  if (infiniteScrollHandle) {
    infiniteScrollHandle.disconnectScroll();
    infiniteScrollHandle.virtualList.destroy();
    infiniteScrollHandle.enrichScheduler.destroy();
    infiniteScrollHandle.cancelMapSync();
    infiniteScrollHandle = null;
  }
}

// ── Map picker ──────────────────────────────────────────────

let activeMapPicker: MapPickerHandle | null = null;
let activeBrowseMap: BrowseMapHandle | null = null;

const desktopQuery = window.matchMedia("(min-width: 1024px)");
desktopQuery.addEventListener("change", () => {
  if (appState.phase.phase === "browsing") renderBrowsingListDOM();
});

function destroyBrowseMap(): void {
  if (activeBrowseMap) {
    activeBrowseMap.destroy();
    activeBrowseMap = null;
  }
  const el = app.querySelector(".browse-map");
  el?.remove();
  app.classList.remove("split-view");
}

function destroyMapPicker(): void {
  if (activeMapPicker) {
    activeMapPicker.destroy();
    activeMapPicker = null;
  }
}

function showMapPicker(): void {
  destroyMapPicker();
  destroyBrowseMap();
  app.textContent = "";

  const header = document.createElement("header");
  header.className = "app-header";
  const h1 = document.createElement("h1");
  h1.textContent = APP_NAME;
  header.appendChild(h1);

  const instructions = document.createElement("p");
  instructions.className = "map-picker-instructions";
  instructions.textContent = "Tap the map to place a marker, then confirm.";

  const mapContainer = document.createElement("div");
  mapContainer.className = "map-picker-container";
  const mapEl = document.createElement("div");
  mapEl.className = "map-picker-map";
  mapContainer.appendChild(mapEl);

  app.append(header, instructions, mapContainer);

  void import("./map-picker")
    .then(({ createMapPicker }) => {
      activeMapPicker = createMapPicker(mapEl, {
        onPick: (lat, lon) => {
          destroyMapPicker();
          dispatch({ type: "pickPosition", position: { lat, lon } });
        },
        center: appState.position ?? undefined,
      });
    })
    .catch(() => {
      mapContainer.textContent = "";
      const msg = document.createElement("p");
      msg.className = "status-message";
      msg.textContent = "Failed to load the map. Check your connection.";
      const retryBtn = document.createElement("button");
      retryBtn.className = "status-action";
      retryBtn.textContent = "Retry";
      retryBtn.addEventListener("click", showMapPicker);
      mapContainer.append(msg, retryBtn);
    });
}

// ── DOM rendering ────────────────────────────────────────────

function renderBrowsingListDOM(): void {
  if (appState.phase.phase !== "browsing" || !appState.position) return;

  if (appState.phase.scrollMode === "infinite") {
    renderInfiniteScrollDOM();
  } else {
    teardownInfiniteScroll();
    renderTierListDOM();
  }
}

function renderTierListDOM(): void {
  if (appState.phase.phase !== "browsing" || !appState.position) return;
  const isGps = appState.positionSource !== "picked";
  renderNearbyList(app, appState.phase.articles, {
    onSelectArticle: (article) => dispatch({ type: "selectArticle", article }),
    currentLang: appState.currentLang,
    onLangChange: (lang) => dispatch({ type: "langChanged", lang }),
    onShowMore: () => dispatch({ type: "showMore" }),
    nextCount: getNextTier(appState.phase.nearbyCount),
    paused: appState.phase.paused,
    onTogglePause: isGps ? () => dispatch({ type: "togglePause" }) : undefined,
    positionSource: appState.positionSource ?? "gps",
    onUseGps: () => dispatch({ type: "useGps" }),
    onPickLocation: () => dispatch({ type: "showMapPicker" }),
    gpsSignalLost: appState.gpsSignalLost,
  });
  updateBrowseMap(appState.position, appState.phase.articles);
}

/**
 * Create a getScrollState function that reads from a scrollable container
 * element (for desktop split-view where window scroll is disabled).
 */
function containerScrollState(
  scrollEl: HTMLElement,
  listEl: HTMLElement,
): () => { scrollTop: number; viewportHeight: number } {
  return () => ({
    scrollTop: Math.max(0, scrollEl.scrollTop - listEl.offsetTop),
    viewportHeight: scrollEl.clientHeight,
  });
}

/**
 * Connect a VirtualList to a scrollable container's scroll events.
 * Returns a cleanup function.
 */
function connectContainerScroll(
  scrollEl: HTMLElement,
  list: { refresh(): void },
): () => void {
  let rafId = 0;
  const onScroll = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      list.refresh();
    });
  };
  scrollEl.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    scrollEl.removeEventListener("scroll", onScroll);
    if (rafId) cancelAnimationFrame(rafId);
  };
}

function renderInfiniteScrollDOM(): void {
  if (appState.phase.phase !== "browsing" || !appState.position) return;

  // If the DOM was destroyed (e.g., by detail view clearing #app), discard stale handle
  if (infiniteScrollHandle && !app.querySelector(".virtual-scroll-container")) {
    teardownInfiniteScroll();
  }

  const { articles, paused } = appState.phase;
  const isGps = appState.positionSource !== "picked";
  const onSelect = (article: NearbyArticle) =>
    dispatch({ type: "selectArticle", article });

  const headerOpts = {
    articleCount: articles.length,
    currentLang: appState.currentLang,
    onLangChange: (lang: Lang) => dispatch({ type: "langChanged", lang }),
    paused,
    onTogglePause: isGps ? () => dispatch({ type: "togglePause" }) : undefined,
    positionSource: appState.positionSource ?? "gps",
    onPickLocation: () => dispatch({ type: "showMapPicker" }),
    onUseGps: () => dispatch({ type: "useGps" }),
    gpsSignalLost: appState.gpsSignalLost,
  };

  if (!infiniteScrollHandle) {
    // First render: build the infinite scroll infrastructure
    destroyBrowseMap();
    app.textContent = "";
    app.appendChild(renderNearbyHeader(headerOpts));

    const listContainer = document.createElement("div");
    listContainer.className = "virtual-scroll-container";
    app.appendChild(listContainer);

    // On desktop, show the browse map and use container scroll.
    // On mobile, use window scroll (no split-view).
    const isDesktop = desktopQuery.matches;
    if (isDesktop && appState.position) {
      // Initial map creation — markers will sync once virtual list reports first visible range.
      updateBrowseMap(appState.position, []);
    }

    let mapSyncTimer: ReturnType<typeof setTimeout> | null = null;

    const enrichScheduler = createEnrichScheduler({
      settleMs: ENRICH_SETTLE_MS,
      getTitle: (i) => {
        if (appState.phase.phase !== "browsing") return null;
        return appState.phase.articles[i]?.title ?? null;
      },
      enrich: (title) => summaryLoader.request(title, appState.currentLang),
      cancel: () => summaryLoader.cancel(),
    });

    // Choose scroll source: container (desktop split-view) or window (mobile)
    const getScrollState =
      isDesktop && app.classList.contains("split-view")
        ? containerScrollState(listContainer, listContainer)
        : windowScrollState(listContainer);

    const syncMapMarkers = (range: VisibleRange) => {
      if (!appState.position || appState.phase.phase !== "browsing") return;
      if (!desktopQuery.matches) return;
      if (mapSyncTimer !== null) clearTimeout(mapSyncTimer);
      mapSyncTimer = setTimeout(() => {
        mapSyncTimer = null;
        if (appState.phase.phase !== "browsing" || !appState.position) return;
        const visible = appState.phase.articles.slice(range.start, range.end);
        updateBrowseMap(appState.position, visible);
      }, MAP_SYNC_SETTLE_MS);
    };

    const virtualList = createVirtualList({
      container: listContainer,
      itemHeight: VIRTUAL_ITEM_HEIGHT,
      overscan: VIRTUAL_OVERSCAN,
      getScrollState,
      onRangeChange: (range) => {
        enrichScheduler.onRangeChange(range);
        syncMapMarkers(range);
      },
    });

    const renderVirtualItem = (i: number) => {
      const article = articles[i];
      if (!article) return null;
      const el = createArticleItemContent(article, onSelect);
      const cached = summaryLoader.get(article.title);
      if (cached) applyEnrichment(el, cached);
      return el;
    };

    virtualList.update(articles.length, renderVirtualItem);

    const disconnectScroll =
      isDesktop && app.classList.contains("split-view")
        ? connectContainerScroll(listContainer, virtualList)
        : connectWindowScroll(virtualList);
    const cancelMapSync = () => {
      if (mapSyncTimer !== null) {
        clearTimeout(mapSyncTimer);
        mapSyncTimer = null;
      }
    };
    infiniteScrollHandle = {
      virtualList,
      enrichScheduler,
      disconnectScroll,
      cancelMapSync,
    };
  } else {
    // Update existing virtual list with new articles
    const { virtualList } = infiniteScrollHandle;

    // Update header
    const oldHeader = app.querySelector("header.app-header");
    const newHeader = renderNearbyHeader(headerOpts);
    if (oldHeader) {
      oldHeader.replaceWith(newHeader);
    }

    // Update virtual list
    virtualList.update(articles.length, (i) => {
      const article = articles[i];
      if (!article) return null;
      const el = createArticleItemContent(article, onSelect);
      const cached = summaryLoader.get(article.title);
      if (cached) applyEnrichment(el, cached);
      return el;
    });

    // Sync browse map markers with current viewport after article list changes
    if (desktopQuery.matches && appState.position) {
      const range = virtualList.visibleRange();
      const visible = articles.slice(range.start, range.end);
      updateBrowseMap(appState.position, visible);
    }
  }
}

function updateBrowseMap(
  position: { lat: number; lon: number },
  articles: NearbyArticle[],
): void {
  if (!desktopQuery.matches) {
    destroyBrowseMap();
    return;
  }

  // If the map handle exists but its container was removed (e.g. detail view
  // cleared #app), discard the stale handle so we recreate it.
  if (activeBrowseMap) {
    const existing = app.querySelector(".browse-map");
    if (existing && app.contains(existing)) {
      activeBrowseMap.update(position, articles);
      return;
    }
    activeBrowseMap = null;
  }

  // First render: create the map container
  let mapEl = app.querySelector<HTMLElement>(".browse-map");
  if (!mapEl) {
    mapEl = document.createElement("div");
    mapEl.className = "browse-map";
    app.appendChild(mapEl);
    app.classList.add("split-view");
  }

  void import("./browse-map")
    .then(({ createBrowseMap }) => {
      if (!mapEl || !app.contains(mapEl)) return;
      activeBrowseMap = createBrowseMap(mapEl, position, articles, (article) =>
        dispatch({ type: "selectArticle", article }),
      );
    })
    .catch(() => {
      // Map is a nice-to-have; browsing works without it
      mapEl?.remove();
    });
}

function renderPhase(): void {
  teardownInfiniteScroll();
  destroyMapPicker();
  destroyBrowseMap();
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
