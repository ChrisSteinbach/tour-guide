import "./style.css";
import type { NearbyArticle, UserPosition } from "./types";
import type { LocationError } from "./location";
import { mockPosition, mockArticles } from "./mock-data";
import { distanceMeters, distanceBetweenPositions } from "./format";
import { renderNearbyList, updateNearbyDistances } from "./render";
import { renderLoading, renderLoadingProgress, renderError, renderWelcome } from "./status";
import { watchLocation, type StopFn } from "./location";
import { fetchArticleSummary } from "./wiki-api";
import {
  renderDetailLoading,
  renderDetailReady,
  renderDetailError,
} from "./detail";
import { loadQuery, checkForUpdate, fetchUpdate, dismissUpdate, type NearestQuery } from "./query";
import { DEFAULT_LANG, SUPPORTED_LANGS } from "../lang";
import type { Lang } from "../lang";

const NEARBY_TIERS = [10, 20, 50, 100];
const LANG_STORAGE_KEY = "tour-guide-lang";

const app = document.getElementById("app")!;
let stopWatcher: StopFn | null = null;
let currentArticles: NearbyArticle[] = [];
let selectedArticle: NearbyArticle | null = null;

// State
let query: NearestQuery | null = null;
let nearbyCount: number = NEARBY_TIERS[0];
let dataReady = false;
let loadGeneration = 0;
let started = false; // true once user opts in to location
let position: UserPosition | null = null;
let locError: LocationError | null = null;
let currentLang: Lang = getStoredLang();
let downloadProgress = -1; // 0–1 or -1 for indeterminate
let lastQueryPos: UserPosition | null = null;
const REQUERY_DISTANCE_M = 15;
let paused = false;
let pendingUpdate: { serverLastModified: string; lang: Lang } | null = null;
let updateDownloading = false;
let updateProgress = 0;


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

/** Compute nearby articles using query module or brute-force fallback. */
function getNearby(pos: UserPosition): NearbyArticle[] {
  if (query) {
    const t0 = performance.now();
    const results = query.findNearest(pos.lat, pos.lon, nearbyCount);
    console.log(`[perf] findNearest(k=${nearbyCount}) in ${(performance.now() - t0).toFixed(2)}ms`);
    return results;
  }
  return mockArticles
    .map((a) => ({ ...a, distanceM: distanceMeters(pos, a) }))
    .sort((a, b) => a.distanceM - b.distanceM);
}

function getNextTier(): number | undefined {
  const idx = NEARBY_TIERS.indexOf(nearbyCount);
  return idx >= 0 && idx < NEARBY_TIERS.length - 1 ? NEARBY_TIERS[idx + 1] : undefined;
}

function showMore(): void {
  const next = getNextTier();
  if (next === undefined || !position) return;
  nearbyCount = next;
  currentArticles = getNearby(position);
  renderNearbyList(app, currentArticles, selectArticle, currentLang, handleLangChange, showMore, getNextTier(), paused, togglePause);
}

function showList(): void {
  selectedArticle = null;
  renderNearbyList(app, currentArticles, selectArticle, currentLang, handleLangChange, showMore, getNextTier(), paused, togglePause);
}

function togglePause(): void {
  paused = !paused;
  if (!paused && position) {
    lastQueryPos = position;
    currentArticles = getNearby(position);
  }
  renderNearbyList(app, currentArticles, selectArticle, currentLang, handleLangChange, showMore, getNextTier(), paused, togglePause);
}

const goBack = () => history.back();

/** Void wrapper for showDetail — safe to pass as event callback. */
function selectArticle(article: NearbyArticle): void {
  void showDetail(article);
}

async function showDetail(article: NearbyArticle): Promise<void> {
  selectedArticle = article;
  history.pushState({ view: "detail" }, "");
  renderDetailLoading(app, article, goBack);
  try {
    const summary = await fetchArticleSummary(article.title, currentLang);
    if (selectedArticle !== article) return;
    renderDetailReady(app, article, summary, goBack);
  } catch (err) {
    if (selectedArticle !== article) return;
    const message = err instanceof Error ? err.message : "Unknown error";
    renderDetailError(app, article, message, goBack, () => { void showDetail(article); }, currentLang);
  }
}

/** Re-render based on current data + location state. */
function render(): void {
  if (!dataReady && started) {
    renderLoadingProgress(app, downloadProgress);
    return;
  }
  if (!dataReady) {
    return;
  }
  if (locError && !position) {
    renderError(app, locError, useMockData);
    return;
  }
  if (!position) {
    renderLoading(app);
    return;
  }
  if (selectedArticle) return;

  // Skip re-query when paused or position hasn't moved enough
  if (paused) return;
  if (lastQueryPos && distanceBetweenPositions(position, lastQueryPos) < REQUERY_DISTANCE_M) {
    return;
  }

  lastQueryPos = position;
  const newArticles = getNearby(position);

  // If showing the same articles, just update distances in-place
  // to avoid nuking the DOM (which closes open dropdowns like the lang select)
  const same =
    newArticles.length === currentArticles.length &&
    newArticles.every((a, i) => a.title === currentArticles[i].title);
  currentArticles = newArticles;

  if (same && app.querySelector(".nearby-list")) {
    updateNearbyDistances(app, currentArticles);
    return;
  }
  renderNearbyList(app, currentArticles, selectArticle, currentLang, handleLangChange, showMore, getNextTier(), paused, togglePause);
}

function useMockData(): void {
  if (stopWatcher) {
    stopWatcher();
    stopWatcher = null;
  }
  started = true;
  position = mockPosition;
  render();
}

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
    banner.querySelector(".update-banner-accept")!.addEventListener("click", acceptUpdate);
    banner.querySelector(".update-banner-dismiss")!.addEventListener("click", declineUpdate);
  }
}

function removeUpdateBanner(): void {
  document.getElementById("update-banner")?.remove();
}

function acceptUpdate(): void {
  if (!pendingUpdate) return;
  const { serverLastModified, lang } = pendingUpdate;
  updateDownloading = true;
  updateProgress = 0;
  renderUpdateBanner();

  const cacheKey = `triangulation-v3-${lang}`;
  const url = `${import.meta.env.BASE_URL}triangulation-${lang}.bin`;

  fetchUpdate(url, cacheKey, serverLastModified, (fraction) => {
    updateProgress = fraction < 0 ? 0 : fraction;
    renderUpdateBanner();
  })
    .then((q) => {
      if (currentLang !== lang) return; // language changed while downloading
      query = q;
      console.log(`Updated to new data: ${q.size} articles (${lang})`);
      lastQueryPos = null; // force re-query
      if (started && position) render();
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
  const { serverLastModified, lang } = pendingUpdate;
  void dismissUpdate(`triangulation-v3-${lang}`, serverLastModified);
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
  banner.querySelector(".update-banner-accept")!.addEventListener("click", () => {
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

function loadLanguageData(lang: Lang): void {
  dataReady = false;
  query = null;
  downloadProgress = -1;
  lastQueryPos = null;
  pendingUpdate = null;
  updateDownloading = false;
  removeUpdateBanner();
  const gen = ++loadGeneration;
  if (started) render(); // show loading state

  let lastRenderTime = 0;
  let lastRenderedPct = -2; // -2 so initial indeterminate (-1) triggers a render
  const onProgress = (fraction: number) => {
    if (gen !== loadGeneration) return;
    downloadProgress = fraction;
    if (!started) return;
    const pct = fraction < 0 ? -1 : Math.round(fraction * 100);
    const now = performance.now();
    if (pct !== lastRenderedPct && now - lastRenderTime >= 100) {
      lastRenderedPct = pct;
      lastRenderTime = now;
      render();
    }
  };

  loadQuery(`${import.meta.env.BASE_URL}triangulation-${lang}.bin`, `triangulation-v3-${lang}`, onProgress)
    .then((q) => {
      if (gen !== loadGeneration) return; // stale load, discard
      query = q;
      console.log(`Loaded ${q.size} articles (${lang})`);

      // Background check for newer data on server
      const cacheKey = `triangulation-v3-${lang}`;
      const url = `${import.meta.env.BASE_URL}triangulation-${lang}.bin`;
      void checkForUpdate(url, cacheKey).then((info) => {
        if (!info || gen !== loadGeneration) return;
        pendingUpdate = { serverLastModified: info.serverLastModified, lang };
        renderUpdateBanner();
      });
    })
    .catch((err) => {
      if (gen !== loadGeneration) return;
      console.error(`Failed to load triangulation data (${lang}):`, err);
    })
    .finally(() => {
      if (gen !== loadGeneration) return;
      dataReady = true;
      if (started) render();
    });
}

function handleLangChange(lang: Lang): void {
  currentLang = lang;
  nearbyCount = NEARBY_TIERS[0];
  storeLang(lang);
  loadLanguageData(lang);
}

/** User clicked "Find nearby articles" — start GPS and show loading states. */
function startLocating(): void {
  started = true;
  sessionStorage.setItem("tour-guide-started", "1");
  render();
  if (!navigator.geolocation) {
    useMockData();
    return;
  }
  stopWatcher = watchLocation({
    onPosition: (pos) => {
      position = pos;
      locError = null;
      render();
    },
    onError: (error) => {
      locError = error;
      render();
    },
  });
}

// Handle browser back button / swipe-back from detail view
window.addEventListener("popstate", () => {
  if (selectedArticle) {
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
