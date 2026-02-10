import "./style.css";
import type { NearbyArticle, UserPosition, Article } from "./types";
import type { AppState } from "./status";
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

/** Brute-force nearest-neighbor: compute distances and sort ascending. */
function findNearby(position: UserPosition, articles: Article[]): NearbyArticle[] {
  return articles
    .map((a) => ({ ...a, distanceM: distanceMeters(position, a) }))
    .sort((a, b) => a.distanceM - b.distanceM);
}

const app = document.getElementById("app")!;
let stopWatcher: StopFn | null = null;
let currentArticles: NearbyArticle[] = [];
let selectedArticle: NearbyArticle | null = null;

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

function renderState(state: AppState): void {
  switch (state.kind) {
    case "loading":
      renderLoading(app);
      break;
    case "error":
      renderError(app, state.error, useMockData);
      break;
    case "ready": {
      currentArticles = findNearby(state.position, mockArticles);
      if (selectedArticle) return; // don't clobber detail view on position update
      renderNearbyList(app, currentArticles, showDetail);
      break;
    }
  }
}

function useMockData(): void {
  if (stopWatcher) {
    stopWatcher();
    stopWatcher = null;
  }
  renderState({ kind: "ready", position: mockPosition });
}

// Bootstrap
if (!navigator.geolocation) {
  useMockData();
} else {
  renderState({ kind: "loading" });
  stopWatcher = watchLocation({
    onPosition: (position) => renderState({ kind: "ready", position }),
    onError: (error) => renderState({ kind: "error", error }),
  });
}
