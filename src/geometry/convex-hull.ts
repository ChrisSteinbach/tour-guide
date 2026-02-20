// Incremental 3D convex hull algorithm
// For unit-sphere points, the convex hull faces are the spherical Delaunay triangulation

import type { Point3D } from "./index";

// ---------- Types ----------

export interface HullFace {
  /** Indices into input points, CCW from outside */
  vertices: [number, number, number];
  /** neighbor[i] shares edge vertices[i] → vertices[(i+1)%3] */
  neighbor: [number, number, number];
}

export interface ConvexHull {
  points: Point3D[];
  faces: HullFace[];
}

// ---------- Predicates ----------

/**
 * Signed volume of tetrahedron (a, b, c, d).
 * Positive when d is above the plane of (a, b, c), where "above" is the side
 * the normal (b-a)×(c-a) points toward.
 *
 * For the convex hull: a point p is visible from outward-facing face (v0,v1,v2)
 * when orient3D(v0, v1, v2, p) > 0.
 */
export function orient3D(
  a: Point3D,
  b: Point3D,
  c: Point3D,
  d: Point3D,
): number {
  const abx = b[0] - a[0],
    aby = b[1] - a[1],
    abz = b[2] - a[2];
  const acx = c[0] - a[0],
    acy = c[1] - a[1],
    acz = c[2] - a[2];
  const adx = d[0] - a[0],
    ady = d[1] - a[1],
    adz = d[2] - a[2];

  return (
    abx * (acy * adz - acz * ady) -
    aby * (acx * adz - acz * adx) +
    abz * (acx * ady - acy * adx)
  );
}

// ---------- Half-edge map (numeric keys for performance) ----------

type HalfEdgeInfo = { faceIdx: number; edgePos: number };

// Encode directed edge (a→b) as a single number: a * N + b
// N must be > max vertex index. Set once per convexHull call.
let _edgeMul = 0;

function edgeKey(a: number, b: number): number {
  return a * _edgeMul + b;
}

function registerFaceEdges(
  faces: (HullFace | null)[],
  halfEdges: Map<number, HalfEdgeInfo>,
  fi: number,
) {
  const f = faces[fi]!;
  for (let e = 0; e < 3; e++) {
    const a = f.vertices[e];
    const b = f.vertices[(e + 1) % 3];
    halfEdges.set(edgeKey(a, b), { faceIdx: fi, edgePos: e });
  }
}

function removeFaceEdges(
  faces: (HullFace | null)[],
  halfEdges: Map<number, HalfEdgeInfo>,
  fi: number,
) {
  const f = faces[fi]!;
  for (let e = 0; e < 3; e++) {
    const a = f.vertices[e];
    const b = f.vertices[(e + 1) % 3];
    halfEdges.delete(edgeKey(a, b));
  }
}

// ---------- Point perturbation ----------

/**
 * Add a small deterministic random perturbation to each point to prevent
 * degenerate configurations (coplanar/cospherical points) that cause
 * orient3D to return ambiguous near-zero results.
 *
 * The perturbation is ~1e-6 per coordinate (≈0.1m on Earth's surface),
 * which is negligible for navigation but ensures orient3D values are
 * well above the ~1e-15 floating-point error bound.
 *
 * Only the perturbed copy is used for orient3D tests; the original
 * unperturbed points are stored in the output hull.
 */
function perturbPoints(points: Point3D[]): Point3D[] {
  const SCALE = 1e-6;
  let state = 0x9e3779b9 | 0;
  function nextRand(): number {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    return ((state >>> 0) / 0x100000000 - 0.5) * SCALE;
  }

  return points.map((p) => {
    const px = p[0] + nextRand();
    const py = p[1] + nextRand();
    const pz = p[2] + nextRand();
    // Project back onto unit sphere so no point can be interior to the hull
    const len = Math.sqrt(px * px + py * py + pz * pz);
    return [px / len, py / len, pz / len] as Point3D;
  });
}

// ---------- Spatial face index ----------

/**
 * A simple grid index on (x, y, z) that maps spatial cells to face indices.
 * Used to quickly find a face near a query point, eliminating expensive
 * linear scans when the greedy walk fails.
 */
class FaceGrid {
  private grid: Int32Array; // face index per cell, -1 = empty
  private res: number;

  constructor(resolution: number) {
    this.res = resolution;
    this.grid = new Int32Array(resolution * resolution * resolution).fill(-1);
  }

  private cellCoords(p: Point3D): [number, number, number] {
    const r = this.res;
    return [
      Math.min(r - 1, Math.max(0, ((p[0] + 1) * 0.5 * r) | 0)),
      Math.min(r - 1, Math.max(0, ((p[1] + 1) * 0.5 * r) | 0)),
      Math.min(r - 1, Math.max(0, ((p[2] + 1) * 0.5 * r) | 0)),
    ];
  }

  private coordsToIndex(ix: number, iy: number, iz: number): number {
    return ix * this.res * this.res + iy * this.res + iz;
  }

  /** Register a face at its centroid's cell. */
  update(points: Point3D[], faces: (HullFace | null)[], fi: number) {
    const f = faces[fi]!;
    const [a, b, c] = f.vertices;
    const centroid: Point3D = [
      (points[a][0] + points[b][0] + points[c][0]) / 3,
      (points[a][1] + points[b][1] + points[c][1]) / 3,
      (points[a][2] + points[b][2] + points[c][2]) / 3,
    ];
    const [cx, cy, cz] = this.cellCoords(centroid);
    this.grid[this.coordsToIndex(cx, cy, cz)] = fi;
  }

  /** Find a face near point p. Returns face index or -1. */
  lookup(p: Point3D): number {
    const [cx, cy, cz] = this.cellCoords(p);
    return this.grid[this.coordsToIndex(cx, cy, cz)];
  }
}

// ---------- Seed walk + BFS ----------

/**
 * Greedy walk from a hint face toward a face visible from point p.
 * Uses dot product with face centroids to navigate toward p.
 *
 * Returns [seedFace, endFace]:
 * - seedFace >= 0: found a visible face (use as BFS seed)
 * - seedFace === -1: walk failed, endFace is the last face visited (near p)
 */
function findSeedFace(
  points: Point3D[],
  faces: (HullFace | null)[],
  p: Point3D,
  hintFace: number,
  liveFaceCount: number,
): [number, number] {
  // Find a live starting face (hint may have been deleted)
  let current = -1;
  if (hintFace >= 0 && hintFace < faces.length && faces[hintFace]) {
    current = hintFace;
  } else {
    for (let i = 0; i < faces.length; i++) {
      if (faces[i]) {
        current = i;
        break;
      }
    }
  }
  if (current === -1) return [-1, -1];

  const maxSteps = 6 * Math.ceil(Math.sqrt(liveFaceCount));
  const px = p[0],
    py = p[1],
    pz = p[2];
  let prev = -1,
    prevPrev = -1;

  for (let step = 0; step < maxSteps; step++) {
    const f = faces[current]!;
    const [va, vb, vc] = f.vertices;
    if (orient3D(points[va], points[vb], points[vc], p) > 0) {
      return [current, current];
    }

    let bestDot = -Infinity;
    let bestNeighbor = -1;
    for (let e = 0; e < 3; e++) {
      const ni = f.neighbor[e];
      if (ni < 0 || ni === prev || ni === prevPrev || !faces[ni]) continue;
      const nf = faces[ni];
      const [na, nb, nc] = nf.vertices;
      if (orient3D(points[na], points[nb], points[nc], p) > 0) {
        return [ni, ni];
      }
      const d =
        (points[na][0] + points[nb][0] + points[nc][0]) * px +
        (points[na][1] + points[nb][1] + points[nc][1]) * py +
        (points[na][2] + points[nb][2] + points[nc][2]) * pz;
      if (d > bestDot) {
        bestDot = d;
        bestNeighbor = ni;
      }
    }

    if (bestNeighbor === -1) return [-1, current];
    prevPrev = prev;
    prev = current;
    current = bestNeighbor;
  }

  return [-1, current];
}

/**
 * BFS from a seed visible face to find all connected visible faces.
 * Visible faces on a convex hull form a connected region (guaranteed by
 * perturbation eliminating degenerate coplanarity).
 */
function bfsVisibleFaces(
  points: Point3D[],
  faces: (HullFace | null)[],
  p: Point3D,
  seed: number,
): number[] {
  const visible = [seed];
  const visited = new Set([seed]);

  for (let head = 0; head < visible.length; head++) {
    const f = faces[visible[head]]!;
    for (let e = 0; e < 3; e++) {
      const ni = f.neighbor[e];
      if (ni < 0 || visited.has(ni)) continue;
      visited.add(ni);
      const nf = faces[ni]!;
      const [na, nb, nc] = nf.vertices;
      if (orient3D(points[na], points[nb], points[nc], p) > 0) {
        visible.push(ni);
      }
    }
  }

  return visible;
}

// ---------- Algorithm ----------

/**
 * Find 4 non-coplanar points to seed the hull.
 * Returns their indices, or throws if the points are degenerate.
 */
function findInitialTetrahedron(
  points: Point3D[],
): [number, number, number, number] {
  const n = points.length;
  if (n < 4) throw new Error("Need at least 4 points for a convex hull");

  // First two distinct points
  let i1 = -1;
  for (let i = 1; i < n; i++) {
    const dx = points[i][0] - points[0][0];
    const dy = points[i][1] - points[0][1];
    const dz = points[i][2] - points[0][2];
    if (dx * dx + dy * dy + dz * dz > 1e-20) {
      i1 = i;
      break;
    }
  }
  if (i1 < 0) throw new Error("All points are coincident");

  // Third point not collinear with first two
  let i2 = -1;
  const a = points[0],
    b = points[i1];
  for (let i = i1 + 1; i < n; i++) {
    const c = points[i];
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2];
    const vx = c[0] - a[0],
      vy = c[1] - a[1],
      vz = c[2] - a[2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz > 1e-20) {
      i2 = i;
      break;
    }
  }
  if (i2 < 0) throw new Error("All points are collinear");

  // Fourth point not coplanar with first three
  let i3 = -1;
  for (let i = 1; i < n; i++) {
    if (i === i1 || i === i2) continue;
    const vol = orient3D(points[0], points[i1], points[i2], points[i]);
    if (Math.abs(vol) > 1e-20) {
      i3 = i;
      break;
    }
  }
  if (i3 < 0) throw new Error("All points are coplanar");

  return [0, i1, i2, i3];
}

/**
 * Compute the 3D convex hull of a set of points using the incremental algorithm.
 *
 * For unit-sphere points, the hull faces are the spherical Delaunay triangulation.
 * Face vertices are wound CCW when viewed from outside (normals point outward).
 *
 * Uses point perturbation to handle degenerate inputs, a spatial grid index for
 * O(1) face lookup, and BFS for visible face discovery.
 */
export function convexHull(points: Point3D[]): ConvexHull {
  // Validate on original points (clear error messages for degenerate input)
  const [i0, i1, i2, i3] = findInitialTetrahedron(points);

  // Set up numeric edge key multiplier
  _edgeMul = points.length;

  // Perturbed copy for orient3D tests; original points stored in output
  const pp = perturbPoints(points);

  const seedSet = new Set([i0, i1, i2, i3]);

  // Orient so that orient3D(v0,v1,v2,v3) < 0, meaning v3 is below face (v0,v1,v2).
  // This makes (v0,v1,v2) face outward (normal points away from v3).
  const v0 = i0;
  let v1 = i1,
    v2 = i2;
  const v3 = i3;
  if (orient3D(pp[v0], pp[v1], pp[v2], pp[v3]) > 0) {
    const tmp = v1;
    v1 = v2;
    v2 = tmp;
  }

  // 4 faces of the initial tetrahedron (all CCW from outside).
  const faces: (HullFace | null)[] = [
    { vertices: [v0, v1, v2], neighbor: [-1, -1, -1] },
    { vertices: [v0, v2, v3], neighbor: [-1, -1, -1] },
    { vertices: [v0, v3, v1], neighbor: [-1, -1, -1] },
    { vertices: [v1, v3, v2], neighbor: [-1, -1, -1] },
  ];

  // Half-edge map: directed edge key → { faceIdx, edgePos }
  const halfEdges = new Map<number, HalfEdgeInfo>();

  // Register initial faces and link adjacency via half-edge twins
  for (let fi = 0; fi < 4; fi++) registerFaceEdges(faces, halfEdges, fi);
  linkAllAdjacency(faces, halfEdges);

  // Spatial grid index for fast face lookup (resolution scales with √n)
  const gridRes = Math.max(
    8,
    Math.min(128, Math.ceil(Math.pow(points.length, 1 / 3))),
  );
  const faceGrid = new FaceGrid(gridRes);
  for (let fi = 0; fi < 4; fi++) faceGrid.update(pp, faces, fi);

  // Insert remaining points
  let hintFace = 0;
  let liveFaces = 4;
  for (let pi = 0; pi < points.length; pi++) {
    if (seedSet.has(pi)) continue;
    const result = addPoint(
      pp,
      faces,
      halfEdges,
      pi,
      hintFace,
      liveFaces,
      faceGrid,
    );
    hintFace = result[0];
    liveFaces += result[1];
  }

  // Compact: remove deleted slots. Return original (unperturbed) points.
  return compact(points, faces);
}

/**
 * Link adjacency for all faces using the half-edge map.
 */
function linkAllAdjacency(
  faces: (HullFace | null)[],
  halfEdges: Map<number, HalfEdgeInfo>,
) {
  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi];
    if (!f) continue;
    for (let e = 0; e < 3; e++) {
      const a = f.vertices[e];
      const b = f.vertices[(e + 1) % 3];
      const twin = halfEdges.get(edgeKey(b, a));
      if (twin) {
        f.neighbor[e] = twin.faceIdx;
      }
    }
  }
}

/**
 * Insert a single point into the hull. If the point is inside (no visible faces),
 * it's silently skipped.
 *
 * Returns [hintFace, faceDelta] where faceDelta is the change in live face count.
 */
function addPoint(
  points: Point3D[],
  faces: (HullFace | null)[],
  halfEdges: Map<number, HalfEdgeInfo>,
  pi: number,
  hintFace: number,
  liveFaces: number,
  faceGrid: FaceGrid,
): [number, number] {
  const p = points[pi];

  // Try to find a visible face:
  // 1. Walk from the previous insertion's hint face
  // 2. Grid cell lookup → walk
  // 3. Local BFS from walk endpoint (catches nearby visible faces or confirms interior)
  // 4. Strided scan (O(√n) last resort)
  let walkResult = findSeedFace(points, faces, p, hintFace, liveFaces);
  let seed = walkResult[0];
  let walkEnd = walkResult[1];

  if (seed < 0) {
    // Try grid hint
    const gridHint = faceGrid.lookup(p);
    if (gridHint >= 0 && faces[gridHint]) {
      walkResult = findSeedFace(points, faces, p, gridHint, liveFaces);
      seed = walkResult[0];
      if (walkResult[1] >= 0) walkEnd = walkResult[1];
    }
  }

  if (seed < 0 && walkEnd >= 0) {
    // Local BFS from the walk endpoint: check nearby faces for visibility.
    // The walk endpoint is the face closest to p by dot product. If p is on
    // the hull, visible faces are within a few hops. If p is interior, no
    // nearby faces are visible.
    const bfsLimit = Math.min(
      liveFaces,
      Math.max(500, Math.ceil(4 * Math.sqrt(liveFaces))),
    );
    const visited = new Set([walkEnd]);
    const queue = [walkEnd];
    for (let head = 0; head < queue.length && visited.size < bfsLimit; head++) {
      const cf = faces[queue[head]]!;
      const [va, vb, vc] = cf.vertices;
      if (orient3D(points[va], points[vb], points[vc], p) > 0) {
        seed = queue[head];
        break;
      }
      for (let e = 0; e < 3; e++) {
        const ni = cf.neighbor[e];
        if (ni >= 0 && !visited.has(ni) && faces[ni]) {
          visited.add(ni);
          queue.push(ni);
        }
      }
    }
  }

  if (seed < 0) {
    // Full linear scan: check every face. O(n) but only triggers for the
    // rare points (~0.06%) where walk, grid, and BFS all fail to find the
    // visible face — typically tiny triangles between very close points.
    for (let fi = 0; fi < faces.length; fi++) {
      const f = faces[fi];
      if (!f) continue;
      const [va, vb, vc] = f.vertices;
      if (orient3D(points[va], points[vb], points[vc], p) > 0) {
        seed = fi;
        break;
      }
    }
  }

  if (seed < 0) return [hintFace, 0]; // Interior point — no visible faces

  const visible = bfsVisibleFaces(points, faces, p, seed);
  if (visible.length === 0) return [hintFace, 0]; // Point inside hull

  const visibleSet = new Set(visible);

  // Collect horizon edges: edges of visible faces whose twin face is not visible.
  const horizon: {
    a: number;
    b: number;
    neighborFace: number;
  }[] = [];

  for (const fi of visible) {
    const f = faces[fi]!;
    for (let e = 0; e < 3; e++) {
      const ni = f.neighbor[e];
      if (!visibleSet.has(ni)) {
        const ea = f.vertices[e];
        const eb = f.vertices[(e + 1) % 3];
        horizon.push({ a: ea, b: eb, neighborFace: ni });
      }
    }
  }

  // Delete visible faces
  for (const fi of visible) {
    removeFaceEdges(faces, halfEdges, fi);
    faces[fi] = null;
  }

  // Create new faces from horizon edges to the new point
  const newFaceIndices: number[] = [];
  for (const h of horizon) {
    const newFi = faces.length;
    const newFace: HullFace = {
      vertices: [h.a, h.b, pi],
      neighbor: [-1, -1, -1],
    };

    // Edge 0 (h.a → h.b) is shared with the non-visible neighbor
    const neighborFace = faces[h.neighborFace]!;
    for (let ne = 0; ne < 3; ne++) {
      const na = neighborFace.vertices[ne];
      const nb = neighborFace.vertices[(ne + 1) % 3];
      if (na === h.b && nb === h.a) {
        newFace.neighbor[0] = h.neighborFace;
        neighborFace.neighbor[ne] = newFi;
        break;
      }
    }

    faces.push(newFace);
    newFaceIndices.push(newFi);
    registerFaceEdges(faces, halfEdges, newFi);
  }

  // Link new faces to each other via half-edge twin lookup (edges 1 and 2)
  for (const fi of newFaceIndices) {
    const f = faces[fi]!;
    for (let e = 1; e < 3; e++) {
      const ea = f.vertices[e];
      const eb = f.vertices[(e + 1) % 3];
      const twin = halfEdges.get(edgeKey(eb, ea));
      if (twin) {
        f.neighbor[e] = twin.faceIdx;
        const tf = faces[twin.faceIdx]!;
        tf.neighbor[twin.edgePos] = fi;
      }
    }
  }

  // Update spatial grid with new faces
  for (const fi of newFaceIndices) {
    faceGrid.update(points, faces, fi);
  }

  return [newFaceIndices[0], horizon.length - visible.length];
}

/**
 * Remove deleted (null) face slots and remap neighbor indices.
 */
function compact(points: Point3D[], faces: (HullFace | null)[]): ConvexHull {
  const liveFaces: HullFace[] = [];
  const remap = new Map<number, number>();

  for (let i = 0; i < faces.length; i++) {
    if (faces[i]) {
      remap.set(i, liveFaces.length);
      liveFaces.push(faces[i]!);
    }
  }

  for (const f of liveFaces) {
    f.neighbor = [
      remap.get(f.neighbor[0]) ?? -1,
      remap.get(f.neighbor[1]) ?? -1,
      remap.get(f.neighbor[2]) ?? -1,
    ];
  }

  return { points, faces: liveFaces };
}
