import type { NearbyArticle } from "./types";

// Distinct Wikipedia articles can share bit-identical coordinates — e.g. a
// building and the institutions housed in it — so a single triangulation
// vertex can carry a large group of articles (see src/article-payload.ts).
// Nearest-neighbor queries emit one NearbyArticle per co-located article,
// which would otherwise draw hundreds of overlapping blips/markers at one
// spot. Collapsing them into a group lets the radar and map draw ONE
// representative per location, with a count.

/**
 * A set of NearbyArticles sharing one coordinate, collapsed into a single
 * radar blip / map marker. `representative` is the highest-weight member
 * (ties broken by first occurrence in the input); `members` preserves every
 * co-located article in input order. A lone article becomes a group of one
 * whose representative is itself.
 */
export interface CoincidentGroup {
  representative: NearbyArticle;
  members: NearbyArticle[];
  lat: number;
  lon: number;
  distanceM: number;
}

/**
 * Group nearby articles by exact (lat, lon). Preserves first-seen group
 * order and within-group input order — callers that want a weight-sorted
 * view can sort `members` themselves.
 */
export function collapseCoincident(
  articles: NearbyArticle[],
): CoincidentGroup[] {
  const groups = new Map<string, CoincidentGroup>();
  const order: CoincidentGroup[] = [];

  for (const article of articles) {
    const key = `${article.lat},${article.lon}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        representative: article,
        members: [],
        lat: article.lat,
        lon: article.lon,
        distanceM: article.distanceM,
      };
      groups.set(key, group);
      order.push(group);
    }
    group.members.push(article);
    if ((article.weight ?? 0) > (group.representative.weight ?? 0)) {
      group.representative = article;
    }
  }

  return order;
}
