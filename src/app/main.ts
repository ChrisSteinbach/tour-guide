import "./style.css";
import type { NearbyArticle, UserPosition } from "./types";
import type { LocationError } from "./location";
import { mockPosition, mockArticles } from "./mock-data";
import { distanceMeters, distanceBetweenPositions } from "./format";
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
import {
  loadQuery,
  checkForUpdate,
  fetchUpdate,
  dismissUpdate,
  type NearestQuery,
} from "./query";
import {
  TiledQuery,
  loadTileIndex,
  loadTile,
  cleanMonolithicCache,
} from "./tile-loader";
import { DEFAULT_LANG, SUPPORTED_LANGS } from "../lang";
import type { Lang } from "../lang";

const NEARBY_TIERS = [10, 20, 50, 100];
const LANG_STORAGE_KEY = "tour-guide-lang";
const REQUERY_DISTANCE_M = 15;

const app = document.getElementById("app")!;

// ── State machine ──────────────────────────────────────────────

type QueryEngine = NearestQuery | TiledQuery;

type Phase =
  | { phase: "welcome" }
  | { phase: "downloading"; progress: number }
  | { phase: "locating" }
  | { phase: "loadingTiles" }
  | { phase: "error"; error: LocationError }
  | {
      phase: "browsing";
      articles: NearbyArticle[];
      nearbyCount: number;
      paused: boolean;
      lastQueryPos: UserPosition;
    }
  | {
      phase: "detail";
      article: NearbyArticle;
      articles: NearbyArticle[];
      nearbyCount: number;
      paused: boolean;
      lastQueryPos: UserPosition;
    };

let state: Phase = { phase: "welcome" };

// Shared across phases (set by async operations)
let query: QueryEngine | null = null;
let position: UserPosition | null = null;
let currentLang: Lang = getStoredLang();

// Operational (async cancellation, GPS cleanup)
let stopWatcher: StopFn | null = null;
let loadGeneration = 0;
const loadingTiles = new Set<string>();
let downloadProgress = -1; // tracks background preload progress

// Update banner (orthogonal UI overlay)
let pendingUpdate: { serverHash: string; lang: Lang } | null = null;
let updateDownloading = false;
let updateProgress = 0;

// ── Helpers ────────────────────────────────────────────────────

function getStoredLang(): Lang {
  const stored = localStorage.getItem(LANG_STORAGE_KEY);
  if (stored && (SUPPORTED_LANGS as readonly string[]).includes(stored)) {
    return stored as Lang;
  }
  return DEFAULT_LANG;
}

function storeLang(lang: Lang): void {
  localStorage.setItem(LANG_STORAGE_KEY, lang);
}

function hasStarted(): boolean {
  return state.phase !== "welcome";
}

/** Compute nearby articles using the current query engine. */
function getNearby(pos: UserPosition, count: number): NearbyArticle[] {
  if (query) {
    const t0 = performance.now();
    const results = query.findNearest(pos.lat, pos.lon, count);
    console.log(
      `[perf] findNearest(k=${count}) in ${(performance.now() - t0).toFixed(2)}ms`,
    );
    return results;
  }
  return mockArticles
    .map((a) => ({ ...a, distanceM: distanceMeters(pos, a) }))
    .sort((a, b) => a.distanceM - b.distanceM);
}

function getNextTier(nearbyCount: number): number | undefined {
  const idx = NEARBY_TIERS.indexOf(nearbyCount);
  return idx >= 0 && idx < NEARBY_TIERS.length - 1
    ? NEARBY_TIERS[idx + 1]
    : undefined;
}

// ── Browsing actions ───────────────────────────────────────────

function renderBrowsingList(): void {
  if (state.phase !== "browsing") return;
  renderNearbyList(
    app,
    state.articles,
    selectArticle,
    currentLang,
    handleLangChange,
    showMore,
    getNextTier(state.nearbyCount),
    state.paused,
    togglePause,
  );
}

function showMore(): void {
  if (state.phase !== "browsing" || !position) return;
  const next = getNextTier(state.nearbyCount);
  if (next === undefined) return;
  state = {
    ...state,
    nearbyCount: next,
    articles: getNearby(position, next),
  };
  renderBrowsingList();
}

function showList(): void {
  if (state.phase !== "detail") return;
  const { articles, nearbyCount, paused, lastQueryPos } = state;
  state = { phase: "browsing", articles, nearbyCount, paused, lastQueryPos };
  renderBrowsingList();
}

function togglePause(): void {
  if (state.phase !== "browsing") return;
  const nowPaused = !state.paused;
  if (!nowPaused && position) {
    state = {
      ...state,
      paused: false,
      articles: getNearby(position, state.nearbyCount),
      lastQueryPos: position,
    };
  } else {
    state = { ...state, paused: nowPaused };
  }
  renderBrowsingList();
}

// ── Detail view ────────────────────────────────────────────────

const goBack = () => history.back();

/** Void wrapper for showDetail — safe to pass as event callback. */
function selectArticle(article: NearbyArticle): void {
  void showDetail(article);
}

async function showDetail(article: NearbyArticle): Promise<void> {
  if (state.phase === "browsing") {
    const { articles, nearbyCount, paused, lastQueryPos } = state;
    state = {
      phase: "detail",
      article,
      articles,
      nearbyCount,
      paused,
      lastQueryPos,
    };
    history.pushState({ view: "detail" }, "");
  } else if (state.phase !== "detail") {
    return;
  }

  renderDetailLoading(app, article, goBack);
  try {
    const summary = await fetchArticleSummary(article.title, currentLang);
    if (state.phase !== "detail" || state.article !== article) return;
    renderDetailReady(app, article, summary, goBack);
  } catch (err) {
    if (state.phase !== "detail" || state.article !== article) return;
    const message = err instanceof Error ? err.message : "Unknown error";
    renderDetailError(
      app,
      article,
      message,
      goBack,
      () => {
        void showDetail(article);
      },
      currentLang,
    );
  }
}

// ── Render (switch on phase) ───────────────────────────────────

function render(): void {
  switch (state.phase) {
    case "welcome":
      return;

    case "downloading":
      renderLoadingProgress(app, state.progress);
      return;

    case "locating":
      renderLoading(app);
      return;

    case "loadingTiles":
      renderLoading(app, "Loading nearby articles\u2026");
      return;

    case "error":
      renderError(app, state.error, useMockData);
      return;

    case "detail":
      return;

    case "browsing": {
      if (state.paused) return;
      if (!position) return;
      if (
        distanceBetweenPositions(position, state.lastQueryPos) <
        REQUERY_DISTANCE_M
      ) {
        return;
      }
      forceRequery();
      return;
    }
  }
}

// ── Phase transitions ──────────────────────────────────────────

/** Transition into browsing (or loadingTiles if tiled with no tiles yet). */
function enterBrowsing(): void {
  if (!position) return;
  if (query instanceof TiledQuery && query.loadedTileCount === 0) {
    state = { phase: "loadingTiles" };
    render();
    return;
  }
  const count =
    state.phase === "browsing" ? state.nearbyCount : NEARBY_TIERS[0];
  state = {
    phase: "browsing",
    articles: getNearby(position, count),
    nearbyCount: count,
    paused: false,
    lastQueryPos: position,
  };
  renderBrowsingList();
}

/** Re-query at current position and re-render the browsing list. */
function forceRequery(): void {
  if (state.phase !== "browsing" || !position) return;
  const s = state;
  const articles = getNearby(position, s.nearbyCount);
  const same =
    articles.length === s.articles.length &&
    articles.every((a, i) => a.title === s.articles[i].title);
  state = {
    phase: "browsing",
    nearbyCount: s.nearbyCount,
    paused: s.paused,
    articles,
    lastQueryPos: position,
  };
  if (same && app.querySelector(".nearby-list")) {
    updateNearbyDistances(app, articles);
    return;
  }
  renderBrowsingList();
}

/** Called when data loading completes — transition from downloading if needed. */
function onDataReady(): void {
  if (state.phase === "downloading") {
    if (position) {
      enterBrowsing();
    } else {
      state = { phase: "locating" };
      render();
    }
  }
  // If still on welcome screen, query is set for when user starts
}

function useMockData(): void {
  if (stopWatcher) {
    stopWatcher();
    stopWatcher = null;
  }
  position = mockPosition;
  if (query === null) {
    // Data not ready — show downloading, will enter browsing when data loads
    state = { phase: "downloading", progress: downloadProgress };
    render();
    return;
  }
  if (query instanceof TiledQuery) {
    void loadTilesForPosition(currentLang, loadGeneration);
  }
  enterBrowsing();
}

// ── Update banner ──────────────────────────────────────────────

function renderUpdateBanner(): void {
  let banner = document.getElementById("update-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "update-banner";
    banner.className = "update-banner";
    document.body.appendChild(banner);
  }

  if (updateDownloading) {
    const pct = Math.round(updateProgress * 100);
    banner.innerHTML = `
      <span class="update-banner-text">Downloading update\u2026 ${pct}%</span>
      <div class="update-banner-progress">
        <div class="update-banner-progress-fill" style="width:${pct}%"></div>
      </div>`;
  } else {
    banner.innerHTML = `
      <span class="update-banner-text">New article data available</span>
      <div class="update-banner-actions">
        <button class="update-banner-btn update-banner-accept">Update</button>
        <button class="update-banner-btn update-banner-dismiss">Not now</button>
      </div>`;
    banner
      .querySelector(".update-banner-accept")!
      .addEventListener("click", acceptUpdate);
    banner
      .querySelector(".update-banner-dismiss")!
      .addEventListener("click", declineUpdate);
  }
}

function removeUpdateBanner(): void {
  document.getElementById("update-banner")?.remove();
}

function acceptUpdate(): void {
  if (!pendingUpdate) return;
  const { serverHash, lang } = pendingUpdate;
  updateDownloading = true;
  updateProgress = 0;
  renderUpdateBanner();

  const cacheKey = `triangulation-v3-${lang}`;
  const url = `${import.meta.env.BASE_URL}triangulation-${lang}.bin`;

  fetchUpdate(url, cacheKey, serverHash, (fraction) => {
    updateProgress = fraction < 0 ? 0 : fraction;
    renderUpdateBanner();
  })
    .then((q) => {
      if (currentLang !== lang) return; // language changed while downloading
      query = q;
      console.log(`Updated to new data: ${q.size} articles (${lang})`);
      forceRequery();
    })
    .catch((err) => {
      console.error("Update download failed:", err);
    })
    .finally(() => {
      pendingUpdate = null;
      updateDownloading = false;
      removeUpdateBanner();
    });
}

function declineUpdate(): void {
  if (!pendingUpdate) return;
  const { serverHash, lang } = pendingUpdate;
  void dismissUpdate(`triangulation-v3-${lang}`, serverHash);
  pendingUpdate = null;
  removeUpdateBanner();
}

function renderAppUpdateBanner(): void {
  if (document.getElementById("app-update-banner")) return;
  removeUpdateBanner(); // app reload supersedes data update
  const banner = document.createElement("div");
  banner.id = "app-update-banner";
  banner.className = "update-banner";
  banner.innerHTML = `
    <span class="update-banner-text">App update available</span>
    <div class="update-banner-actions">
      <button class="update-banner-btn update-banner-accept">Reload</button>
    </div>`;
  banner
    .querySelector(".update-banner-accept")!
    .addEventListener("click", () => {
      window.location.reload();
    });
  document.body.appendChild(banner);
}

function listenForSwUpdate(): void {
  if (!("serviceWorker" in navigator)) return;
  const initialController = navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!initialController) return; // first install, not an update
    renderAppUpdateBanner();
  });
}

// ── Data loading ───────────────────────────────────────────────

function loadMonolithic(lang: Lang, gen: number): void {
  let lastRenderTime = 0;
  let lastRenderedPct = -2; // -2 so initial indeterminate (-1) triggers a render
  const onProgress = (fraction: number) => {
    if (gen !== loadGeneration) return;
    downloadProgress = fraction;
    if (state.phase !== "downloading") return;
    const pct = fraction < 0 ? -1 : Math.round(fraction * 100);
    const now = performance.now();
    if (pct !== lastRenderedPct && now - lastRenderTime >= 100) {
      lastRenderedPct = pct;
      lastRenderTime = now;
      state = { ...state, progress: fraction };
      render();
    }
  };

  loadQuery(
    `${import.meta.env.BASE_URL}triangulation-${lang}.bin`,
    `triangulation-v3-${lang}`,
    onProgress,
  )
    .then((q) => {
      if (gen !== loadGeneration) return;
      query = q;
      console.log(`Loaded ${q.size} articles (${lang})`);

      // Background check for newer data on server
      const cacheKey = `triangulation-v3-${lang}`;
      const shaUrl = `${import.meta.env.BASE_URL}triangulation-${lang}.sha`;
      void checkForUpdate(shaUrl, cacheKey).then((info) => {
        if (!info || gen !== loadGeneration) return;
        pendingUpdate = { serverHash: info.serverHash, lang };
        renderUpdateBanner();
      });
    })
    .catch((err) => {
      if (gen !== loadGeneration) return;
      console.error(`Failed to load triangulation data (${lang}):`, err);
    })
    .finally(() => {
      if (gen !== loadGeneration) return;
      onDataReady();
    });
}

async function loadTilesForPosition(lang: Lang, gen: number): Promise<void> {
  if (gen !== loadGeneration) return;
  if (!(query instanceof TiledQuery) || !position) return;

  const tq = query;
  const { primary, adjacent } = tq.tilesForPosition(position.lat, position.lon);

  // Load primary tile first (await), then render immediately
  const allTiles = [primary, ...adjacent];
  for (const id of allTiles) {
    if (tq.hasTile(id) || loadingTiles.has(id)) continue;
    const entry = tq.getTileEntry(id);
    if (!entry) continue;

    const isPrimary = id === primary;
    loadingTiles.add(id);

    const loadOne = loadTile(import.meta.env.BASE_URL, lang, entry)
      .then((tileQuery) => {
        if (gen !== loadGeneration) return;
        tq.addTile(id, tileQuery);
        if (state.phase === "loadingTiles" && position) {
          enterBrowsing();
        } else {
          forceRequery();
        }
      })
      .catch((err) => {
        console.error(`Failed to load tile ${id}:`, err);
      })
      .finally(() => {
        loadingTiles.delete(id);
      });

    if (isPrimary) {
      await loadOne; // wait for primary before continuing
    }
    // adjacent tiles load in background (fire-and-forget)
  }
}

function loadLanguageData(lang: Lang): void {
  query = null;
  downloadProgress = -1;
  pendingUpdate = null;
  updateDownloading = false;
  loadingTiles.clear();
  removeUpdateBanner();
  const gen = ++loadGeneration;

  if (hasStarted()) {
    state = { phase: "downloading", progress: -1 };
    render();
  }

  const baseUrl = import.meta.env.BASE_URL;

  // Try tiled loading first, fall back to monolithic on 404
  loadTileIndex(baseUrl, lang)
    .then((index) => {
      if (gen !== loadGeneration) return;

      if (index) {
        // Tiled path
        query = new TiledQuery(index);
        console.log(
          `[tiles] Tiled mode: ${index.tiles.length} tiles (${lang})`,
        );

        // Clean up old monolithic cache
        void cleanMonolithicCache(lang);

        onDataReady();

        // If position already known, start loading tiles
        if (position) {
          void loadTilesForPosition(lang, gen);
        }
      } else {
        // Monolithic fallback
        loadMonolithic(lang, gen);
      }
    })
    .catch((err) => {
      if (gen !== loadGeneration) return;
      console.warn(
        "[tiles] Tile index failed, falling back to monolithic:",
        err,
      );
      loadMonolithic(lang, gen);
    });
}

// ── User actions ───────────────────────────────────────────────

function handleLangChange(lang: Lang): void {
  currentLang = lang;
  storeLang(lang);
  loadLanguageData(lang);
}

/** User clicked "Find nearby articles" — start GPS and show loading states. */
function startLocating(): void {
  sessionStorage.setItem("tour-guide-started", "1");

  if (query !== null) {
    // Data already loaded — skip downloading phase
    if (position) {
      enterBrowsing();
    } else {
      state = { phase: "locating" };
      render();
    }
  } else {
    // Data still loading — show download progress
    state = { phase: "downloading", progress: downloadProgress };
    render();
  }

  if (!navigator.geolocation) {
    useMockData();
    return;
  }
  stopWatcher = watchLocation({
    onPosition: (pos) => {
      position = pos;
      switch (state.phase) {
        case "locating":
          enterBrowsing();
          break;
        case "loadingTiles":
          if (query instanceof TiledQuery) {
            void loadTilesForPosition(currentLang, loadGeneration);
          }
          break;
        case "browsing":
        case "detail":
          if (query instanceof TiledQuery) {
            void loadTilesForPosition(currentLang, loadGeneration);
          }
          render();
          break;
        default:
          break;
      }
    },
    onError: (error) => {
      switch (state.phase) {
        case "locating":
          state = { phase: "error", error };
          render();
          break;
        case "browsing":
        case "detail":
          // Already have position — ignore GPS blip
          break;
        default:
          break;
      }
    },
  });
}

// Handle browser back button / swipe-back from detail view
window.addEventListener("popstate", () => {
  if (state.phase === "detail") {
    showList();
  }
});

// Bootstrap: listen for service worker updates and load data
listenForSwUpdate();
loadLanguageData(currentLang);

// Skip welcome screen on reload if user already opted in this session
if (sessionStorage.getItem("tour-guide-started")) {
  startLocating();
} else {
  renderWelcome(app, startLocating, useMockData, currentLang, handleLangChange);
}
