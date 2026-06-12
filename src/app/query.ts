// Client-side nearest-neighbor query module
// Uses flat typed arrays to avoid GC pressure from millions of small objects.

import type {
  ArticleMeta,
  FlatDelaunay,
  Point3D,
  TriangulationFile,
} from "../geometry";
import { toCartesian, toLatLon } from "../geometry";

const EARTH_RADIUS_M = 6_371_000;

// ---------- Types ----------

export interface QueryResult {
  title: string;
  lat: number;
  lon: number;
  distanceM: number;
  /** Article weight class (0-255); 0 when the article has none. */
  weight: number;
}

/**
 * Read-only record of the internal walk a single query performs, for
 * visualization. Filling a trace must never change a query's results.
 */
export interface WalkTrace {
  /** Triangle indices visited by the locate walk, in visit order (includes the final containing triangle). */
  locateTriangles: number[];
  /** True when the locate walk hit a cycle and the query fell back to the brute-force scan. */
  usedBruteForce: boolean;
  /** Vertex indices of the greedy descent, in order: first = best vertex of the located triangle, last = nearest vertex. */
  descentVertices: number[];
  /** Vertex indices visited by the BFS expansion (k>1 or weight-filtered), in visit order, excluding the seed. Empty for plain k=1 queries. */
  bfsVertices: number[];
  /** The unfiltered nearest vertex index (end of the descent, or brute-force result). */
  nearestVertex: number;
}

/** Returns an empty trace ready to be filled by a query. */
export function createWalkTrace(): WalkTrace {
  return {
    locateTriangles: [],
    usedBruteForce: false,
    descentVertices: [],
    bfsVertices: [],
    nearestVertex: -1,
  };
}

export interface FindNearestOptions {
  /**
   * Only vertices with weight >= minWeight count as results. Non-matching
   * vertices are still traversed during expansion — they are part of the
   * triangulation graph, and the nearest matches may sit behind them.
   */
  minWeight?: number;
  /**
   * When provided, the query fills this trace as it runs. Must never change
   * results — the untraced and traced paths return byte-identical output.
   */
  trace?: WalkTrace;
}

// ---------- Filtered-expansion bounds ----------

/**
 * Visit cap for weight-filtered BFS expansion:
 * Math.max(FILTERED_VISIT_FLOOR, FILTERED_VISIT_PER_RESULT * k) vertices.
 *
 * A filtered search must expand through non-matching vertices, so in a tile
 * with few or no matches the BFS would otherwise scan every vertex. The
 * floor lets small-k queries see past thousands of contiguous low-weight
 * stubs (rural areas dominated by bot-generated articles); the per-k term
 * scales the budget for large-k queries. When the cap is hit, however many
 * matches were found so far are returned.
 */
export const FILTERED_VISIT_FLOOR = 4096;
export const FILTERED_VISIT_PER_RESULT = 64;

// ---------- Flat geometry functions ----------

/** dot(cross(a, b), q) — sign test without allocating Point3D arrays. */
function side(
  vp: Float64Array,
  ai: number,
  bi: number,
  qx: number,
  qy: number,
  qz: number,
): number {
  const a0 = vp[ai],
    a1 = vp[ai + 1],
    a2 = vp[ai + 2];
  const b0 = vp[bi],
    b1 = vp[bi + 1],
    b2 = vp[bi + 2];
  return (
    (a1 * b2 - a2 * b1) * qx +
    (a2 * b0 - a0 * b2) * qy +
    (a0 * b1 - a1 * b0) * qz
  );
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
  vp: Float64Array,
  vi: number,
  qx: number,
  qy: number,
  qz: number,
): number {
  const dx = vp[vi] - qx;
  const dy = vp[vi + 1] - qy;
  const dz = vp[vi + 2] - qz;
  const chord = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return 2 * Math.asin(chord < 2 ? chord / 2 : 1);
}

/**
 * Locate the triangle containing query point (qx,qy,qz) via a triangle walk.
 * Returns the triangle index, or -1 if the walk gets stuck in a cycle
 * (caused by near-degenerate triangles from Float32 coordinate quantization).
 */
function flatLocate(
  fd: FlatDelaunay,
  qx: number,
  qy: number,
  qz: number,
  start?: number,
  trace?: WalkTrace,
): number {
  if (fd.vertexTriangles.length === 0) return 0;
  let cur = start ?? fd.vertexTriangles[0];
  const maxSteps = Math.max(fd.triangleVertices.length / 3, 100);
  // Ring buffer for cycle detection — catches loops up to HISTORY_SIZE/2 long.
  const HISTORY_SIZE = 16;
  const history = new Int32Array(HISTORY_SIZE).fill(-1);
  for (let step = 0; step < maxSteps; step++) {
    // Check if current triangle was visited recently (cycle detection)
    for (let h = 0; h < HISTORY_SIZE; h++) {
      if (history[h] === cur) return -1;
    }
    history[step % HISTORY_SIZE] = cur;
    if (trace) trace.locateTriangles.push(cur);

    const ti = cur * 3;
    let crossed = false;
    for (let e = 0; e < 3; e++) {
      const ai = fd.triangleVertices[ti + e] * 3;
      const bi = fd.triangleVertices[ti + ((e + 1) % 3)] * 3;
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
  const maxSteps = fd.triangleVertices.length / 3;
  for (let step = 0; step < maxSteps; step++) {
    const ti = cur * 3;
    let k = 0;
    for (let i = 0; i < 3; i++) {
      if (fd.triangleVertices[ti + i] === vIdx) {
        k = i;
        break;
      }
    }
    neighbors.push(fd.triangleVertices[ti + ((k + 1) % 3)]);
    cur = fd.triangleNeighbors[ti + k];
    if (cur === startTri) break;
  }
  return neighbors;
}

/** Brute-force scan of all vertices — O(V) fallback when the walk fails. */
function flatFindNearestBrute(
  fd: FlatDelaunay,
  qx: number,
  qy: number,
  qz: number,
): number {
  const V = fd.vertexTriangles.length;
  let bestV = 0;
  let bestD = dist(fd.vertexPoints, 0, qx, qy, qz);
  for (let v = 1; v < V; v++) {
    const d = dist(fd.vertexPoints, v * 3, qx, qy, qz);
    if (d < bestD) {
      bestD = d;
      bestV = v;
    }
  }
  return bestV;
}

function flatFindNearest(
  fd: FlatDelaunay,
  qx: number,
  qy: number,
  qz: number,
  startTri?: number,
  trace?: WalkTrace,
): number {
  const tIdx = flatLocate(fd, qx, qy, qz, startTri, trace);

  // Walk got stuck in a degenerate cycle — fall back to brute force
  if (tIdx < 0) {
    const result = flatFindNearestBrute(fd, qx, qy, qz);
    if (trace) {
      trace.usedBruteForce = true;
      trace.descentVertices = [result];
      trace.nearestVertex = result;
    }
    return result;
  }

  const ti = tIdx * 3;

  let bestV = fd.triangleVertices[ti];
  let bestD = dist(fd.vertexPoints, bestV * 3, qx, qy, qz);
  for (let i = 1; i < 3; i++) {
    const v = fd.triangleVertices[ti + i];
    const d = dist(fd.vertexPoints, v * 3, qx, qy, qz);
    if (d < bestD) {
      bestD = d;
      bestV = v;
    }
  }
  if (trace) trace.descentVertices.push(bestV);

  const maxWalk = fd.vertexTriangles.length;
  for (let step = 0; step < maxWalk; step++) {
    let improved = false;
    for (const nIdx of flatNeighbors(fd, bestV)) {
      const d = dist(fd.vertexPoints, nIdx * 3, qx, qy, qz);
      if (d < bestD) {
        bestD = d;
        bestV = nIdx;
        improved = true;
        if (trace) trace.descentVertices.push(bestV);
        break;
      }
    }
    if (!improved) break;
  }

  if (trace) trace.nearestVertex = bestV;
  return bestV;
}

// ---------- Conversion ----------

/** Convert a vertex index in a FlatDelaunay to lat/lon degrees. */
export function vertexLatLon(
  fd: FlatDelaunay,
  vertex: number,
): { lat: number; lon: number } {
  const vi = vertex * 3;
  const vp = fd.vertexPoints;
  const point: Point3D = [vp[vi], vp[vi + 1], vp[vi + 2]];
  return toLatLon(point);
}

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
  readonly defaultTriangle: number;
  private fd: FlatDelaunay;
  private articles: ArticleMeta[];

  constructor(fd: FlatDelaunay, articles: ArticleMeta[]) {
    this.fd = fd;
    this.articles = articles;
    this.size = fd.vertexTriangles.length;
    this.defaultTriangle = fd.vertexTriangles[0];
  }

  findNearest(
    lat: number,
    lon: number,
    k = 1,
    startTriangle?: number,
    opts?: FindNearestOptions,
  ): { results: QueryResult[]; lastTriangle: number } {
    const trace = opts?.trace;
    const [qx, qy, qz] = toCartesian({ lat, lon });
    const nearestIdx = flatFindNearest(
      this.fd,
      qx,
      qy,
      qz,
      startTriangle ?? this.defaultTriangle,
      trace,
    );

    // lastTriangle is the walk-start optimization for the next query —
    // always derived from the unfiltered nearest vertex.
    const lastTriangle = this.fd.vertexTriangles[nearestIdx];

    const minWeight = opts?.minWeight;
    if (minWeight !== undefined) {
      return {
        results: this.collectFiltered(
          nearestIdx,
          k,
          minWeight,
          qx,
          qy,
          qz,
          trace,
        ),
        lastTriangle,
      };
    }

    if (k <= 1) {
      return {
        results: [this.buildResult(nearestIdx, qx, qy, qz)],
        lastTriangle,
      };
    }

    // BFS expansion on Delaunay vertex neighbors for k > 1
    const visited = new Set<number>([nearestIdx]);
    const frontier = [nearestIdx];
    let frontierHead = 0;
    const candidates: { idx: number; d: number }[] = [
      {
        idx: nearestIdx,
        d: dist(this.fd.vertexPoints, nearestIdx * 3, qx, qy, qz),
      },
    ];

    // How many BFS candidates to explore before sorting and taking the top k.
    // Spherical Delaunay vertices have average degree ≤ 6 (Euler: E ≤ 3V−6).
    // k+6: for small k, ensures at least one full neighbor ring beyond the
    //       nearest vertex, so we don't miss closer points one hop away.
    // k*2: for large k, provides a proportional 2× oversampling margin as the
    //       search fans out across multiple hops (~⌈k/6⌉ rings).
    // Crossover at k=6. In practice the Delaunay locality property means the
    // true k-nearest are almost always within these bounds.
    const target = Math.max(k * 2, k + 6);
    while (frontierHead < frontier.length && candidates.length < target) {
      const current = frontier[frontierHead++];
      for (const nIdx of flatNeighbors(this.fd, current)) {
        if (visited.has(nIdx)) continue;
        visited.add(nIdx);
        if (trace) trace.bfsVertices.push(nIdx);
        candidates.push({
          idx: nIdx,
          d: dist(this.fd.vertexPoints, nIdx * 3, qx, qy, qz),
        });
        frontier.push(nIdx);
      }
    }

    candidates.sort((a, b) => a.d - b.d);
    return {
      results: candidates
        .slice(0, k)
        .map((c) => this.buildResult(c.idx, qx, qy, qz)),
      lastTriangle,
    };
  }

  /**
   * BFS expansion that only collects vertices with weight >= minWeight.
   * Non-matching vertices (including the seed, which is the walk's nearest
   * vertex and may itself be below the threshold) still join the frontier
   * so the search can expand through them to matches further out.
   */
  private collectFiltered(
    seedIdx: number,
    k: number,
    minWeight: number,
    qx: number,
    qy: number,
    qz: number,
    trace?: WalkTrace,
  ): QueryResult[] {
    const vp = this.fd.vertexPoints;
    const visited = new Set<number>([seedIdx]);
    const frontier = [seedIdx];
    let frontierHead = 0;
    const candidates: { idx: number; d: number }[] = [];
    if ((this.articles[seedIdx].weight ?? 0) >= minWeight) {
      candidates.push({ idx: seedIdx, d: dist(vp, seedIdx * 3, qx, qy, qz) });
    }

    // Same oversampling target as the unfiltered BFS (see comment there),
    // but counted in MATCHING candidates: keep expanding until enough
    // matches are collected, the graph is exhausted, or the visit cap is
    // hit (see FILTERED_VISIT_FLOOR for the cap rationale).
    const target = Math.max(k * 2, k + 6);
    const maxVisited = Math.max(
      FILTERED_VISIT_FLOOR,
      FILTERED_VISIT_PER_RESULT * k,
    );
    while (
      frontierHead < frontier.length &&
      candidates.length < target &&
      visited.size < maxVisited
    ) {
      const current = frontier[frontierHead++];
      for (const nIdx of flatNeighbors(this.fd, current)) {
        if (visited.has(nIdx)) continue;
        visited.add(nIdx);
        if (trace) trace.bfsVertices.push(nIdx);
        if ((this.articles[nIdx].weight ?? 0) >= minWeight) {
          candidates.push({ idx: nIdx, d: dist(vp, nIdx * 3, qx, qy, qz) });
        }
        frontier.push(nIdx);
      }
    }

    candidates.sort((a, b) => a.d - b.d);
    return candidates
      .slice(0, k)
      .map((c) => this.buildResult(c.idx, qx, qy, qz));
  }

  private buildResult(
    vIdx: number,
    qx: number,
    qy: number,
    qz: number,
  ): QueryResult {
    const { lat, lon } = vertexLatLon(this.fd, vIdx);
    return {
      title: this.articles[vIdx].title,
      lat,
      lon,
      distanceM:
        dist(this.fd.vertexPoints, vIdx * 3, qx, qy, qz) * EARTH_RADIUS_M,
      weight: this.articles[vIdx].weight ?? 0,
    };
  }

  /** The underlying triangulation arrays. Callers must not mutate them. */
  get delaunay(): FlatDelaunay {
    return this.fd;
  }

  /** Title of the article at a vertex index. */
  articleTitle(vertex: number): string {
    return this.articles[vertex].title;
  }

  /** Weight class of the article at a vertex index; 0 when absent. */
  articleWeight(vertex: number): number {
    return this.articles[vertex].weight ?? 0;
  }
}
