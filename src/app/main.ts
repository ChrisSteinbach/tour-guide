import "./style.css";
import { APP_NAME } from "./config";
import {
  renderNearbyList,
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
import { createEffectExecutor, LANG_STORAGE_KEY } from "./effect-executor";

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
  setItem: (k, v) => localStorage.setItem(k, v),
  setSessionItem: (k, v) => sessionStorage.setItem(k, v),
  pushState: (data, title) => history.pushState(data, title),
  loadTileIndex: (lang, signal) =>
    loadTileIndex(import.meta.env.BASE_URL, lang, signal),
  loadTile: (lang, entry, signal) =>
    loadTile(import.meta.env.BASE_URL, lang, entry, signal),
  tilesForPosition,
  getTileEntry,
  fetchArticleSummary,
  summaryLoader,
  getNearby,
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
});

// ── Helpers ──────────────────────────────────────────────────

function getStoredLang(): Lang {
  const stored = localStorage.getItem(LANG_STORAGE_KEY);
  if (stored && (SUPPORTED_LANGS as readonly string[]).includes(stored)) {
    return stored as Lang;
  }
  return DEFAULT_LANG;
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
  });
  updateBrowseMap(appState.position, appState.phase.articles);
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
  idbCleanupOldKeys(db)
    .then((n) => {
      if (n > 0) console.log(`[idb] Cleaned up ${n} orphaned key(s)`);
    })
    .catch(() => {});
});

listenForSwUpdate();
dispatch({ type: "langChanged", lang: appState.currentLang });

if (sessionStorage.getItem("tour-guide-started")) {
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
