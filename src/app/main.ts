import "./style.css";
import type { NearbyArticle } from "./types";
import { mockPosition } from "./mock-data";
import { renderNearbyList, updateNearbyDistances } from "./render";
import {
  renderLoading,
  renderLoadingProgress,
  renderError,
  renderWelcome,
} from "./status";
import { watchLocation, type StopFn } from "./location";
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
  type Effect,
  type Event,
} from "./state-machine";

const LANG_STORAGE_KEY = "tour-guide-lang";

const app = document.getElementById("app")!;

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

// Operational handles (not part of state machine)
let stopWatcher: StopFn | null = null;
let loadController = new AbortController();

// ── Dispatch ─────────────────────────────────────────────────

function dispatch(event: Event): void {
  const { next, effects } = transition(appState, event);
  appState = next;
  for (const effect of effects) {
    executeEffect(effect);
  }
}

// ── Effect executor ──────────────────────────────────────────

function executeEffect(effect: Effect): void {
  switch (effect.type) {
    case "render":
      renderPhase();
      break;
    case "renderBrowsingList":
      renderBrowsingListDOM();
      break;
    case "updateDistances":
      if (appState.phase.phase === "browsing")
        updateNearbyDistances(app, appState.phase.articles);
      break;
    case "startGps":
      stopWatcher = watchLocation({
        onPosition: (pos) => dispatch({ type: "position", pos }),
        onError: (error) => dispatch({ type: "gpsError", error }),
      });
      break;
    case "stopGps":
      if (stopWatcher) {
        stopWatcher();
        stopWatcher = null;
      }
      break;
    case "storeLang":
      localStorage.setItem(LANG_STORAGE_KEY, effect.lang);
      break;
    case "storeStarted":
      sessionStorage.setItem("tour-guide-started", "1");
      break;
    case "loadData":
      loadController.abort();
      loadController = new AbortController();
      loadLanguageData(effect.lang, loadController.signal);
      break;
    case "loadTiles":
      void loadTilesForPosition(
        effect.lang,
        appState.loadGeneration,
        loadController.signal,
      );
      break;
    case "pushHistory":
      history.pushState({ view: "detail" }, "");
      break;
    case "fetchSummary":
      void fetchAndRenderSummary(effect.article);
      break;
    case "showAppUpdateBanner":
      renderAppUpdateBanner();
      break;
    case "requery": {
      const articles = getNearby(appState.query, effect.pos, effect.count);
      dispatch({
        type: "queryResult",
        articles,
        queryPos: effect.pos,
        count: effect.count,
      });
      break;
    }
    case "log":
      console.log(effect.message);
      break;
  }
}

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
  renderNearbyList(
    app,
    appState.phase.articles,
    (article) => dispatch({ type: "selectArticle", article }),
    appState.currentLang,
    (lang) => dispatch({ type: "langChanged", lang }),
    () => dispatch({ type: "showMore" }),
    getNextTier(appState.phase.nearbyCount),
    appState.phase.paused,
    () => dispatch({ type: "togglePause" }),
  );
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

const goBack = () => history.back();

async function fetchAndRenderSummary(article: NearbyArticle): Promise<void> {
  renderDetailLoading(app, article, goBack);
  try {
    const summary = await fetchArticleSummary(
      article.title,
      appState.currentLang,
    );
    if (appState.phase.phase !== "detail" || appState.phase.article !== article)
      return;
    renderDetailReady(app, article, summary, goBack);
  } catch (err) {
    if (appState.phase.phase !== "detail" || appState.phase.article !== article)
      return;
    const message = err instanceof Error ? err.message : "Unknown error";
    renderDetailError(
      app,
      article,
      message,
      goBack,
      () => void fetchAndRenderSummary(article),
      appState.currentLang,
    );
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

// ── Data loading ─────────────────────────────────────────────

async function loadTilesForPosition(
  lang: Lang,
  gen: number,
  signal: AbortSignal,
): Promise<void> {
  if (gen !== appState.loadGeneration) return;
  if (appState.query.mode !== "tiled" || !appState.position) return;

  const { tileMap, tiles } = appState.query;
  const { primary, adjacent } = tilesForPosition(
    tileMap,
    appState.position.lat,
    appState.position.lon,
  );

  const allTiles = [primary, ...adjacent];
  for (const id of allTiles) {
    if (signal.aborted) return;
    if (tiles.has(id) || appState.loadingTiles.has(id)) continue;
    const entry = getTileEntry(tileMap, id);
    if (!entry) continue;

    const isPrimary = id === primary;
    dispatch({ type: "tileLoadStarted", id });

    const loadOne = loadTile(import.meta.env.BASE_URL, lang, entry, signal)
      .then((tileQuery) => {
        if (gen !== appState.loadGeneration) return;
        dispatch({ type: "tileLoaded", id, tileQuery, gen });
      })
      .catch((err) => {
        if (signal.aborted) return;

        console.error(`Failed to load tile ${id}:`, err);
      });

    if (isPrimary) {
      await loadOne;
    }
  }
}

function loadLanguageData(lang: Lang, signal: AbortSignal): void {
  const gen = appState.loadGeneration;
  const baseUrl = import.meta.env.BASE_URL;

  loadTileIndex(baseUrl, lang, signal)
    .then((index) => {
      if (gen !== appState.loadGeneration) return;
      dispatch({ type: "tileIndexLoaded", index, lang, gen });
    })
    .catch((err) => {
      if (signal.aborted) return;
      if (gen !== appState.loadGeneration) return;

      console.warn("[tiles] Tile index failed:", err);
      dispatch({ type: "tileIndexLoaded", index: null, lang, gen });
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
