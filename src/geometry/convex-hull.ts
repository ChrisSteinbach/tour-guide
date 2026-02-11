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

// ---------- Half-edge map ----------

type HalfEdgeInfo = { faceIdx: number; edgePos: number };

function edgeKey(a: number, b: number): string {
  return `${a}:${b}`;
}

function registerFaceEdges(
  faces: (HullFace | null)[],
  halfEdges: Map<string, HalfEdgeInfo>,
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
  halfEdges: Map<string, HalfEdgeInfo>,
  fi: number,
) {
  const f = faces[fi]!;
  for (let e = 0; e < 3; e++) {
    const a = f.vertices[e];
    const b = f.vertices[(e + 1) % 3];
    halfEdges.delete(edgeKey(a, b));
  }
}

// ---------- Randomized insertion order ----------

/**
 * Fisher-Yates shuffle of indices 0..n-1, excluding a given set.
 * Uses a fixed-seed LCG for deterministic ordering.
 */
function shuffleIndices(n: number, exclude: Set<number>): number[] {
  const arr: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!exclude.has(i)) arr.push(i);
  }

  // LCG: state = state * 1664525 + 1013904223 (mod 2^32)
  let state = 0x9e3779b9 | 0;
  for (let i = arr.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    const j = ((state >>> 0) % (i + 1)) | 0;
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }

  return arr;
}

// ---------- Seed walk + BFS ----------

/**
 * Greedy walk from a hint face toward a face visible from point p.
 * Returns the face index of a visible face, or -1 if the walk fails.
 */
function findSeedFace(
  points: Point3D[],
  faces: (HullFace | null)[],
  p: Point3D,
  hintFace: number,
): number {
  // Find a live starting face (hint may have been deleted)
  let current = -1;
  for (let i = hintFace; i < faces.length; i++) {
    if (faces[i]) {
      current = i;
      break;
    }
  }
  if (current === -1) {
    for (let i = 0; i < hintFace; i++) {
      if (faces[i]) {
        current = i;
        break;
      }
    }
  }
  if (current === -1) return -1;

  const maxSteps = 6 * Math.ceil(Math.sqrt(faces.length));

  for (let step = 0; step < maxSteps; step++) {
    const f = faces[current]!;
    const [va, vb, vc] = f.vertices;
    const vol = orient3D(points[va], points[vb], points[vc], p);
    if (vol > 0) return current; // Found a visible face

    // Step to the neighbor with the highest orient3D value (least negative)
    let bestVol = -Infinity;
    let bestNeighbor = -1;
    for (let e = 0; e < 3; e++) {
      const ni = f.neighbor[e];
      if (ni < 0 || !faces[ni]) continue;
      const nf = faces[ni]!;
      const [na, nb, nc] = nf.vertices;
      const nv = orient3D(points[na], points[nb], points[nc], p);
      if (nv > 0) return ni; // Short-circuit: neighbor is visible
      if (nv > bestVol) {
        bestVol = nv;
        bestNeighbor = ni;
      }
    }

    if (bestNeighbor === -1 || bestNeighbor === current) break;
    current = bestNeighbor;
  }

  return -1; // Walk failed, caller should fall back to linear scan
}

/**
 * BFS from a seed visible face to find all connected visible faces.
 * Visible faces on a convex hull form a connected region.
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
 */
export function convexHull(points: Point3D[]): ConvexHull {
  const [i0, i1, i2, i3] = findInitialTetrahedron(points);
  const seedSet = new Set([i0, i1, i2, i3]);

  // Orient so that orient3D(v0,v1,v2,v3) < 0, meaning v3 is below face (v0,v1,v2).
  // This makes (v0,v1,v2) face outward (normal points away from v3).
  let v0 = i0,
    v1 = i1,
    v2 = i2,
    v3 = i3;
  if (orient3D(points[v0], points[v1], points[v2], points[v3]) > 0) {
    const tmp = v1;
    v1 = v2;
    v2 = tmp;
  }

  // 4 faces of the initial tetrahedron (all CCW from outside).
  // Each face's opposite vertex is on the interior side (orient3D < 0).
  const faces: (HullFace | null)[] = [
    { vertices: [v0, v1, v2], neighbor: [-1, -1, -1] }, // opposite v3
    { vertices: [v0, v2, v3], neighbor: [-1, -1, -1] }, // opposite v1
    { vertices: [v0, v3, v1], neighbor: [-1, -1, -1] }, // opposite v2
    { vertices: [v1, v3, v2], neighbor: [-1, -1, -1] }, // opposite v0 (note: reversed from v1,v2,v3)
  ];

  // Half-edge map: directed edge "a:b" → { faceIdx, edgePos }
  const halfEdges = new Map<string, HalfEdgeInfo>();

  // Register initial faces and link adjacency via half-edge twins
  for (let fi = 0; fi < 4; fi++) registerFaceEdges(faces, halfEdges, fi);
  linkAllAdjacency(faces, halfEdges);

  // Insert remaining points in shuffled order for O(n log n) expected time
  const insertionOrder = shuffleIndices(points.length, seedSet);
  let hintFace = 0;
  for (const pi of insertionOrder) {
    hintFace = addPoint(points, faces, halfEdges, pi, hintFace);
  }

  // Compact: remove deleted slots
  return compact(points, faces);
}

/**
 * Link adjacency for all faces using the half-edge map.
 */
function linkAllAdjacency(
  faces: (HullFace | null)[],
  halfEdges: Map<string, HalfEdgeInfo>,
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
 * Returns a face index hint for the next insertion (one of the newly created faces),
 * or the original hintFace if the point was inside the hull.
 */
function addPoint(
  points: Point3D[],
  faces: (HullFace | null)[],
  halfEdges: Map<string, HalfEdgeInfo>,
  pi: number,
  hintFace: number,
): number {
  const p = points[pi];

  // Find all visible faces via seed walk + BFS
  let visible: number[];
  const seed = findSeedFace(points, faces, p, hintFace);
  if (seed >= 0) {
    visible = bfsVisibleFaces(points, faces, p, seed);
  } else {
    // Fallback: linear scan (should be rare)
    visible = [];
    for (let fi = 0; fi < faces.length; fi++) {
      const f = faces[fi];
      if (!f) continue;
      const [va, vb, vc] = f.vertices;
      if (orient3D(points[va], points[vb], points[vc], p) > 0) {
        visible.push(fi);
      }
    }
  }

  if (visible.length === 0) return hintFace; // Point inside hull

  const visibleSet = new Set(visible);

  // Collect horizon edges: edges of visible faces whose twin face is not visible.
  // The horizon edge from the new triangle's perspective is reversed (b→a).
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

  return newFaceIndices[0];
}

/**
 * Remove deleted (null) face slots and remap neighbor indices.
 */
function compact(
  points: Point3D[],
  faces: (HullFace | null)[],
): ConvexHull {
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
