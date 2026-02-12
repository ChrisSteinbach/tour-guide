import "./style.css";
import type { NearbyArticle, UserPosition } from "./types";
import type { LocationError } from "./location";
import { mockPosition, mockArticles } from "./mock-data";
import { distanceMeters } from "./format";
import { renderNearbyList } from "./render";
import { renderLoading, renderError } from "./status";
import { watchLocation, type StopFn } from "./location";
import { fetchArticleSummary } from "./wiki-api";
import {
  renderDetailLoading,
  renderDetailReady,
  renderDetailError,
} from "./detail";
import { loadQuery, type NearestQuery } from "./query";

const NEARBY_COUNT = 10;

const app = document.getElementById("app")!;
let stopWatcher: StopFn | null = null;
let currentArticles: NearbyArticle[] = [];
let selectedArticle: NearbyArticle | null = null;

// Dual-loading state: triangulation data + GPS position
let query: NearestQuery | null = null;
let dataReady = false;
let position: UserPosition | null = null;
let locError: LocationError | null = null;

/** Compute nearby articles using query module or brute-force fallback. */
function getNearby(pos: UserPosition): NearbyArticle[] {
  if (query) {
    return query.findNearest(pos.lat, pos.lon, NEARBY_COUNT);
  }
  // Data failed to load — fall back to mock articles with brute-force
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
    const summary = await fetchArticleSummary(article.title);
    if (selectedArticle !== article) return;
    renderDetailReady(app, article, summary, showList);
  } catch (err) {
    if (selectedArticle !== article) return;
    const message = err instanceof Error ? err.message : "Unknown error";
    renderDetailError(app, article, message, showList, () => showDetail(article));
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
  if (selectedArticle) return; // don't clobber detail view on position update
  renderNearbyList(app, currentArticles, showDetail);
}

function useMockData(): void {
  if (stopWatcher) {
    stopWatcher();
    stopWatcher = null;
  }
  position = mockPosition;
  render();
}

// Bootstrap: load triangulation data and watch GPS in parallel
render();

loadQuery("/triangulation.json")
  .then((q) => { query = q; console.log(`Loaded ${q.size} articles`); })
  .catch((err) => { console.error("Failed to load triangulation data:", err); })
  .finally(() => { dataReady = true; render(); });

if (!navigator.geolocation) {
  useMockData();
} else {
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
