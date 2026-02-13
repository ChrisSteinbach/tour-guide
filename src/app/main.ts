import "./style.css";
import type { NearbyArticle, UserPosition } from "./types";
import type { LocationError } from "./location";
import { mockPosition, mockArticles } from "./mock-data";
import { distanceMeters } from "./format";
import { renderNearbyList } from "./render";
import { renderLoading, renderError, renderWelcome } from "./status";
import { watchLocation, type StopFn } from "./location";
import { fetchArticleSummary } from "./wiki-api";
import {
  renderDetailLoading,
  renderDetailReady,
  renderDetailError,
} from "./detail";
import { loadQuery, type NearestQuery } from "./query";
import { DEFAULT_LANG, SUPPORTED_LANGS } from "../lang";
import type { Lang } from "../lang";

const NEARBY_COUNT = 10;
const LANG_STORAGE_KEY = "tour-guide-lang";

const app = document.getElementById("app")!;
let stopWatcher: StopFn | null = null;
let currentArticles: NearbyArticle[] = [];
let selectedArticle: NearbyArticle | null = null;

// State
let query: NearestQuery | null = null;
let dataReady = false;
let loadGeneration = 0;
let started = false; // true once user opts in to location
let position: UserPosition | null = null;
let locError: LocationError | null = null;
let currentLang: Lang = getStoredLang();

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
    return query.findNearest(pos.lat, pos.lon, NEARBY_COUNT);
  }
  return mockArticles
    .map((a) => ({ ...a, distanceM: distanceMeters(pos, a) }))
    .sort((a, b) => a.distanceM - b.distanceM);
}

function showList(): void {
  selectedArticle = null;
  renderNearbyList(app, currentArticles, showDetail);
}

async function showDetail(article: NearbyArticle): Promise<void> {
  selectedArticle = article;
  renderDetailLoading(app, article, showList);
  try {
    const summary = await fetchArticleSummary(article.title, currentLang);
    if (selectedArticle !== article) return;
    renderDetailReady(app, article, summary, showList);
  } catch (err) {
    if (selectedArticle !== article) return;
    const message = err instanceof Error ? err.message : "Unknown error";
    renderDetailError(app, article, message, showList, () => showDetail(article), currentLang);
  }
}

/** Re-render based on current data + location state. */
function render(): void {
  if (!dataReady) {
    renderLoading(app, "Loading article data\u2026");
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
  currentArticles = getNearby(position);
  if (selectedArticle) return;
  renderNearbyList(app, currentArticles, showDetail);
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

function loadLanguageData(lang: Lang): void {
  dataReady = false;
  query = null;
  const gen = ++loadGeneration;
  if (started) render(); // show loading state
  loadQuery(`/triangulation-${lang}.bin`, `triangulation-v2-${lang}`)
    .then((q) => {
      if (gen !== loadGeneration) return; // stale load, discard
      query = q;
      console.log(`Loaded ${q.size} articles (${lang})`);
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

// Bootstrap: load data in the background
loadLanguageData(currentLang);

// Skip welcome screen on reload if user already opted in this session
if (sessionStorage.getItem("tour-guide-started")) {
  startLocating();
} else {
  renderWelcome(app, startLocating, useMockData, currentLang, handleLangChange);
}
