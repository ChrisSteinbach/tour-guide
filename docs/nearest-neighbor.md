# Spherical Nearest-Neighbor Search

This document explains the theory behind WikiRadar's nearest-neighbor algorithm and how it maps to the actual implementation. The core insight is that spherical Delaunay triangulation can be computed as a 3D convex hull, and nearest-neighbor queries reduce to triangle walks on the resulting mesh.

## Key idea: Convex hull = Spherical Delaunay

For points on a unit sphere, the faces of their 3D convex hull are exactly the triangles of the spherical Delaunay triangulation (Brown, 1979). This means we can use a standard incremental convex hull algorithm to build the triangulation, then walk the resulting mesh to answer nearest-neighbor queries.

The Delaunay property guarantees that each point's nearest neighbor is one of its Delaunay-adjacent vertices (average degree approximately 6 by Euler's formula, specifically 6 − 12/V). This makes greedy walks on the triangulation graph correct for nearest-neighbor search.

## Algorithm (as implemented)

### Build phase (pipeline)

`convexHull()` in `src/geometry/convex-hull.ts` builds the triangulation via incremental insertion:

1. **Perturbation** — All points receive ~1e-6 deterministic perturbation (seeded LCG PRNG) to avoid degenerate coplanar configurations. Perturbed copies are used for `orient3D` tests only; original coordinates are stored in the output.

2. **Seed tetrahedron** — Four non-coplanar points form the initial hull.

3. **Incremental insertion** — For each new point:
   - Find a visible face via greedy walk from the previous insertion point
   - BFS to discover all connected visible faces (the "cavity")
   - Collect horizon edges (boundary between visible and non-visible faces)
   - Delete visible faces, create new faces connecting horizon to the new point
   - Relink adjacency via a half-edge map (edge `a→b` encoded as `a × N + b`)

4. **Fallback strategies** — If the greedy walk fails to find a visible face: FaceGrid spatial index lookup → local BFS from walk endpoint → linear scan (rare, typically <1% of points).

5. **Post-processing** (`buildTriangulation()` in `src/geometry/delaunay.ts`) — Computes circumcenters, builds vertex-to-triangle mapping, drops interior points, remaps indices.

The core geometric predicate is `orient3D(a, b, c, d)` — the sign of the 4×4 determinant giving the signed volume of tetrahedron `abcd`. This uses Shewchuk's robust exact arithmetic (vendored via mourner's `robust-predicates` port in `src/geometry/vendor/`). Positive means `d` is visible from face `(a, b, c)`.

**Complexity:** O(N log N) expected for the randomized incremental hull; O(N²) worst case (degenerate insertion orders). FaceGrid provides O(1) amortized face lookup. The implementation uses multiple fallback strategies (greedy walk → FaceGrid lookup → BFS → linear scan) to handle the pathological cases gracefully.

### Query phase (app runtime)

The app uses flat typed-array versions of the same algorithms to avoid GC pressure. Both `src/geometry/point-location.ts` (pipeline/tests) and `src/app/query.ts` (runtime) implement the same logic.

**Step 1: Triangle walk** (`flatLocate` in `query.ts`, `locateTriangle` in `point-location.ts`)

Starting from a hint triangle (or the default), test which edge of the current triangle the query point lies outside of. Cross to the neighbor sharing that edge. Repeat until the query is inside all three edges.

The edge test uses the sign of `dot(cross(a, b), q)` — the scalar triple product — to determine which side of the great circle through `a` and `b` the query `q` lies on.

**Expected steps:** O(√N) for uniformly distributed points.

**Step 2: Greedy vertex walk** (`flatFindNearest` in `query.ts`, `findNearest` in `point-location.ts`)

Starting from the closest vertex of the containing triangle, check all Delaunay neighbors. Move to any closer one. Repeat until no improvement. The Delaunay property guarantees this converges to the true nearest vertex.

Neighbors are enumerated by walking the triangle fan around a vertex (`flatNeighbors` / `vertexNeighbors`).

**Step 3: BFS expansion** (k > 1, `NearestQuery.findNearest` in `query.ts`)

For k-nearest queries, expand from the nearest vertex through Delaunay edges via BFS, collecting `max(2k, k+6)` candidates. Sort by distance, return top k. The oversampling margin (`k+6` for small k, `2k` for large k) ensures at least one full neighbor ring beyond the nearest vertex.

## Distance computation

The pipeline's geometry library (`src/geometry/index.ts`) uses `acos(dot(a, b))` for spherical distance, which is fine for Float64 pipeline math.

The app's runtime query module (`src/app/query.ts`) uses **chord distance** instead: `2 * asin(||v - q|| / 2)` (with clamping guards for numerical safety). This avoids catastrophic cancellation when vertex coordinates originate from Float32 storage (the binary format). For nearby points, the dot product is approximately 1 and `(1 - dot)` falls below Float32 rounding error, causing `acos` to collapse to 0. Chord distance computes differences instead, which stay above the noise floor.

Both are monotonically related to great-circle distance, so they produce the same nearest-neighbor ordering.

## Why this approach

The project chose the convex-hull-to-Delaunay approach with triangle walks over alternatives:

- **KD-trees:** O(log N) queries but no adjacency structure for k-nearest BFS expansion. Also requires balancing and doesn't naturally decompose into tiles.
- **Hierarchical point location (Kirkpatrick):** O(log N) queries with O(N) storage, but complex to implement and doesn't benefit from warm-start hints across consecutive queries.
- **Triangle walks:** O(√N) expected but simple to implement, naturally support warm-starting from the previous query result (consecutive GPS positions are nearby), and the Delaunay adjacency structure directly supports k-nearest via BFS.

With tiling (N ≈ 1,500 per tile), the walk takes ~39 steps — fast enough that the O(√N) vs O(log N) distinction is irrelevant in practice.

## References

- Brown, K.Q. (1979). "Voronoi diagrams from convex hulls." _Information Processing Letters_, 9(5), 223-228.
- Shewchuk, J.R. (1997). "Adaptive Precision Floating-Point Arithmetic and Fast Robust Geometric Predicates." _Discrete & Computational Geometry_, 18, 305-363.
