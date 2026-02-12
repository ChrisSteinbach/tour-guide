// Client-side nearest-neighbor query module
// Loads serialized triangulation data and answers k-nearest queries in O(√N) time

import type { SphericalDelaunay, ArticleMeta, TriangulationFile } from "../geometry";
import {
  deserialize,
  toCartesian,
  toLatLon,
  sphericalDistance,
  findNearest,
  vertexNeighbors,
} from "../geometry";

const EARTH_RADIUS_M = 6_371_000;

export interface QueryResult {
  title: string;
  desc: string;
  lat: number;
  lon: number;
  distanceM: number;
}

export class NearestQuery {
  readonly size: number;
  private tri: SphericalDelaunay;
  private articles: ArticleMeta[];
  private lastTriangle: number;

  constructor(tri: SphericalDelaunay, articles: ArticleMeta[]) {
    this.tri = tri;
    this.articles = articles;
    this.size = tri.vertices.length;
    this.lastTriangle = tri.vertices[0].triangle;
  }

  findNearest(lat: number, lon: number, k = 1): QueryResult[] {
    const query = toCartesian({ lat, lon });
    const nearestIdx = findNearest(this.tri, query, this.lastTriangle);

    // Update walk cache for spatial locality
    this.lastTriangle = this.tri.vertices[nearestIdx].triangle;

    if (k <= 1) {
      return [this.buildResult(nearestIdx, query)];
    }

    // BFS expansion on Delaunay vertex neighbors for k > 1
    const visited = new Set<number>([nearestIdx]);
    const frontier = [nearestIdx];
    const candidates: { idx: number; dist: number }[] = [
      { idx: nearestIdx, dist: sphericalDistance(this.tri.vertices[nearestIdx].point, query) },
    ];

    // Expand until we have enough candidates (~2k vertices)
    const target = Math.max(k * 2, k + 6);
    while (frontier.length > 0 && candidates.length < target) {
      const current = frontier.shift()!;
      for (const nIdx of vertexNeighbors(this.tri, current)) {
        if (visited.has(nIdx)) continue;
        visited.add(nIdx);
        candidates.push({
          idx: nIdx,
          dist: sphericalDistance(this.tri.vertices[nIdx].point, query),
        });
        frontier.push(nIdx);
      }
    }

    // Sort by distance and take top k
    candidates.sort((a, b) => a.dist - b.dist);
    return candidates.slice(0, k).map((c) => this.buildResult(c.idx, query));
  }

  private buildResult(vIdx: number, query: import("../geometry").Point3D): QueryResult {
    const article = this.articles[vIdx];
    const pos = toLatLon(this.tri.vertices[vIdx].point);
    const dist = sphericalDistance(this.tri.vertices[vIdx].point, query);
    return {
      title: article.title,
      desc: article.desc,
      lat: pos.lat,
      lon: pos.lon,
      distanceM: dist * EARTH_RADIUS_M,
    };
  }
}

export async function loadQuery(url: string): Promise<NearestQuery> {
  const cache = typeof caches !== "undefined"
    ? await caches.open("triangulation-data")
    : null;

  // Try cache first
  const cached = cache ? await cache.match(url) : null;
  let response: Response;

  if (cached) {
    response = cached;
  } else {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);
    try {
      response = await fetch(url, { signal: controller.signal });
      if (cache) cache.put(url, response.clone());
    } finally {
      clearTimeout(timeoutId);
    }
  }

  const data: TriangulationFile = await response.json();
  const { tri, articles } = deserialize(data);
  return new NearestQuery(tri, articles);
}
