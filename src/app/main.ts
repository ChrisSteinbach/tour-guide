import "./style.css";
import type { NearbyArticle, UserPosition, Article } from "./types";
import type { AppState } from "./status";
import { mockPosition, mockArticles } from "./mock-data";
import { distanceMeters } from "./format";
import { renderNearbyList } from "./render";
import { renderLoading, renderError } from "./status";
import { watchLocation, type StopFn } from "./location";

/** Brute-force nearest-neighbor: compute distances and sort ascending. */
function findNearby(position: UserPosition, articles: Article[]): NearbyArticle[] {
  return articles
    .map((a) => ({ ...a, distanceM: distanceMeters(position, a) }))
    .sort((a, b) => a.distanceM - b.distanceM);
}

const app = document.getElementById("app")!;
let stopWatcher: StopFn | null = null;

function renderState(state: AppState): void {
  switch (state.kind) {
    case "loading":
      renderLoading(app);
      break;
    case "error":
      renderError(app, state.error, useMockData);
      break;
    case "ready": {
      const nearby = findNearby(state.position, mockArticles);
      renderNearbyList(app, nearby);
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
