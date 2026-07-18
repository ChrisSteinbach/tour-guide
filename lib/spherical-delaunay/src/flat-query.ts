// Nearest-neighbor queries over the flat typed-array representation.
//
// This is the canonical query implementation. It operates on FlatDelaunay
// (typed arrays) rather than the SphericalDelaunay object graph so callers
// that deserialize binary tiles can query without conversion, and so the
// hot path allocates nothing per step. The algorithms are hardened for
// real tile data: patch triangulations whose convex hull is a thin lens
// (queries outside the patch have no containing triangle), and Float32
// coordinate quantization (degenerate slivers, coincident duplicates).

import type { FlatDelaunay } from "./serialization.js";
import type { LatLon, Point3D } from "./index.js";
import { toLatLon } from "./index.js";

// ---------- Walk tracing ----------

/**
 * Read-only record of the internal walk a single query performs, for
 * visualization. Filling a trace must never change a query's results.
 */
export interface WalkTrace {
  /** Triangle indices visited by the locate walk, in visit order (includes the final containing triangle). */
  locateTriangles: number[];
  /** True when the locate walk hit a cycle and the query fell back to the brute-force scan. */
  usedBruteForce: boolean;
  /** Vertex indices of the greedy descent, in order: first = the walk's seed (closest vertex seen by the locate walk), last = nearest vertex. */
  descentVertices: number[];
  /** Vertex indices visited by the BFS expansion (k>1 or filtered), in visit order, excluding the seed. Empty for plain k=1 queries. */
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

// ---------- Filtered-expansion bounds ----------

/**
 * Visit cap for filtered BFS expansion:
 * Math.max(FILTERED_VISIT_FLOOR, FILTERED_VISIT_PER_RESULT * k) vertices.
 *
 * A filtered search must expand through non-matching vertices, so in a
 * triangulation with few or no matches the BFS would otherwise scan every
 * vertex. The floor lets small-k queries see past thousands of contiguous
 * non-matching vertices (e.g. rural areas dominated by low-weight stub
 * articles); the per-k term scales the budget for large-k queries. When
 * the cap is hit, however many matches were found so far are returned.
 */
export const FILTERED_VISIT_FLOOR = 4096;
export const FILTERED_VISIT_PER_RESULT = 64;

// ---------- Flat geometry helpers ----------

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
 * How many walk steps may pass without the closest-seen vertex improving
 * before the walk gives up (restarting once from the anchor, then seeding
 * the descent with the best vertex found).
 *
 * A patch's vertices cover only part of the sphere, so their convex hull
 * is a thin lens. Its underside ("back-closure" facets spanning the rim)
 * has antipodally-flipped edge tests, which means a query outside the
 * patch is contained by NO facet — the classic walk can never terminate by
 * containment and instead orbits the rim for thousands of steps until
 * maxSteps or cycle detection rescues it. An orbit never gets closer to
 * the query, so a stretch of LOCATE_PATIENCE steps with no strictly closer
 * vertex identifies one cheaply and cuts the walk short right after it has
 * passed the rim vertices nearest the query. Healthy in-patch walks
 * approach the query throughout and terminate by containment long before
 * this fires.
 */
const LOCATE_PATIENCE = 64;

/**
 * Determinant threshold below which a triangle is unambiguously part of
 * the hull's back closure (its plane faces the sphere center). The
 * triple-product det[a,b,c] is positive for the patch's true Delaunay
 * triangles and negative for the lens underside, but Float32 coordinate
 * quantization fills the band |det| ≲ 1e-9 with degenerate slivers whose
 * sign is noise. Rounding can only move a det by ~1e-9, so no genuine
 * front triangle can fall below this threshold.
 */
const BACK_CLOSURE_MAX_DET = -1e-8;

/**
 * Below this determinant a triangle's area is so close to zero that its
 * stored winding no longer encodes a reliable orientation.
 */
const DEGENERATE_DET = 1e-9;

/**
 * Squared chord length of a 1° great-circle arc. An edge longer than this
 * in a triangle with no measurable area marks a back-closure chord: the
 * underside triangulates the rim with patch-spanning slivers, while every
 * legitimately large front triangle (e.g. over open sea) has det well
 * above the noise floor because det scales with area.
 */
const WIDE_EDGE_CHORD_SQ = (2 * Math.sin(Math.PI / 360)) ** 2;

/**
 * Mark triangles of the hull's back closure. The locate walk refuses to
 * cross into them. Caught by either rule:
 *   - det < BACK_CLOSURE_MAX_DET: unambiguously back-facing;
 *   - degenerate AND wide: orientation is unrecoverable from a zero-area
 *     sliver, but no front triangle the walk could need is both wide and
 *     area-free, while thin rim chords are exactly that.
 * For a full-sphere triangulation the hull contains the center, every det
 * is comfortably positive, and the mask is all zeros.
 */
function markBackClosure(fd: FlatDelaunay): Uint8Array {
  const T = fd.triangleVertices.length / 3;
  const mask = new Uint8Array(T);
  const vp = fd.vertexPoints;
  for (let t = 0; t < T; t++) {
    const ti = t * 3;
    const ai = fd.triangleVertices[ti] * 3;
    const bi = fd.triangleVertices[ti + 1] * 3;
    const ci = fd.triangleVertices[ti + 2] * 3;
    const det = side(vp, ai, bi, vp[ci], vp[ci + 1], vp[ci + 2]);
    if (det < BACK_CLOSURE_MAX_DET) {
      mask[t] = 1;
      continue;
    }
    if (det >= DEGENERATE_DET) continue;
    for (const [p, q] of [
      [ai, bi],
      [bi, ci],
      [ci, ai],
    ]) {
      const dx = vp[p] - vp[q];
      const dy = vp[p + 1] - vp[q + 1];
      const dz = vp[p + 2] - vp[q + 2];
      if (dx * dx + dy * dy + dz * dz > WIDE_EDGE_CHORD_SQ) {
        mask[t] = 1;
        break;
      }
    }
  }
  return mask;
}

/**
 * How a locate walk ended, for the two consumers of the walk:
 * nearest-vertex search reads `seedVertex`, point location reads
 * `stopTriangle`.
 */
interface LocateExit {
  /**
   * Vertex to seed the greedy descent from: the vertex closest to the
   * query among all triangles the walk visited. -1 if the walk got stuck
   * in a cycle while still improving (near-degenerate triangles from
   * Float32 coordinate quantization) — the caller falls back to a
   * brute-force scan.
   */
  seedVertex: number;
  /**
   * The triangle where the walk stopped because no failing edge could be
   * crossed — true containment (no failing edge at all) or a rim stall
   * (every failing edge borders the back closure). -1 when the walk was
   * cut short instead (patience, cycle, step cap) and its final triangle
   * says nothing about containment.
   */
  stopTriangle: number;
}

/**
 * Walk the triangulation toward query point (qx,qy,qz); see LocateExit
 * for the two results a walk produces.
 *
 * For queries inside the patch the walk reaches the containing triangle
 * exactly as the textbook algorithm does. For queries outside the patch
 * (adjacent tiles are routinely queried with such positions) there is no
 * containing triangle; the walk heads toward the rim, slides along it as
 * long as rim vertices keep getting closer to the query, and is then
 * stopped by the patience rule (see LOCATE_PATIENCE).
 *
 * The walk never crosses into `backClosure` triangles. Beyond keeping
 * edge tests on the well-behaved front side, this keeps the X-ray walk
 * trace honest: back-closure facets are patch-spanning chords between rim
 * vertices, and letting the walk slide across them paints whole-patch
 * streaks in the overlay even when only a handful of steps are involved.
 * Rim edges act as walls instead — the walk slides along the narrow front
 * triangles of the rim.
 *
 * When a walk stalls — patience runs out or a cycle is hit — it restarts
 * once from `anchor`, a triangle deep in the point cloud's interior. This
 * rescues walks whose start triangle lies on the hull's back closure
 * (a warm start from a previous out-of-patch query can name one): edge
 * tests there are flipped, so such walks strand near the rim instead of
 * reaching the interior. Seeding the descent from the best-seen vertex
 * (never from an arbitrary stopping triangle) matters for correctness:
 * Float32 quantization collapses co-located points into clusters whose
 * inner vertices have no strictly-closer neighbor, so a greedy descent
 * started far from the query can stall in such a pocket kilometres away.
 *
 * Cycles are split by recent progress. A cycle hit after the walk stopped
 * improving is just a rim orbit closing on itself — the best-seen vertex
 * is the right seed and no fallback is needed. A cycle hit while the walk
 * was still improving means a degenerate local tangle right where the
 * answer should be; only the brute-force scan is reliable there (-1).
 */
function flatLocate(
  fd: FlatDelaunay,
  backClosure: Uint8Array,
  qx: number,
  qy: number,
  qz: number,
  start: number | undefined,
  anchor: number | undefined,
  trace?: WalkTrace,
): LocateExit {
  if (fd.vertexTriangles.length === 0)
    return { seedVertex: 0, stopTriangle: -1 };
  let cur = start ?? anchor ?? fd.vertexTriangles[0];
  // One restart credit: -1 once spent or when the walk already starts there.
  let restartTo = anchor !== undefined && anchor !== cur ? anchor : -1;
  const vp = fd.vertexPoints;
  const maxSteps = Math.max(fd.triangleVertices.length / 3, 100);
  // Ring buffer for cycle detection — catches loops up to HISTORY_SIZE/2 long.
  const HISTORY_SIZE = 16;
  const history = new Int32Array(HISTORY_SIZE).fill(-1);
  let bestVertex = -1;
  let bestSq = Infinity;
  let sinceImproved = 0;
  for (let step = 0; step < maxSteps; step++) {
    // Check if current triangle was visited recently (cycle detection)
    let cycled = false;
    for (let h = 0; h < HISTORY_SIZE; h++) {
      if (history[h] === cur) {
        cycled = true;
        break;
      }
    }

    const ti = cur * 3;

    // Track the closest vertex seen so far (squared chord length — cheap
    // and monotone in spherical distance). Strict improvement only, so
    // revisits and coincident duplicates count toward the patience limit.
    if (!cycled) {
      let improved = false;
      for (let i = 0; i < 3; i++) {
        const vi = fd.triangleVertices[ti + i] * 3;
        const dx = vp[vi] - qx;
        const dy = vp[vi + 1] - qy;
        const dz = vp[vi + 2] - qz;
        const sq = dx * dx + dy * dy + dz * dz;
        if (sq < bestSq) {
          bestSq = sq;
          bestVertex = fd.triangleVertices[ti + i];
          improved = true;
        }
      }
      sinceImproved = improved ? 0 : sinceImproved + 1;
    }

    if (cycled || sinceImproved >= LOCATE_PATIENCE) {
      if (restartTo >= 0) {
        cur = restartTo;
        restartTo = -1;
        history.fill(-1);
        sinceImproved = 0;
        continue;
      }
      // Cycle while still improving = degenerate tangle → brute force.
      // Cycle after progress stopped = orbit closing → best-seen seeds fine.
      return {
        seedVertex:
          cycled && sinceImproved < HISTORY_SIZE / 2 ? -1 : bestVertex,
        stopTriangle: -1,
      };
    }

    history[step % HISTORY_SIZE] = cur;
    if (trace) trace.locateTriangles.push(cur);

    let crossed = false;
    for (let e = 0; e < 3; e++) {
      const ai = fd.triangleVertices[ti + e] * 3;
      const bi = fd.triangleVertices[ti + ((e + 1) % 3)] * 3;
      if (side(vp, ai, bi, qx, qy, qz) < 0) {
        const neighbor = fd.triangleNeighbors[ti + e];
        // Rim edge — the query lies beyond the hull here. Try the other
        // edges (sliding along the rim); a triangle with no crossable
        // failing edge ends the walk.
        if (backClosure[neighbor] === 1) continue;
        cur = neighbor;
        crossed = true;
        break;
      }
    }
    if (!crossed) return { seedVertex: bestVertex, stopTriangle: cur };
  }
  return { seedVertex: bestVertex, stopTriangle: -1 };
}

/**
 * Delaunay neighbors of a vertex, enumerated by walking its triangle fan.
 *
 * With `skipTriangles` (the back-closure mask), neighbors contributed by
 * masked fan triangles are omitted — for a rim vertex those are chords to
 * distant rim vertices across the hull's underside. BFS expansions pass
 * the mask so their frontier grows through local front-side edges only:
 * chord edges teleport the frontier along the patch boundary, scattering
 * the visit budget over rim clusters hundreds of kilometres away and
 * breaking the "hop order roughly tracks distance order" assumption the
 * expansion budget relies on. The fan is still traversed THROUGH masked
 * triangles (the walk needs the full cycle); only emission is skipped.
 */
export function vertexNeighbors(
  fd: FlatDelaunay,
  vIdx: number,
  skipTriangles?: Uint8Array,
): number[] {
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
    if (skipTriangles === undefined || skipTriangles[cur] === 0)
      neighbors.push(fd.triangleVertices[ti + ((k + 1) % 3)]);
    cur = fd.triangleNeighbors[ti + k];
    if (cur === startTri) break;
  }
  return neighbors;
}

/**
 * Escape hatch for greedy-descent stalls on coincident-duplicate clusters.
 *
 * Float32 quantization collapses co-located points onto identical
 * coordinates, and a cluster's inner vertex can have a fan made only of
 * equal-distance twins and strictly-farther outsiders — the strict descent
 * stops there even when closer vertices lie just beyond the cluster. Flood
 * the equal-distance plateau through the Delaunay graph and return a
 * strictly closer vertex adjacent to any of its members, or -1 when the
 * plateau really is the local minimum. Exact float equality keeps the
 * plateau small: it only spans vertices at identical quantized coordinates
 * (or exact distance ties).
 */
function plateauEscape(
  fd: FlatDelaunay,
  from: number,
  d0: number,
  qx: number,
  qy: number,
  qz: number,
): number {
  const plateau = [from];
  const seen = new Set<number>([from]);
  for (let head = 0; head < plateau.length; head++) {
    for (const n of vertexNeighbors(fd, plateau[head])) {
      if (seen.has(n)) continue;
      seen.add(n);
      const d = dist(fd.vertexPoints, n * 3, qx, qy, qz);
      if (d < d0) return n;
      if (d === d0) plateau.push(n);
    }
  }
  return -1;
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
  backClosure: Uint8Array,
  qx: number,
  qy: number,
  qz: number,
  startTri: number | undefined,
  anchorTri: number | undefined,
  trace?: WalkTrace,
): number {
  const seed = flatLocate(
    fd,
    backClosure,
    qx,
    qy,
    qz,
    startTri,
    anchorTri,
    trace,
  ).seedVertex;

  // Walk got stuck in a degenerate cycle — fall back to brute force
  if (seed < 0) {
    const result = flatFindNearestBrute(fd, qx, qy, qz);
    if (trace) {
      trace.usedBruteForce = true;
      trace.descentVertices = [result];
      trace.nearestVertex = result;
    }
    return result;
  }

  let bestV = seed;
  let bestD = dist(fd.vertexPoints, seed * 3, qx, qy, qz);
  if (trace) trace.descentVertices.push(bestV);

  const maxWalk = fd.vertexTriangles.length;
  for (let step = 0; step < maxWalk; step++) {
    let improved = false;
    for (const nIdx of vertexNeighbors(fd, bestV)) {
      const d = dist(fd.vertexPoints, nIdx * 3, qx, qy, qz);
      if (d < bestD) {
        bestD = d;
        bestV = nIdx;
        improved = true;
        if (trace) trace.descentVertices.push(bestV);
        break;
      }
    }
    if (!improved) {
      // No strictly closer fan member — tunnel through coincident
      // duplicates before accepting this as the minimum.
      const out = plateauEscape(fd, bestV, bestD, qx, qy, qz);
      if (out < 0) break;
      bestD = dist(fd.vertexPoints, out * 3, qx, qy, qz);
      bestV = out;
      if (trace) trace.descentVertices.push(bestV);
    }
  }

  if (trace) trace.nearestVertex = bestV;
  return bestV;
}

// ---------- Conversion ----------

/** Convert a vertex index in a FlatDelaunay to lat/lon degrees. */
export function vertexLatLon(fd: FlatDelaunay, vertex: number): LatLon {
  const vi = vertex * 3;
  const vp = fd.vertexPoints;
  const point: Point3D = [vp[vi], vp[vi + 1], vp[vi + 2]];
  return toLatLon(point);
}

// ---------- Query context ----------

/**
 * Pick the walk anchor: the incident triangle of the vertex nearest the
 * point cloud's centroid. Hull triangles on the lens underside touch only
 * rim vertices, so a maximally-interior vertex anchors the walk on the
 * well-behaved front side regardless of how triangles happen to be ordered
 * in the file (vertexTriangles[0] lands on the underside for some inputs).
 */
function pickAnchorTriangle(fd: FlatDelaunay): number {
  const V = fd.vertexTriangles.length;
  const vp = fd.vertexPoints;
  let cx = 0,
    cy = 0,
    cz = 0;
  for (let v = 0; v < V; v++) {
    cx += vp[v * 3];
    cy += vp[v * 3 + 1];
    cz += vp[v * 3 + 2];
  }
  let bestV = 0;
  let bestSq = Infinity;
  for (let v = 0; v < V; v++) {
    // Offset from the (unnormalized) centroid direction — comparing
    // V·p − c is equivalent to comparing against the mean point.
    const dx = vp[v * 3] * V - cx;
    const dy = vp[v * 3 + 1] * V - cy;
    const dz = vp[v * 3 + 2] * V - cz;
    const sq = dx * dx + dy * dy + dz * dz;
    if (sq < bestSq) {
      bestSq = sq;
      bestV = v;
    }
  }
  return fd.vertexTriangles[bestV];
}

/**
 * Per-triangulation state the queries need: the back-closure mask and the
 * walk anchor. Compute it once per FlatDelaunay (both fields cost a full
 * pass over the data) and reuse it across queries.
 */
export interface QueryContext {
  readonly fd: FlatDelaunay;
  /** 1 = back-closure facet; walks and expansions never enter these. */
  readonly backClosure: Uint8Array;
  /** Default walk start and stall-restart triangle, deep in the interior. */
  readonly anchorTriangle: number;
}

/** Build the reusable query state for a triangulation. */
export function createQueryContext(fd: FlatDelaunay): QueryContext {
  return {
    fd,
    backClosure: markBackClosure(fd),
    anchorTriangle:
      fd.vertexTriangles.length > 0
        ? pickAnchorTriangle(fd)
        : fd.vertexTriangles[0],
  };
}

// ---------- Nearest-vertex search ----------

/** A vertex matched by a search, with its spherical distance in radians. */
export interface VertexHit {
  vertex: number;
  distance: number;
}

export interface NearestVerticesOptions {
  /** Warm-start triangle for the locate walk (e.g. from a previous query). */
  startTriangle?: number;
  /**
   * Only vertices accepted by the filter count as results. Non-matching
   * vertices are still traversed during expansion — they are part of the
   * triangulation graph, and the nearest matches may sit behind them.
   */
  filter?: (vertex: number) => boolean;
  /**
   * When provided, the query fills this trace as it runs. Must never change
   * results — the untraced and traced paths return byte-identical output.
   */
  trace?: WalkTrace;
}

export interface NearestVerticesResult {
  /**
   * Up to k matching vertices, sorted by ascending distance. Unfiltered,
   * hits[0].vertex is always `nearestVertex`. Filtered, hits contains only
   * filter-passing vertices, so hits[0] coincides with `nearestVertex`
   * unless the filter excluded the globally nearest vertex.
   */
  hits: VertexHit[];
  /**
   * The unfiltered nearest vertex — end of the locate walk and greedy
   * descent, independent of `filter`. Its incident triangle
   * (fd.vertexTriangles[nearestVertex]) is the natural warm start for the
   * next query.
   */
  nearestVertex: number;
}

/**
 * Find the k vertices nearest to `query` (a unit-sphere point).
 *
 * Locates the neighborhood via triangle walk + greedy descent, then — for
 * k > 1 or filtered searches — expands over Delaunay vertex neighbors in
 * BFS order, collecting candidates until the oversampling target is met.
 */
export function findNearestVertices(
  ctx: QueryContext,
  query: Point3D,
  k = 1,
  opts?: NearestVerticesOptions,
): NearestVerticesResult {
  const { fd, backClosure, anchorTriangle } = ctx;
  const [qx, qy, qz] = query;
  const trace = opts?.trace;
  const nearestVertex = flatFindNearest(
    fd,
    backClosure,
    qx,
    qy,
    qz,
    opts?.startTriangle ?? anchorTriangle,
    anchorTriangle,
    trace,
  );

  const filter = opts?.filter;
  if (filter !== undefined) {
    return {
      hits: collectFiltered(ctx, nearestVertex, k, filter, qx, qy, qz, trace),
      nearestVertex,
    };
  }

  if (k <= 1) {
    return {
      hits: [
        {
          vertex: nearestVertex,
          distance: dist(fd.vertexPoints, nearestVertex * 3, qx, qy, qz),
        },
      ],
      nearestVertex,
    };
  }

  // BFS expansion on Delaunay vertex neighbors for k > 1
  const visited = new Set<number>([nearestVertex]);
  const frontier = [nearestVertex];
  let frontierHead = 0;
  const candidates: VertexHit[] = [
    {
      vertex: nearestVertex,
      distance: dist(fd.vertexPoints, nearestVertex * 3, qx, qy, qz),
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
    for (const nIdx of vertexNeighbors(fd, current, backClosure)) {
      if (visited.has(nIdx)) continue;
      visited.add(nIdx);
      if (trace) trace.bfsVertices.push(nIdx);
      candidates.push({
        vertex: nIdx,
        distance: dist(fd.vertexPoints, nIdx * 3, qx, qy, qz),
      });
      frontier.push(nIdx);
    }
  }

  candidates.sort((a, b) => a.distance - b.distance);
  return { hits: candidates.slice(0, k), nearestVertex };
}

/**
 * BFS expansion that only collects vertices accepted by `filter`.
 * Non-matching vertices (including the seed, which is the walk's nearest
 * vertex and may itself fail the filter) still join the frontier so the
 * search can expand through them to matches further out.
 */
function collectFiltered(
  ctx: QueryContext,
  seedIdx: number,
  k: number,
  filter: (vertex: number) => boolean,
  qx: number,
  qy: number,
  qz: number,
  trace?: WalkTrace,
): VertexHit[] {
  const { fd, backClosure } = ctx;
  const vp = fd.vertexPoints;
  const visited = new Set<number>([seedIdx]);
  const frontier = [seedIdx];
  let frontierHead = 0;
  const candidates: VertexHit[] = [];
  if (filter(seedIdx)) {
    candidates.push({
      vertex: seedIdx,
      distance: dist(vp, seedIdx * 3, qx, qy, qz),
    });
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
    for (const nIdx of vertexNeighbors(fd, current, backClosure)) {
      if (visited.has(nIdx)) continue;
      visited.add(nIdx);
      if (trace) trace.bfsVertices.push(nIdx);
      if (filter(nIdx)) {
        candidates.push({
          vertex: nIdx,
          distance: dist(vp, nIdx * 3, qx, qy, qz),
        });
      }
      frontier.push(nIdx);
    }
  }

  candidates.sort((a, b) => a.distance - b.distance);
  return candidates.slice(0, k);
}

// ---------- Point location ----------

/**
 * Absolute containment tolerance for point location. Side values
 * (dot(cross(a, b), p)) scale with triangle size — from ~0.5 for giant
 * open-ocean triangles down to ~1e-9 for genuine dense-cluster triangles —
 * so the epsilon must sit below every real signal but above the noise:
 * Float64 roundoff contributes ~1e-16, and querying Float32-quantized
 * needle triangles (near-duplicate vertices, the binary tile format) with
 * full-precision coordinates contributes displacement-times-tiny-normal
 * terms up to ~1e-13. 1e-12 clears both noise sources with an order of
 * magnitude to spare while staying three below the smallest genuine
 * non-containment signal.
 */
const CONTAINMENT_EPS = 1e-12;

/**
 * Angular displacement (radians) below which a rim-edge violation does not
 * prove a query lies outside the patch. A walk that stalls on the rim has
 * p on the wrong side of a hull-supporting plane — proof of
 * non-containment, but only up to how far the stored geometry sits from
 * the true one: Float32 quantization moves vertices by up to ~6e-8 rad
 * (side tests scale with the edge normal, so the violation is compared as
 * side/|normal|). Beyond 1e-7 the violation is real and the walk answers
 * null directly; within it, only the exhaustive scan can tell "just
 * outside the rim" from "on a fuzz-degenerate hull face".
 */
const RIM_PROOF_EPS_RAD = 1e-7;

/**
 * True when no side test against triangle t can ever exceed
 * CONTAINMENT_EPS: every edge normal (cross of its endpoints) is at most
 * EPS long, so |side| ≤ |normal| ≤ EPS for any unit query point. Such a
 * triangle — three coincident input points collapsed to one coordinate —
 * would test "contained" for every point on the sphere. It can decide
 * nothing, so point location skips it: a query genuinely at the collapsed
 * position is also contained (within tolerance) by a genuine triangle
 * incident to the same vertices. Kept out of the back-closure mask on
 * purpose — that mask also gates vertexNeighbors emission, and hiding a
 * coincident cluster's fan triangles would break k>1 searches there.
 */
function containmentBlind(fd: FlatDelaunay, t: number): boolean {
  const ti = t * 3;
  const vp = fd.vertexPoints;
  const epsSq = CONTAINMENT_EPS * CONTAINMENT_EPS;
  for (let e = 0; e < 3; e++) {
    const ai = fd.triangleVertices[ti + e] * 3;
    const bi = fd.triangleVertices[ti + ((e + 1) % 3)] * 3;
    const nx = vp[ai + 1] * vp[bi + 2] - vp[ai + 2] * vp[bi + 1];
    const ny = vp[ai + 2] * vp[bi] - vp[ai] * vp[bi + 2];
    const nz = vp[ai] * vp[bi + 1] - vp[ai + 1] * vp[bi];
    if (nx * nx + ny * ny + nz * nz > epsSq) return false;
  }
  return true;
}

/** A point located within a triangulation. */
export interface PointLocation {
  /** Containing triangle index. */
  triangle: number;
  /** The triangle's vertex indices, in triangleVertices order. */
  vertices: [number, number, number];
  /**
   * Spherical barycentric weights ≥ 0 summing to 1, aligned with
   * `vertices`: interpolate a per-vertex field f at p as Σ wᵢ·f(vᵢ).
   */
  weights: [number, number, number];
}

/**
 * Signed side of (qx,qy,qz) against each of triangle t's three CCW edges:
 * result[i] = dot(cross(vᵢ, vᵢ₊₁), q). All non-negative ⇔ q is contained.
 */
function triangleSides(
  fd: FlatDelaunay,
  t: number,
  qx: number,
  qy: number,
  qz: number,
): [number, number, number] {
  const ti = t * 3;
  const vp = fd.vertexPoints;
  const ai = fd.triangleVertices[ti] * 3;
  const bi = fd.triangleVertices[ti + 1] * 3;
  const ci = fd.triangleVertices[ti + 2] * 3;
  return [
    side(vp, ai, bi, qx, qy, qz),
    side(vp, bi, ci, qx, qy, qz),
    side(vp, ci, ai, qx, qy, qz),
  ];
}

/**
 * Assemble a PointLocation from a containing triangle's edge sides.
 *
 * Vertex i's raw weight is the side value of its opposite edge — the
 * spherical barycentric determinant det[q, vⱼ, vₖ]. Sides within
 * CONTAINMENT_EPS below zero (q on an edge, up to roundoff) clamp to 0 so
 * weights stay non-negative.
 *
 * A zero-area triangle (coincident input points — see tour-guide-895a for
 * the input-hygiene contract) can zero out every clamped side; all weight
 * then goes to the nearest of its three vertices — the interpolation limit
 * as a triangle collapses — so callers never see NaN. This guard remains
 * necessary even though convexHull now drops exact duplicates at build time,
 * because Float32 quantization at serialization can collapse near-duplicate
 * vertices into bit-identical ones downstream of the hull.
 */
function buildLocation(
  fd: FlatDelaunay,
  triangle: number,
  sides: [number, number, number],
  qx: number,
  qy: number,
  qz: number,
): PointLocation {
  const ti = triangle * 3;
  const vertices: [number, number, number] = [
    fd.triangleVertices[ti],
    fd.triangleVertices[ti + 1],
    fd.triangleVertices[ti + 2],
  ];
  const raw: [number, number, number] = [
    Math.max(sides[1], 0),
    Math.max(sides[2], 0),
    Math.max(sides[0], 0),
  ];
  const sum = raw[0] + raw[1] + raw[2];
  if (sum > 0) {
    return {
      triangle,
      vertices,
      weights: [raw[0] / sum, raw[1] / sum, raw[2] / sum],
    };
  }
  const weights: [number, number, number] = [0, 0, 0];
  let nearest = 0;
  let nearestD = dist(fd.vertexPoints, vertices[0] * 3, qx, qy, qz);
  for (let i = 1; i < 3; i++) {
    const d = dist(fd.vertexPoints, vertices[i] * 3, qx, qy, qz);
    if (d < nearestD) {
      nearestD = d;
      nearest = i;
    }
  }
  weights[nearest] = 1;
  return { triangle, vertices, weights };
}

/**
 * Locate the triangle containing `p` and p's spherical barycentric weights
 * within it — the primitive field interpolation needs ("blend the values at
 * the three vertices surrounding p").
 *
 * The walk is the same hardened locate machinery findNearestVertices uses
 * (back-closure masking, patience, cycle detection, anchor restart), so it
 * survives the same real-data pathologies. `startTriangle` warm-starts it:
 * threading the previous result's triangle through spatially-coherent
 * queries (scanline rendering, moving readouts) makes each locate O(1)
 * instead of O(√N) — 25× on a 1M-query render benchmark.
 *
 * Returns null when no triangle of the patch front contains p. For a patch
 * triangulation (thin-lens hull), queries beyond the patch rim have no
 * containing triangle, and back-closure facets are never returned — a
 * region covered only by the hull's underside is outside the triangulated
 * surface. Interpolating there is undefined; nearest-vertex queries remain
 * available for "closest data point anyway" semantics. On a full-sphere
 * triangulation every point is contained and null is never returned.
 *
 * Containment tolerance is absolute (CONTAINMENT_EPS): p within roundoff
 * beyond an edge — including the patch rim — counts as contained, with the
 * off-edge weight clamped to 0.
 *
 * A walk cut short by degeneracy (cycles in Float32-quantized slivers), or
 * stopped on a masked triangle by a stale warm start, falls back to the
 * exhaustive locateTriangleByScan; on healthy data the walk terminates by
 * containment or rim stall and the scan never runs.
 */
export function locateTriangle(
  ctx: QueryContext,
  p: Point3D,
  startTriangle?: number,
): PointLocation | null {
  const { fd, backClosure, anchorTriangle } = ctx;
  if (fd.triangleVertices.length === 0) return null;
  const [qx, qy, qz] = p;
  const { stopTriangle } = flatLocate(
    fd,
    backClosure,
    qx,
    qy,
    qz,
    startTriangle ?? anchorTriangle,
    anchorTriangle,
  );
  if (
    stopTriangle >= 0 &&
    backClosure[stopTriangle] === 0 &&
    !containmentBlind(fd, stopTriangle)
  ) {
    const sides = triangleSides(fd, stopTriangle, qx, qy, qz);
    if (Math.min(sides[0], sides[1], sides[2]) >= -CONTAINMENT_EPS) {
      return buildLocation(fd, stopTriangle, sides, qx, qy, qz);
    }
    // Rim stall: the walk stopped even though an edge test genuinely
    // fails, so every failing edge borders the back closure — a rim
    // (silhouette) edge. The plane through the sphere center and a rim
    // edge supports the whole hull, so p outside one by more than
    // geometry fuzz (see RIM_PROOF_EPS_RAD) proves no front triangle
    // contains p. All violations within fuzz → let the scan decide.
    const ti = stopTriangle * 3;
    const vp = fd.vertexPoints;
    for (let e = 0; e < 3; e++) {
      if (sides[e] >= -CONTAINMENT_EPS) continue;
      const ai = fd.triangleVertices[ti + e] * 3;
      const bi = fd.triangleVertices[ti + ((e + 1) % 3)] * 3;
      const nx = vp[ai + 1] * vp[bi + 2] - vp[ai + 2] * vp[bi + 1];
      const ny = vp[ai + 2] * vp[bi] - vp[ai] * vp[bi + 2];
      const nz = vp[ai] * vp[bi + 1] - vp[ai + 1] * vp[bi];
      const normal = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (sides[e] < -RIM_PROOF_EPS_RAD * normal) return null;
    }
  }
  // Walk cut short (degenerate cycle, patience, step cap), stranded on a
  // masked or containment-blind triangle, or rim-stalled within geometry
  // fuzz — only the exhaustive scan is reliable here.
  return locateTriangleByScan(ctx, p);
}

/**
 * Brute-force point location: scan every front (non-back-closure) triangle
 * and pick the one maximizing min(edge sides). Same contract as
 * locateTriangle — same weights, same null-beyond-the-rim semantics — at
 * O(triangles) per query. Exported as the oracle for consumers testing
 * warm-started walks against ground truth; also the internal fallback when
 * a walk is cut short.
 */
export function locateTriangleByScan(
  ctx: QueryContext,
  p: Point3D,
): PointLocation | null {
  const { fd, backClosure } = ctx;
  const [qx, qy, qz] = p;
  const T = fd.triangleVertices.length / 3;
  let bestTriangle = -1;
  let bestSides: [number, number, number] = [0, 0, 0];
  let bestMin = -Infinity;
  for (let t = 0; t < T; t++) {
    if (backClosure[t] === 1) continue;
    const sides = triangleSides(fd, t, qx, qy, qz);
    const min = Math.min(sides[0], sides[1], sides[2]);
    // Blindness checked only for would-be winners: near-universal misses
    // keep the scan at three side tests per triangle.
    if (min > bestMin && !containmentBlind(fd, t)) {
      bestMin = min;
      bestTriangle = t;
      bestSides = sides;
    }
  }
  if (bestTriangle < 0 || bestMin < -CONTAINMENT_EPS) return null;
  return buildLocation(fd, bestTriangle, bestSides, qx, qy, qz);
}
