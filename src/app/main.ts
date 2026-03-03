import "./style.css";
import { mockPosition } from "./mock-data";
import { renderNearbyList, updateNearbyDistances } from "./render";
import {
  renderLoading,
  renderLoadingProgress,
  renderError,
  renderDataUnavailable,
  renderWelcome,
} from "./status";
import { watchLocation } from "./location";
import { fetchArticleSummary } from "./wiki-api";
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
  currentLang: getStoredLang(),
  loadGeneration: 0,
  loadingTiles: new Set(),
  downloadProgress: -1,
  updateBanner: null,
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
});

// ── Helpers ──────────────────────────────────────────────────

function getStoredLang(): Lang {
  const stored = localStorage.getItem(LANG_STORAGE_KEY);
  if (stored && (SUPPORTED_LANGS as readonly string[]).includes(stored)) {
    return stored as Lang;
  }
  return DEFAULT_LANG;
}

// ── DOM rendering ────────────────────────────────────────────

function renderBrowsingListDOM(): void {
  if (appState.phase.phase !== "browsing") return;
  renderNearbyList(app, appState.phase.articles, {
    onSelectArticle: (article) => dispatch({ type: "selectArticle", article }),
    currentLang: appState.currentLang,
    onLangChange: (lang) => dispatch({ type: "langChanged", lang }),
    onShowMore: () => dispatch({ type: "showMore" }),
    nextCount: getNextTier(appState.phase.nearbyCount),
    paused: appState.phase.paused,
    onTogglePause: () => dispatch({ type: "togglePause" }),
  });
}

function renderPhase(): void {
  switch (appState.phase.phase) {
    case "welcome":
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
        dispatch({ type: "useMockData", mockPosition }),
      );
      return;
    case "detail":
    case "browsing":
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
    () => dispatch({ type: "useMockData", mockPosition }),
    appState.currentLang,
    (lang) => dispatch({ type: "langChanged", lang }),
  );
}
