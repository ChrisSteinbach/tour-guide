// Client-side nearest-neighbor query module
// Uses flat typed arrays to avoid GC pressure from millions of small objects.
// On first load: fetch binary → deserialize typed arrays → cache in IDB.
// On reload: read typed arrays from IDB (fast structured clone, no parse).

import type { ArticleMeta, FlatDelaunay, TriangulationFile } from "../geometry";
import { deserializeBinary, toCartesian } from "../geometry";

const EARTH_RADIUS_M = 6_371_000;
const RAD_TO_DEG = 180 / Math.PI;

// ---------- Types ----------

export interface QueryResult {
  title: string;
  lat: number;
  lon: number;
  distanceM: number;
}

// ---------- Flat geometry functions ----------

/** dot(cross(a, b), q) — sign test without allocating Point3D arrays. */
function side(
  vp: Float64Array, ai: number, bi: number,
  qx: number, qy: number, qz: number,
): number {
  const a0 = vp[ai], a1 = vp[ai + 1], a2 = vp[ai + 2];
  const b0 = vp[bi], b1 = vp[bi + 1], b2 = vp[bi + 2];
  return (a1 * b2 - a2 * b1) * qx + (a2 * b0 - a0 * b2) * qy + (a0 * b1 - a1 * b0) * qz;
}

/**
 * Spherical distance (radians) from vertex at offset vi to query point.
 *
 * Uses chord length rather than dot-product + acos to avoid catastrophic
 * cancellation when vertex coordinates are stored as Float32 (the binary
 * format).  For nearby points the dot product is ≈1 and (1 − dot) is
 * smaller than the Float32 rounding error, so acos(clamp(dot)) collapses
 * to 0.  Chord length computes differences instead, which stay well above
 * the noise floor.
 */
function dist(
  vp: Float64Array, vi: number,
  qx: number, qy: number, qz: number,
): number {
  const dx = vp[vi] - qx;
  const dy = vp[vi + 1] - qy;
  const dz = vp[vi + 2] - qz;
  const chord = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return 2 * Math.asin(chord < 2 ? chord / 2 : 1);
}

function flatLocate(
  fd: FlatDelaunay, qx: number, qy: number, qz: number, start?: number,
): number {
  let cur = start ?? fd.vertexTriangles[0];
  const maxSteps = Math.max(fd.triangleVertices.length / 3, 100);
  for (let step = 0; step < maxSteps; step++) {
    const ti = cur * 3;
    let crossed = false;
    for (let e = 0; e < 3; e++) {
      const ai = fd.triangleVertices[ti + e] * 3;
      const bi = fd.triangleVertices[ti + (e + 1) % 3] * 3;
      if (side(fd.vertexPoints, ai, bi, qx, qy, qz) < 0) {
        cur = fd.triangleNeighbors[ti + e];
        crossed = true;
        break;
      }
    }
    if (!crossed) return cur;
  }
  return cur;
}

function flatNeighbors(fd: FlatDelaunay, vIdx: number): number[] {
  const startTri = fd.vertexTriangles[vIdx];
  const neighbors: number[] = [];
  let cur = startTri;
  do {
    const ti = cur * 3;
    let k = 0;
    for (let i = 0; i < 3; i++) {
      if (fd.triangleVertices[ti + i] === vIdx) { k = i; break; }
    }
    neighbors.push(fd.triangleVertices[ti + (k + 1) % 3]);
    cur = fd.triangleNeighbors[ti + k];
  } while (cur !== startTri);
  return neighbors;
}

function flatFindNearest(
  fd: FlatDelaunay, qx: number, qy: number, qz: number, startTri?: number,
): number {
  const tIdx = flatLocate(fd, qx, qy, qz, startTri);
  const ti = tIdx * 3;

  let bestV = fd.triangleVertices[ti];
  let bestD = dist(fd.vertexPoints, bestV * 3, qx, qy, qz);
  for (let i = 1; i < 3; i++) {
    const v = fd.triangleVertices[ti + i];
    const d = dist(fd.vertexPoints, v * 3, qx, qy, qz);
    if (d < bestD) { bestD = d; bestV = v; }
  }

  let improved = true;
  while (improved) {
    improved = false;
    for (const nIdx of flatNeighbors(fd, bestV)) {
      const d = dist(fd.vertexPoints, nIdx * 3, qx, qy, qz);
      if (d < bestD) { bestD = d; bestV = nIdx; improved = true; break; }
    }
  }

  return bestV;
}

// ---------- Conversion ----------

/** Convert a TriangulationFile's flat number arrays to typed arrays. */
export function toFlatDelaunay(data: TriangulationFile): FlatDelaunay {
  return {
    vertexPoints: Float64Array.from(data.vertices),
    vertexTriangles: Uint32Array.from(data.vertexTriangles),
    triangleVertices: Uint32Array.from(data.triangleVertices),
    triangleNeighbors: Uint32Array.from(data.triangleNeighbors),
  };
}

// ---------- NearestQuery ----------

export class NearestQuery {
  readonly size: number;
  private fd: FlatDelaunay;
  private articles: ArticleMeta[];
  private lastTriangle: number;

  constructor(fd: FlatDelaunay, articles: ArticleMeta[]) {
    this.fd = fd;
    this.articles = articles;
    this.size = fd.vertexTriangles.length;
    this.lastTriangle = fd.vertexTriangles[0];
  }

  findNearest(lat: number, lon: number, k = 1): QueryResult[] {
    const [qx, qy, qz] = toCartesian({ lat, lon });
    const nearestIdx = flatFindNearest(this.fd, qx, qy, qz, this.lastTriangle);

    this.lastTriangle = this.fd.vertexTriangles[nearestIdx];

    if (k <= 1) {
      return [this.buildResult(nearestIdx, qx, qy, qz)];
    }

    // BFS expansion on Delaunay vertex neighbors for k > 1
    const visited = new Set<number>([nearestIdx]);
    const frontier = [nearestIdx];
    const candidates: { idx: number; d: number }[] = [
      { idx: nearestIdx, d: dist(this.fd.vertexPoints, nearestIdx * 3, qx, qy, qz) },
    ];

    const target = Math.max(k * 2, k + 6);
    while (frontier.length > 0 && candidates.length < target) {
      const current = frontier.shift()!;
      for (const nIdx of flatNeighbors(this.fd, current)) {
        if (visited.has(nIdx)) continue;
        visited.add(nIdx);
        candidates.push({
          idx: nIdx,
          d: dist(this.fd.vertexPoints, nIdx * 3, qx, qy, qz),
        });
        frontier.push(nIdx);
      }
    }

    candidates.sort((a, b) => a.d - b.d);
    return candidates.slice(0, k).map((c) => this.buildResult(c.idx, qx, qy, qz));
  }

  private buildResult(vIdx: number, qx: number, qy: number, qz: number): QueryResult {
    const vi = vIdx * 3;
    const vp = this.fd.vertexPoints;
    return {
      title: this.articles[vIdx].title,
      lat: Math.asin(Math.max(-1, Math.min(1, vp[vi + 2]))) * RAD_TO_DEG,
      lon: Math.atan2(vp[vi + 1], vp[vi]) * RAD_TO_DEG,
      distanceM: dist(vp, vi, qx, qy, qz) * EARTH_RADIUS_M,
    };
  }
}

// ---------- IndexedDB cache ----------

const IDB_NAME = "tour-guide";
const IDB_STORE = "cache";

interface CachedData {
  vertexPoints: Float64Array;
  vertexTriangles: Uint32Array;
  triangleVertices: Uint32Array;
  triangleNeighbors: Uint32Array;
  articles: string[]; // titles — lighter for structured clone than objects
}

function idbOpen(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<CachedData | undefined> {
  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
  });
}

function idbPut(db: IDBDatabase, key: string, value: CachedData): void {
  const tx = db.transaction(IDB_STORE, "readwrite");
  tx.objectStore(IDB_STORE).put(value, key);
}

// ---------- Loader ----------

export async function loadQuery(
  url: string,
  cacheKey = "triangulation-v2",
  onProgress?: (fraction: number) => void,
): Promise<NearestQuery> {
  // Try IDB for cached typed arrays (no parse, no deserialize)
  const t0 = performance.now();
  const db = typeof indexedDB !== "undefined" ? await idbOpen() : null;
  if (db) {
    const cached = await idbGet(db, cacheKey);
    if (cached) {
      const fd: FlatDelaunay = {
        vertexPoints: cached.vertexPoints,
        vertexTriangles: cached.vertexTriangles,
        triangleVertices: cached.triangleVertices,
        triangleNeighbors: cached.triangleNeighbors,
      };
      const articles = cached.articles.map((title) => ({ title }));
      console.log(`[perf] IDB cache hit — loaded in ${(performance.now() - t0).toFixed(0)}ms`);
      return new NearestQuery(fd, articles);
    }
  }

  // First load: fetch binary → deserialize → cache
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(url, { signal: controller.signal });

    let buf: ArrayBuffer;
    const total = Number(response.headers.get("Content-Length") || 0);
    if (onProgress && response.body && total > 0) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      onProgress(0);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        onProgress(Math.min(received / total, 1));
      }
      const result = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      buf = result.buffer;
    } else {
      if (onProgress) onProgress(-1); // indeterminate
      buf = await response.arrayBuffer();
    }

    const tFetch = performance.now();
    const sizeMB = (buf.byteLength / (1024 * 1024)).toFixed(1);
    console.log(`[perf] Fetched ${sizeMB} MB in ${(tFetch - t0).toFixed(0)}ms`);

    const { fd, articles } = deserializeBinary(buf);
    console.log(`[perf] Deserialized in ${(performance.now() - tFetch).toFixed(0)}ms`);

    if (db) {
      idbPut(db, cacheKey, {
        vertexPoints: fd.vertexPoints,
        vertexTriangles: fd.vertexTriangles,
        triangleVertices: fd.triangleVertices,
        triangleNeighbors: fd.triangleNeighbors,
        articles: articles.map((a) => a.title),
      });
    }

    return new NearestQuery(fd, articles);
  } finally {
    clearTimeout(timeoutId);
  }
}
