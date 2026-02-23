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
import { loadQuery, checkForUpdate, fetchUpdate, dismissUpdate } from "./query";
import {
  tilesForPosition,
  getTileEntry,
  loadTileIndex,
  loadTile,
  cleanMonolithicCache,
} from "./tile-loader";
import { DEFAULT_LANG, SUPPORTED_LANGS } from "../lang";
import type { Lang } from "../lang";
import {
  transition,
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
  pendingUpdate: null,
  updateDownloading: false,
  updateProgress: 0,
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
    case "loadMonolithic":
      loadMonolithic(
        effect.lang,
        appState.loadGeneration,
        loadController.signal,
      );
      break;
    case "loadTiles":
      void loadTilesForPosition(
        effect.lang,
        appState.loadGeneration,
        loadController.signal,
      );
      break;
    case "cleanMonolithicCache":
      void cleanMonolithicCache(effect.lang);
      break;
    case "pushHistory":
      history.pushState({ view: "detail" }, "");
      break;
    case "fetchSummary":
      void fetchAndRenderSummary(effect.article);
      break;
    case "showUpdateBanner":
      renderUpdateBannerDOM();
      break;
    case "removeUpdateBanner":
      document.getElementById("update-banner")?.remove();
      break;
    case "showAppUpdateBanner":
      renderAppUpdateBanner();
      break;
    case "loadUpdate":
      void startUpdateDownload(effect.serverHash, effect.lang);
      break;
    case "dismissUpdate":
      void dismissUpdate(effect.cacheKey, effect.serverHash);
      break;
    case "checkForUpdate":
      void checkForUpdateBackground(effect.lang);
      break;
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

// ── Update banner DOM ────────────────────────────────────────

function renderUpdateBannerDOM(): void {
  let banner = document.getElementById("update-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "update-banner";
    banner.className = "update-banner";
    document.body.appendChild(banner);
  }

  banner.textContent = "";

  if (appState.updateDownloading) {
    const pct = Math.round(appState.updateProgress * 100);

    const text = document.createElement("span");
    text.className = "update-banner-text";
    text.textContent = `Downloading update\u2026 ${pct}%`;

    const progress = document.createElement("div");
    progress.className = "update-banner-progress";
    const fill = document.createElement("div");
    fill.className = "update-banner-progress-fill";
    fill.style.width = `${pct}%`;
    progress.appendChild(fill);

    banner.append(text, progress);
  } else {
    const text = document.createElement("span");
    text.className = "update-banner-text";
    text.textContent = "New article data available";

    const actions = document.createElement("div");
    actions.className = "update-banner-actions";

    const acceptBtn = document.createElement("button");
    acceptBtn.className = "update-banner-btn update-banner-accept";
    acceptBtn.textContent = "Update";
    acceptBtn.addEventListener("click", () =>
      dispatch({ type: "acceptUpdate" }),
    );

    const dismissBtn = document.createElement("button");
    dismissBtn.className = "update-banner-btn update-banner-dismiss";
    dismissBtn.textContent = "Not now";
    dismissBtn.addEventListener("click", () =>
      dispatch({ type: "declineUpdate" }),
    );

    actions.append(acceptBtn, dismissBtn);
    banner.append(text, actions);
  }
}

function renderAppUpdateBanner(): void {
  if (document.getElementById("app-update-banner")) return;
  document.getElementById("update-banner")?.remove();
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
    renderAppUpdateBanner();
  });
}

// ── Data loading ─────────────────────────────────────────────

function loadMonolithic(lang: Lang, gen: number, signal: AbortSignal): void {
  let lastRenderTime = 0;
  let lastRenderedPct = -2;
  const onProgress = (fraction: number) => {
    if (gen !== appState.loadGeneration) return;
    const pct = fraction < 0 ? -1 : Math.round(fraction * 100);
    const now = performance.now();
    if (pct !== lastRenderedPct && now - lastRenderTime >= 100) {
      lastRenderedPct = pct;
      lastRenderTime = now;
      dispatch({ type: "downloadProgress", fraction, gen });
    }
  };

  loadQuery(
    `${import.meta.env.BASE_URL}triangulation-${lang}.bin`,
    `triangulation-v3-${lang}`,
    onProgress,
    signal,
  )
    .then((q) => {
      dispatch({ type: "monolithicLoaded", query: q, lang, gen });
    })
    .catch((err) => {
      if (gen !== appState.loadGeneration) return;
      console.error(`Failed to load triangulation data (${lang}):`, err);
      dispatch({ type: "monolithicFailed", gen });
    });
}

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

      console.warn(
        "[tiles] Tile index failed, falling back to monolithic:",
        err,
      );
      dispatch({ type: "tileIndexLoaded", index: null, lang, gen });
    });
}

async function startUpdateDownload(
  serverHash: string,
  lang: Lang,
): Promise<void> {
  const cacheKey = `triangulation-v3-${lang}`;
  const url = `${import.meta.env.BASE_URL}triangulation-${lang}.bin`;

  try {
    const q = await fetchUpdate(url, cacheKey, serverHash, (fraction) => {
      dispatch({ type: "updateProgress", fraction });
    });
    dispatch({ type: "updateDownloaded", query: q, lang });
  } catch (err) {
    console.error("Update download failed:", err);
    dispatch({ type: "updateFailed" });
  }
}

async function checkForUpdateBackground(lang: Lang): Promise<void> {
  const cacheKey = `triangulation-v3-${lang}`;
  const shaUrl = `${import.meta.env.BASE_URL}triangulation-${lang}.sha`;
  const info = await checkForUpdate(shaUrl, cacheKey);
  if (!info) return;
  dispatch({ type: "updateAvailable", serverHash: info.serverHash, lang });
}

// ── Popstate handler ─────────────────────────────────────────

window.addEventListener("popstate", () => {
  dispatch({ type: "back" });
});

// ── Bootstrap ────────────────────────────────────────────────

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
