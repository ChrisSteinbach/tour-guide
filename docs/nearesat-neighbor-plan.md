# Plan for Spherical Voronoi Nearest Neighbor Search

Understood - this is about the journey, not just the destination. Let's build the spherical Voronoi/Delaunay structure from first principles.

## Learning-Focused Implementation Plan

### Phase 1: Geometric Foundations

**Goal:** Get comfortable with spherical geometry primitives before tackling the full structure.

```
1. Point representation
   - Lat/lon ↔ Cartesian (x,y,z) on unit sphere
   - Verify: points satisfy x² + y² + z² = 1

2. Great circle fundamentals
   - Two points define a great circle (via cross product → plane normal)
   - "Which side of a great circle is point P?" (sign of dot product with normal)
   
3. Spherical distance
   - Via dot product: cos(θ) = a·b for unit vectors
   - Via haversine (for numerical stability at small distances)

4. Circumcenter on sphere
   - Given 3 points, find the point equidistant to all three
   - This becomes a Voronoi vertex
```

### Phase 2: Convex Hull → Delaunay Connection

**Goal:** Understand and implement the key insight that makes this tractable.

The document mentions: *"the combinatorial structure of the spherical Voronoi diagram is identical to the structure of the convex hull of the points in 3D"*

```
1. Implement 3D convex hull (incremental algorithm)
   - Start with tetrahedron from 4 non-coplanar points
   - For each new point: find visible faces, remove them, re-stitch
   
2. Extract Delaunay triangulation
   - Each convex hull face → one Delaunay triangle on sphere
   - Face vertices → triangle vertices
   - Face adjacency → triangle adjacency (this is your navigation structure)

3. Verify understanding
   - For a small point set (6-10 points), visualize both the 3D hull 
     and the resulting spherical triangulation
```

### Phase 3: Spherical Delaunay Triangulation

**Goal:** Build the core data structure with full adjacency information.

```
Data structure for each triangle:
  - 3 vertex indices
  - 3 neighbor triangle indices (across each edge)
  - Circumcenter (point on sphere) - precompute for Voronoi
  - Circumradius (angular) - for point location tests

Data structure for each vertex:
  - Position (x, y, z)
  - One incident triangle (entry point for walking)
  - Associated data (Wikipedia article info)
```

### Phase 4: Point Location via Triangle Walk

**Goal:** Given a query point, find which Delaunay triangle contains it.

```
Algorithm:
1. Start at some triangle T (cached from last query, or arbitrary)
2. For each edge of T:
   - Is query point on the "outside" of this edge?
   - If yes, move to neighbor triangle across that edge
3. Repeat until query is inside current triangle
4. Return the closest vertex of that triangle

Key geometric test:
  - "Which side of great-circle arc AB is point P?"
  - Compute normal N = A × B
  - Sign of P·N tells you the side
```

### Phase 5: From Delaunay to Voronoi (Conceptual)

**Goal:** Understand the dual structure, even if we don't fully build it.

```
The Voronoi diagram is the dual:
  - Each Delaunay triangle → Voronoi vertex (the circumcenter)
  - Each Delaunay edge → Voronoi edge (connecting two circumcenters)
  - Each Delaunay vertex → Voronoi cell (polygon around the site)

For nearest-neighbor queries, we don't strictly need the Voronoi cells
explicitly - the triangle walk on Delaunay suffices. But understanding
the duality completes the picture.
```

### Phase 6: Integration & Query Interface

**Goal:** Wire it up for the tour guide use case.

```
1. Load Wikipedia coordinates
2. Build Delaunay triangulation (via convex hull)
3. Query interface:
   find_nearest(lat, lon) → article_info
   
4. Optimization: cache last query's triangle as starting point
   (exploits spatial locality - user moves gradually)
```

## Suggested Build Order

| Step | Deliverable | Validates |
|------|-------------|-----------|
| 1 | Coordinate conversion functions | Basic spherical math |
| 2 | "Which side of great circle" test | Core geometric predicate |
| 3 | Convex hull of points in 3D | Algorithm implementation |
| 4 | Extract triangulation from hull | The key theoretical insight |
| 5 | Triangle walk point location | Query algorithm |
| 6 | End-to-end nearest neighbor | Full system |

## Visualization Checkpoints

I'd suggest building small visualizations at key stages - they're invaluable for debugging and building intuition:

1. **After Phase 1:** Plot points on a sphere, draw great circle arcs
2. **After Phase 2:** Show 3D convex hull alongside spherical triangulation
3. **After Phase 4:** Animate the triangle walk for a query

Want me to start with Phase 1 - the geometric primitives? I can build these as a React artifact so you can interact with the math visually as we go.
