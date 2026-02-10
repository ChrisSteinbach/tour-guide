import "./style.css";
import type { NearbyArticle, UserPosition, Article } from "./types";
import { mockPosition, mockArticles } from "./mock-data";
import { distanceMeters } from "./format";
import { renderNearbyList } from "./render";

/** Brute-force nearest-neighbor: compute distances and sort ascending. */
function findNearby(position: UserPosition, articles: Article[]): NearbyArticle[] {
  return articles
    .map((a) => ({ ...a, distanceM: distanceMeters(position, a) }))
    .sort((a, b) => a.distanceM - b.distanceM);
}

const app = document.getElementById("app")!;
const nearby = findNearby(mockPosition, mockArticles);
renderNearbyList(app, nearby);
