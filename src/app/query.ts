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

// ---------- IndexedDB helpers ----------

const IDB_NAME = "tour-guide";
const IDB_STORE = "cache";

interface CachedTriangulation {
  tri: SphericalDelaunay;
  articles: ArticleMeta[];
}

function idbOpen(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<CachedTriangulation | undefined> {
  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
  });
}

function idbPut(db: IDBDatabase, key: string, value: CachedTriangulation): void {
  const tx = db.transaction(IDB_STORE, "readwrite");
  tx.objectStore(IDB_STORE).put(value, key);
}

// ---------- Loader ----------

export async function loadQuery(url: string): Promise<NearestQuery> {
  // Try IndexedDB for pre-deserialized data (skips JSON parse + deserialize)
  const db = typeof indexedDB !== "undefined" ? await idbOpen() : null;
  if (db) {
    const cached = await idbGet(db, "triangulation");
    if (cached) {
      return new NearestQuery(cached.tri, cached.articles);
    }
  }

  // First load: fetch from network
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const data: TriangulationFile = await response.json();
    const { tri, articles } = deserialize(data);

    // Cache deserialized data for next load
    if (db) idbPut(db, "triangulation", { tri, articles });

    return new NearestQuery(tri, articles);
  } finally {
    clearTimeout(timeoutId);
  }
}
