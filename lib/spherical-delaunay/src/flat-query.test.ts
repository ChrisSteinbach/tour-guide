import {
  toCartesian,
  normalize,
  dot,
  sideOfGreatCircle,
  convexHull,
  buildTriangulation,
  flattenTriangulation,
  createQueryContext,
  findNearestVertices,
  vertexNeighbors,
  createWalkTrace,
  vertexLatLon,
  locateTriangle,
  locateTriangleByScan,
} from "./index";
import type {
  FlatDelaunay,
  Point3D,
  QueryContext,
  SphericalDelaunay,
} from "./index";

const EARTH_RADIUS_M = 6_371_000;

// ---------- Helpers ----------

function buildTri(points: Point3D[]): SphericalDelaunay {
  return buildTriangulation(convexHull(points));
}

/**
 * Simulate the binary tile format's Float32 coordinate storage: production
 * data is written as Float32 and upcast to Float64 on read, which collapses
 * near-duplicate vertices onto identical coordinates and fills the
 * orientation determinant of thin slivers with noise.
 */
function quantizeToFloat32(fd: FlatDelaunay): FlatDelaunay {
  return {
    ...fd,
    vertexPoints: Float64Array.from(fd.vertexPoints, Math.fround),
  };
}

/** Exact nearest distance in meters by scanning every vertex. */
function bruteNearestM(fd: FlatDelaunay, lat: number, lon: number): number {
  const [qx, qy, qz] = toCartesian({ lat, lon });
  const vp = fd.vertexPoints;
  let best = Infinity;
  for (let v = 0; v < fd.vertexTriangles.length; v++) {
    const dx = vp[v * 3] - qx;
    const dy = vp[v * 3 + 1] - qy;
    const dz = vp[v * 3 + 2] - qz;
    const chord = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const d = 2 * Math.asin(chord < 2 ? chord / 2 : 1) * EARTH_RADIUS_M;
    if (d < best) best = d;
  }
  return best;
}

/** Squared chord length from a vertex to a cartesian query point. */
function chordSqToQuery(fd: FlatDelaunay, vertex: number, q: Point3D): number {
  const vp = fd.vertexPoints;
  const vi = vertex * 3;
  const dx = vp[vi] - q[0];
  const dy = vp[vi + 1] - q[1];
  const dz = vp[vi + 2] - q[2];
  return dx * dx + dy * dy + dz * dz;
}

// ---------- Full-sphere triangulations ----------

/** 6 axis-aligned points forming an octahedron */
const OCTAHEDRON_POINTS: Point3D[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

const WORLD_CITIES = [
  { lat: 48.8566, lon: 2.3522 }, // Paris
  { lat: 40.7128, lon: -74.006 }, // New York
  { lat: 35.6762, lon: 139.6503 }, // Tokyo
  { lat: -33.8688, lon: 151.2093 }, // Sydney
  { lat: 51.5074, lon: -0.1278 }, // London
  { lat: -22.9068, lon: -43.1729 }, // Rio de Janeiro
  { lat: 55.7558, lon: 37.6173 }, // Moscow
  { lat: 1.3521, lon: 103.8198 }, // Singapore
  { lat: -1.2921, lon: 36.8219 }, // Nairobi
  { lat: 64.1466, lon: -21.9426 }, // Reykjavik
];

function vertexPoint(fd: FlatDelaunay, vertex: number): Point3D {
  const vp = fd.vertexPoints;
  return [vp[vertex * 3], vp[vertex * 3 + 1], vp[vertex * 3 + 2]];
}

/** Verify query is on the non-negative side of all three edges. */
function triangleContains(
  fd: FlatDelaunay,
  triIdx: number,
  query: Point3D,
): boolean {
  for (let e = 0; e < 3; e++) {
    const a = vertexPoint(fd, fd.triangleVertices[triIdx * 3 + e]);
    const b = vertexPoint(fd, fd.triangleVertices[triIdx * 3 + ((e + 1) % 3)]);
    if (sideOfGreatCircle(a, b, query) < -1e-10) return false;
  }
  return true;
}

/** Linear scan to find the closest vertex — ground truth for comparison. */
function bruteNearestVertex(fd: FlatDelaunay, q: Point3D): number {
  let bestV = 0;
  let bestSq = chordSqToQuery(fd, 0, q);
  for (let v = 1; v < fd.vertexTriangles.length; v++) {
    const sq = chordSqToQuery(fd, v, q);
    if (sq < bestSq) {
      bestSq = sq;
      bestV = v;
    }
  }
  return bestV;
}

/** The triangle the locate walk ended in (walks terminate by containment on full spheres). */
function locateFinalTriangle(ctx: QueryContext, query: Point3D): number {
  const trace = createWalkTrace();
  findNearestVertices(ctx, query, 1, { trace });
  expect(trace.locateTriangles.length).toBeGreaterThan(0);
  return trace.locateTriangles[trace.locateTriangles.length - 1];
}

describe("locate walk (full sphere)", () => {
  const octaFd = flattenTriangulation(buildTri(OCTAHEDRON_POINTS));
  const octaCtx = createQueryContext(octaFd);

  it("ends at a containing triangle for face-center queries", () => {
    const T = octaFd.triangleVertices.length / 3;
    for (let ti = 0; ti < T; ti++) {
      const a = vertexPoint(octaFd, octaFd.triangleVertices[ti * 3]);
      const b = vertexPoint(octaFd, octaFd.triangleVertices[ti * 3 + 1]);
      const c = vertexPoint(octaFd, octaFd.triangleVertices[ti * 3 + 2]);
      const center = normalize([
        a[0] + b[0] + c[0],
        a[1] + b[1] + c[1],
        a[2] + b[2] + c[2],
      ]);
      const found = locateFinalTriangle(octaCtx, center);
      expect(
        triangleContains(octaFd, found, center),
        `triangle ${ti} centroid not located correctly`,
      ).toBe(true);
    }
  });

  it("ends at a containing triangle for vertex and edge-midpoint queries", () => {
    // Boundary queries sit on the edge of multiple triangles; any
    // containing one is a valid answer.
    for (let vi = 0; vi < octaFd.vertexTriangles.length; vi++) {
      const v = vertexPoint(octaFd, vi);
      const found = locateFinalTriangle(octaCtx, v);
      expect(
        triangleContains(octaFd, found, v),
        `vertex ${vi} not located correctly`,
      ).toBe(true);
    }
    const T = octaFd.triangleVertices.length / 3;
    const visited = new Set<string>();
    for (let ti = 0; ti < T; ti++) {
      for (let e = 0; e < 3; e++) {
        const ia = octaFd.triangleVertices[ti * 3 + e];
        const ib = octaFd.triangleVertices[ti * 3 + ((e + 1) % 3)];
        const key = `${Math.min(ia, ib)}-${Math.max(ia, ib)}`;
        if (visited.has(key)) continue;
        visited.add(key);
        const a = vertexPoint(octaFd, ia);
        const b = vertexPoint(octaFd, ib);
        const mid = normalize([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
        const found = locateFinalTriangle(octaCtx, mid);
        expect(
          triangleContains(octaFd, found, mid),
          `edge midpoint ${key} not located correctly`,
        ).toBe(true);
      }
    }
  });

  it("converges from every start triangle on the octahedron", () => {
    const query = normalize([1, 1, 1]);
    const T = octaFd.triangleVertices.length / 3;
    for (let start = 0; start < T; start++) {
      const trace = createWalkTrace();
      findNearestVertices(octaCtx, query, 1, { startTriangle: start, trace });
      const found = trace.locateTriangles[trace.locateTriangles.length - 1];
      expect(
        triangleContains(octaFd, found, query),
        `walk from triangle ${start} did not converge`,
      ).toBe(true);
    }
  });

  it("converges from a distant start on world cities", () => {
    const tri = buildTri(WORLD_CITIES.map(toCartesian));
    const fd = flattenTriangulation(tri);
    const ctx = createQueryContext(fd);
    // Query near Paris, start from the triangle of the last vertex (Reykjavik)
    const query = toCartesian({ lat: 48.5, lon: 2.0 });
    const distantStart = fd.vertexTriangles[fd.vertexTriangles.length - 1];
    const trace = createWalkTrace();
    findNearestVertices(ctx, query, 1, {
      startTriangle: distantStart,
      trace,
    });
    const found = trace.locateTriangles[trace.locateTriangles.length - 1];
    expect(triangleContains(fd, found, query)).toBe(true);
  });
});

describe("vertexNeighbors", () => {
  describe("octahedron", () => {
    const fd = flattenTriangulation(buildTri(OCTAHEDRON_POINTS));

    it("returns exactly 4 neighbors for each vertex", () => {
      for (let vi = 0; vi < fd.vertexTriangles.length; vi++) {
        const neighbors = vertexNeighbors(fd, vi);
        expect(
          neighbors.length,
          `vertex ${vi} should have 4 neighbors in octahedron`,
        ).toBe(4);
      }
    });

    it("returns no duplicates", () => {
      for (let vi = 0; vi < fd.vertexTriangles.length; vi++) {
        const neighbors = vertexNeighbors(fd, vi);
        expect(
          new Set(neighbors).size,
          `vertex ${vi} has duplicate neighbors`,
        ).toBe(neighbors.length);
      }
    });

    it("does not include the vertex itself", () => {
      for (let vi = 0; vi < fd.vertexTriangles.length; vi++) {
        const neighbors = vertexNeighbors(fd, vi);
        expect(
          neighbors,
          `vertex ${vi} found in its own neighbors`,
        ).not.toContain(vi);
      }
    });

    it("does not connect antipodal vertices", () => {
      // In an octahedron, +x (index 0) should NOT neighbor -x (index 1)
      const neighbors = vertexNeighbors(fd, 0);
      const neighborPoints = neighbors.map((n) => vertexPoint(fd, n));
      const hasAntipodal = neighborPoints.some(
        (p) => p[0] < -0.5 && Math.abs(p[1]) < 0.1 && Math.abs(p[2]) < 0.1,
      );
      expect(hasAntipodal, "+x should not neighbor -x in octahedron").toBe(
        false,
      );
    });
  });

  describe("world cities", () => {
    const fd = flattenTriangulation(buildTri(WORLD_CITIES.map(toCartesian)));

    it("neighbor relationship is symmetric", () => {
      for (let vi = 0; vi < fd.vertexTriangles.length; vi++) {
        const neighbors = vertexNeighbors(fd, vi);
        for (const ni of neighbors) {
          const reverseNeighbors = vertexNeighbors(fd, ni);
          expect(
            reverseNeighbors,
            `vertex ${ni} should list ${vi} as neighbor (symmetry)`,
          ).toContain(vi);
        }
      }
    });

    it("covers all edges from the triangulation", () => {
      // Collect all edges from triangles
      const triangleEdges = new Set<string>();
      const T = fd.triangleVertices.length / 3;
      for (let ti = 0; ti < T; ti++) {
        for (let e = 0; e < 3; e++) {
          const a = fd.triangleVertices[ti * 3 + e];
          const b = fd.triangleVertices[ti * 3 + ((e + 1) % 3)];
          triangleEdges.add(`${Math.min(a, b)}-${Math.max(a, b)}`);
        }
      }

      // Collect all edges from vertexNeighbors
      const neighborEdges = new Set<string>();
      for (let vi = 0; vi < fd.vertexTriangles.length; vi++) {
        for (const ni of vertexNeighbors(fd, vi)) {
          neighborEdges.add(`${Math.min(vi, ni)}-${Math.max(vi, ni)}`);
        }
      }

      expect(neighborEdges).toEqual(triangleEdges);
    });
  });
});

describe("findNearestVertices (full sphere)", () => {
  describe("octahedron", () => {
    const fd = flattenTriangulation(buildTri(OCTAHEDRON_POINTS));
    const ctx = createQueryContext(fd);

    it("returns the +x vertex for a query biased toward +x", () => {
      const query = normalize([3, 0.1, 0.1]);
      const { nearestVertex } = findNearestVertices(ctx, query);
      const np = vertexPoint(fd, nearestVertex);
      expect(np[0]).toBeCloseTo(1, 5);
      expect(np[1]).toBeCloseTo(0, 5);
      expect(np[2]).toBeCloseTo(0, 5);
    });

    it("finds nearest for exact vertex queries", () => {
      for (let vi = 0; vi < fd.vertexTriangles.length; vi++) {
        const { nearestVertex } = findNearestVertices(ctx, vertexPoint(fd, vi));
        expect(nearestVertex, `vertex ${vi} not found as its own nearest`).toBe(
          vi,
        );
      }
    });
  });

  describe("world cities", () => {
    const tri = buildTri(WORLD_CITIES.map(toCartesian));
    const fd = flattenTriangulation(tri);
    const ctx = createQueryContext(fd);

    it("finds the correct city for nearby queries", () => {
      for (let i = 0; i < WORLD_CITIES.length; i++) {
        const { lat, lon } = WORLD_CITIES[i];
        const query = toCartesian({ lat: lat + 0.01, lon: lon + 0.01 });
        const { nearestVertex } = findNearestVertices(ctx, query);
        expect(
          tri.originalIndices[nearestVertex],
          `city ${i} (${lat}, ${lon}) not found`,
        ).toBe(i);
      }
    });
  });

  describe("brute-force comparison", () => {
    it("matches brute force on 10 cities with 50 random queries", () => {
      const fd = flattenTriangulation(buildTri(WORLD_CITIES.map(toCartesian)));
      const ctx = createQueryContext(fd);

      // Deterministic pseudo-random via simple LCG
      let seed = 42;
      function rand(): number {
        seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
        return seed / 0x7fffffff;
      }

      for (let i = 0; i < 50; i++) {
        const lat = rand() * 180 - 90;
        const lon = rand() * 360 - 180;
        const query = toCartesian({ lat, lon });
        const { nearestVertex } = findNearestVertices(ctx, query);
        expect(
          nearestVertex,
          `query ${i} (${lat.toFixed(2)}, ${lon.toFixed(2)})`,
        ).toBe(bruteNearestVertex(fd, query));
      }
    });

    it("matches brute force on 20 cities with 100 random queries", () => {
      const extraCities = [
        { lat: 37.7749, lon: -122.4194 }, // San Francisco
        { lat: 19.4326, lon: -99.1332 }, // Mexico City
        { lat: 30.0444, lon: 31.2357 }, // Cairo
        { lat: 39.9042, lon: 116.4074 }, // Beijing
        { lat: -34.6037, lon: -58.3816 }, // Buenos Aires
        { lat: 59.3293, lon: 18.0686 }, // Stockholm
        { lat: 13.7563, lon: 100.5018 }, // Bangkok
        { lat: 41.0082, lon: 28.9784 }, // Istanbul
        { lat: -26.2041, lon: 28.0473 }, // Johannesburg
        { lat: 25.2048, lon: 55.2708 }, // Dubai
      ];
      const allCities = [...WORLD_CITIES, ...extraCities];
      const fd = flattenTriangulation(buildTri(allCities.map(toCartesian)));
      const ctx = createQueryContext(fd);

      let seed = 123;
      function rand(): number {
        seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
        return seed / 0x7fffffff;
      }

      for (let i = 0; i < 100; i++) {
        const lat = rand() * 180 - 90;
        const lon = rand() * 360 - 180;
        const query = toCartesian({ lat, lon });
        const { nearestVertex } = findNearestVertices(ctx, query);
        expect(
          nearestVertex,
          `query ${i} (${lat.toFixed(2)}, ${lon.toFixed(2)})`,
        ).toBe(bruteNearestVertex(fd, query));
      }
    });
  });

  describe("edge cases", () => {
    const fd = flattenTriangulation(buildTri(WORLD_CITIES.map(toCartesian)));
    const ctx = createQueryContext(fd);

    it("handles north and south pole queries", () => {
      const northPole: Point3D = [0, 0, 1];
      const southPole: Point3D = [0, 0, -1];

      expect(findNearestVertices(ctx, northPole).nearestVertex).toBe(
        bruteNearestVertex(fd, northPole),
      );
      expect(findNearestVertices(ctx, southPole).nearestVertex).toBe(
        bruteNearestVertex(fd, southPole),
      );
    });

    it("respects an explicit startTriangle", () => {
      const query = toCartesian({ lat: 48.5, lon: 2.0 });
      const T = fd.triangleVertices.length / 3;

      // Should return the same result regardless of start
      const fromDefault = findNearestVertices(ctx, query).nearestVertex;
      const fromExplicit = findNearestVertices(ctx, query, 1, {
        startTriangle: T - 1,
      }).nearestVertex;
      expect(fromExplicit).toBe(fromDefault);
    });
  });
});

// ---------- Degenerate triangulations ----------

describe("findNearestVertices (degenerate triangulation)", () => {
  /**
   * Regression test: near-duplicate vertices (from Float32 quantization of
   * very close coordinates) can create degenerate triangles where the
   * triangle walk loops forever. The fix detects cycles and falls back
   * to brute-force search. Reproduces the Stockholm bug (tour-guide-mae).
   */
  it("finds the nearest vertex when the triangle walk hits a cycle", () => {
    // Near-duplicate points that collapse into degenerate triangles after
    // Float32 quantization.
    const inputs = [
      { lat: 59.3208, lon: 18.0594 }, // Stockholm A
      { lat: 59.3208, lon: 18.05941 }, // Stockholm B, ~0.07m from A
      { lat: 59.3209, lon: 18.0594 }, // Stockholm C
      { lat: -59.0, lon: -160.0 }, // Antipode
    ];
    const tri = buildTri(inputs.map(toCartesian));
    const fd = quantizeToFloat32(flattenTriangulation(tri));
    const ctx = createQueryContext(fd);

    // Query from Stockholm — should find a Stockholm vertex, not diverge.
    const { hits } = findNearestVertices(ctx, toCartesian(inputs[0]));
    expect(hits).toHaveLength(1);
    expect(hits[0].distance * EARTH_RADIUS_M).toBeLessThan(100);
    // The winner is one of the three Stockholm points, not the antipode.
    expect(tri.originalIndices[hits[0].vertex]).toBeLessThan(3);
  });
});

describe("findNearestVertices (Float32 quantization)", () => {
  /**
   * Regression test: with dot-product distance (acos(dot)), nearby points
   * (<~4 km) in the same region would all collapse to 0 m after Float32
   * quantization because the rounding error exceeds (1 − dot). The
   * chord-length formula avoids this.
   */
  it("distinguishes nearby points after Float32 quantization", () => {
    // Three points within ~1 km of each other in Stockholm; an antipodal
    // point closes the hull.
    const inputs = [
      { lat: 59.308, lon: 18.028 }, // A
      { lat: 59.315, lon: 18.039 }, // B
      { lat: 59.315, lon: 18.019 }, // C
      { lat: -59.31, lon: -161.97 }, // Far
    ];
    const tri = buildTri(inputs.map(toCartesian));
    const fd = quantizeToFloat32(flattenTriangulation(tri));
    const ctx = createQueryContext(fd);

    // Query from point A's location — A is nearest, B and C are ~1 km out.
    const { hits } = findNearestVertices(ctx, toCartesian(inputs[0]), 3);
    expect(tri.originalIndices[hits[0].vertex]).toBe(0);
    expect(hits[0].distance * EARTH_RADIUS_M).toBeLessThan(10);
    expect(hits[1].distance * EARTH_RADIUS_M).toBeGreaterThan(500);
    expect(hits[2].distance * EARTH_RADIUS_M).toBeGreaterThan(500);
  });
});

// ---------- Patch triangulations (out-of-cap queries) ----------

/**
 * Build a tile-like patch: a jittered grid of points covering a single
 * 5°×5°-ish region of the sphere (like a production tile, including the
 * Float32 quantization), with a few coincident-duplicate clusters mimicking
 * bot-generated articles that share one coordinate.
 *
 * Unlike full-sphere fixtures, the convex hull of a patch is a thin lens
 * whose underside ("back closure") gives the locate walk no containing
 * triangle for queries outside the patch — the regression area for
 * tour-guide-8lmb.
 */
function buildPatch(): {
  ctx: QueryContext;
  fd: FlatDelaunay;
  dupAVertices: Set<number>;
} {
  const inputs: { lat: number; lon: number }[] = [];
  const south = 55;
  const west = 15;
  const n = 24;
  const step = 5 / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // Deterministic jitter, ±20% of a cell — irregular but reproducible.
      const jLat = 0.2 * step * Math.sin(i * 12.9898 + j * 78.233);
      const jLon = 0.2 * step * Math.sin(i * 39.346 + j * 11.135);
      inputs.push({
        lat: south + (i + 0.5) * step + jLat,
        lon: west + (j + 0.5) * step + jLon,
      });
    }
  }
  // Coincident duplicates: several points at exactly the same coordinate
  // (Float32 quantization makes them identical vertices in the data).
  const dupAStart = inputs.length;
  for (const [lat, lon] of [
    [57.31, 17.42], // DupA
    [55.87, 16.11], // DupB
    [59.13, 19.55], // DupC
  ] as const) {
    for (let c = 0; c < 5; c++) {
      inputs.push({ lat, lon });
    }
  }

  const tri = buildTri(inputs.map(toCartesian));
  const fd = quantizeToFloat32(flattenTriangulation(tri));
  const dupAVertices = new Set<number>();
  for (let v = 0; v < tri.originalIndices.length; v++) {
    const orig = tri.originalIndices[v];
    if (orig >= dupAStart && orig < dupAStart + 5) dupAVertices.add(v);
  }
  return { ctx: createQueryContext(fd), fd, dupAVertices };
}

describe("findNearestVertices (patch, queries outside the patch)", () => {
  let patch: ReturnType<typeof buildPatch>;

  beforeAll(() => {
    patch = buildPatch();
  });

  it("finds the exact nearest vertex for queries outside the patch on every side", () => {
    // Probes ~1° beyond each edge and corner of the 55..60 / 15..20 patch —
    // the adjacent-tile situation: the query's containing triangle does not
    // exist in this triangulation.
    const probes: [number, number][] = [
      [61.0, 17.5],
      [54.0, 17.5],
      [57.5, 13.9],
      [57.5, 21.1],
      [61.0, 13.9],
      [61.0, 21.1],
      [54.0, 13.9],
      [54.0, 21.1],
    ];
    for (const [lat, lon] of probes) {
      const { hits } = findNearestVertices(
        patch.ctx,
        toCartesian({ lat, lon }),
      );
      expect(hits).toHaveLength(1);
      // Compare distances, not vertex ids: coincident duplicates tie exactly.
      expect(hits[0].distance * EARTH_RADIUS_M).toBeCloseTo(
        bruteNearestM(patch.fd, lat, lon),
        6,
      );
    }
  });

  it("terminates out-of-patch walks in bounded hops without brute force", () => {
    const trace = createWalkTrace();
    findNearestVertices(patch.ctx, toCartesian({ lat: 61.0, lon: 17.5 }), 1, {
      trace,
    });

    // The pre-fix walk either orbited the hull's back closure until
    // maxSteps (≈ triangle count, >1000 here) or fell back to an O(V)
    // brute-force scan. The patience rule stops it shortly after it has
    // passed the rim vertices nearest the query.
    expect(trace.usedBruteForce).toBe(false);
    expect(trace.locateTriangles.length).toBeLessThan(300);
  });

  it("keeps out-of-patch walk traces off patch-spanning back-closure chords", () => {
    // The hull's underside triangulates the rim with chords that can span
    // the whole patch. A walk that slides across them paints patch-wide
    // streaks in the X-ray overlay, so they are walled off; the walk slides
    // along the rim's narrow front triangles instead. The probe sits south
    // of the patch: on the equatorward rim every wide facet is an underside
    // chord. (Poleward rims also own wide FRONT facets — great-circle
    // chords bulge poleward of the small-circle rim line — and the walk is
    // allowed to cross those.)
    const trace = createWalkTrace();
    findNearestVertices(patch.ctx, toCartesian({ lat: 54.0, lon: 17.5 }), 1, {
      trace,
    });

    let maxLonSpan = 0;
    for (const t of trace.locateTriangles) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < 3; i++) {
        const { lon } = vertexLatLon(
          patch.fd,
          patch.fd.triangleVertices[t * 3 + i],
        );
        lo = Math.min(lo, lon);
        hi = Math.max(hi, lon);
      }
      maxLonSpan = Math.max(maxLonSpan, hi - lo);
    }
    // Front triangles of the fixture span well under a degree; underside
    // chords span multiple degrees.
    expect(maxLonSpan).toBeLessThan(1);
  });

  it("matches brute force for in-patch queries", () => {
    for (const [lat, lon] of [
      [57.5, 17.5],
      [55.6, 15.4],
      [59.7, 19.8],
      [56.2, 18.9],
    ] as [number, number][]) {
      const { hits } = findNearestVertices(
        patch.ctx,
        toCartesian({ lat, lon }),
      );
      expect(hits[0].distance * EARTH_RADIUS_M).toBeCloseTo(
        bruteNearestM(patch.fd, lat, lon),
        6,
      );
    }
  });

  it("returns the exact nearest when it is a coincident-duplicate cluster", () => {
    // Query right next to the DupA cluster: greedy descent must not stall
    // on a cluster vertex whose only equal-distance neighbors are its
    // twins (the plateau is tunneled through).
    const { hits } = findNearestVertices(
      patch.ctx,
      toCartesian({ lat: 57.312, lon: 17.423 }),
      3,
    );
    expect(patch.dupAVertices.has(hits[0].vertex)).toBe(true);
    expect(hits[0].distance * EARTH_RADIUS_M).toBeCloseTo(
      bruteNearestM(patch.fd, 57.312, 17.423),
      6,
    );
  });

  it("recovers exact answers from a warm start taken outside the patch", () => {
    // An out-of-patch query's nearest vertex can name an incident triangle
    // on the hull's back closure, where edge tests are flipped. A later
    // query warm-started from it must still answer exactly (the walk
    // restarts from its anchor when the start strands).
    const outside = findNearestVertices(
      patch.ctx,
      toCartesian({ lat: 61.0, lon: 17.5 }),
    );
    const warmStart = patch.fd.vertexTriangles[outside.nearestVertex];
    const warm = findNearestVertices(
      patch.ctx,
      toCartesian({ lat: 57.5, lon: 17.5 }),
      1,
      { startTriangle: warmStart },
    );
    expect(warm.hits[0].distance * EARTH_RADIUS_M).toBeCloseTo(
      bruteNearestM(patch.fd, 57.5, 17.5),
      6,
    );
  });
});

// ---------- Filtered expansion ----------

const STUB_WEIGHT = 10;
const HIGHLIGHT_WEIGHT = 100;

/** Build a query context plus a per-vertex weight table for filter tests. */
function buildWeighted(
  inputs: { lat: number; lon: number; weight: number }[],
): { ctx: QueryContext; weights: number[] } {
  const tri = buildTri(inputs.map((a) => toCartesian(a)));
  const fd = flattenTriangulation(tri);
  const weights = tri.originalIndices.map((i) => inputs[i].weight);
  return { ctx: createQueryContext(fd), weights };
}

/**
 * Concentric rings around (0,0): two inner rings of low-weight stubs
 * (12 vertices, every one of them nearer than any highlight) and an outer
 * ring of high-weight highlights. The nearest matches sit behind a wall of
 * non-matching vertices, so a filtered query must expand through them.
 * An antipodal stub closes the hull.
 */
function ringInputs(): { lat: number; lon: number; weight: number }[] {
  const inputs: { lat: number; lon: number; weight: number }[] = [];
  const ring = (radiusDeg: number, offsetDeg: number, weight: number) => {
    for (let i = 0; i < 6; i++) {
      const angle = ((i * 60 + offsetDeg) * Math.PI) / 180;
      inputs.push({
        lat: Math.sin(angle) * radiusDeg,
        lon: Math.cos(angle) * radiusDeg,
        weight,
      });
    }
  };
  ring(1, 0, STUB_WEIGHT); // inner stubs
  ring(2, 30, STUB_WEIGHT); // mid stubs
  ring(5, 0, HIGHLIGHT_WEIGHT); // highlights
  inputs.push({ lat: 0, lon: 180, weight: STUB_WEIGHT }); // antipode stub
  return inputs;
}

describe("findNearestVertices (filtered)", () => {
  let ringCtx: QueryContext;
  let ringWeights: number[];
  let highlightFilter: (v: number) => boolean;

  beforeAll(() => {
    const built = buildWeighted(ringInputs());
    ringCtx = built.ctx;
    ringWeights = built.weights;
    highlightFilter = (v) => ringWeights[v] >= 50;
  });

  it("returns only vertices accepted by the filter, sorted by distance", () => {
    const { hits } = findNearestVertices(
      ringCtx,
      toCartesian({ lat: 0, lon: 0 }),
      3,
      {
        filter: highlightFilter,
      },
    );

    expect(hits).toHaveLength(3);
    for (const h of hits) {
      expect(ringWeights[h.vertex]).toBe(HIGHLIGHT_WEIGHT);
    }
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i].distance).toBeGreaterThanOrEqual(hits[i - 1].distance);
    }
  });

  it("expands through a wall of non-matching vertices to reach matches beyond it", () => {
    // Sanity: the 12 nearest vertices are all stubs — every path from the
    // query to a highlight crosses non-matching vertices.
    const { hits: unfiltered } = findNearestVertices(
      ringCtx,
      toCartesian({ lat: 0, lon: 0 }),
      12,
    );
    expect(unfiltered).toHaveLength(12);
    expect(unfiltered.every((h) => ringWeights[h.vertex] === STUB_WEIGHT)).toBe(
      true,
    );

    // The filtered query must traverse the stub wall to find a highlight.
    // The walk's nearest vertex (an inner stub) seeds the frontier but is
    // not returned.
    const { hits } = findNearestVertices(
      ringCtx,
      toCartesian({ lat: 0, lon: 0 }),
      1,
      {
        filter: highlightFilter,
      },
    );
    expect(hits).toHaveLength(1);
    expect(ringWeights[hits[0].vertex]).toBe(HIGHLIGHT_WEIGHT);
  });

  it("returns all matches found when fewer than k satisfy the filter", () => {
    const { hits } = findNearestVertices(
      ringCtx,
      toCartesian({ lat: 0, lon: 0 }),
      10,
      {
        filter: highlightFilter,
      },
    );

    expect(hits).toHaveLength(6); // the fixture has exactly 6 highlights
    expect(hits.every((h) => ringWeights[h.vertex] === HIGHLIGHT_WEIGHT)).toBe(
      true,
    );
  });

  it("returns no hits when no vertex passes the filter", () => {
    const { hits } = findNearestVertices(
      ringCtx,
      toCartesian({ lat: 0, lon: 0 }),
      3,
      {
        filter: () => false,
      },
    );

    expect(hits).toEqual([]);
  });

  it("reports the same unfiltered nearestVertex as an unfiltered query", () => {
    const q = toCartesian({ lat: 0.5, lon: 0.5 });
    const unfiltered = findNearestVertices(ringCtx, q, 3);
    const filtered = findNearestVertices(ringCtx, q, 3, {
      filter: highlightFilter,
    });

    expect(filtered.nearestVertex).toBe(unfiltered.nearestVertex);
  });
});

describe("findNearestVertices (filtered visit cap)", () => {
  /**
   * 5000 quasi-uniform vertices (Fibonacci sphere). All are low-weight
   * stubs except the one at the south pole. Queried from the north pole,
   * the lone match lies beyond the FILTERED_VISIT_FLOOR (4096) horizon —
   * the cap bounds the scan instead of crawling the whole sphere.
   */
  const VERTEX_COUNT = 5000;
  let sphereCtx: QueryContext;
  let sphereWeights: number[];
  let southPoleVertex: number;

  beforeAll(() => {
    const golden = Math.PI * (3 - Math.sqrt(5));
    const inputs = Array.from({ length: VERTEX_COUNT }, (_, i) => {
      const z = 1 - (i / (VERTEX_COUNT - 1)) * 2; // 1 (north) → -1 (south)
      const theta = golden * i;
      return {
        lat: (Math.asin(z) * 180) / Math.PI,
        lon: (Math.atan2(Math.sin(theta), Math.cos(theta)) * 180) / Math.PI,
        weight: i === VERTEX_COUNT - 1 ? HIGHLIGHT_WEIGHT : STUB_WEIGHT,
      };
    });
    const built = buildWeighted(inputs);
    sphereCtx = built.ctx;
    sphereWeights = built.weights;
    southPoleVertex = built.weights.indexOf(HIGHLIGHT_WEIGHT);
  });

  it("stops scanning at the visit cap when matches are out of reach", () => {
    // From the north pole, the only highlight (south pole) sits ~900
    // vertices beyond the 4096-vertex budget: empty result, bounded work.
    const filter = (v: number) => sphereWeights[v] >= 50;
    const { hits } = findNearestVertices(
      sphereCtx,
      toCartesian({ lat: 90, lon: 0 }),
      1,
      {
        filter,
      },
    );

    expect(hits).toEqual([]);

    // Contrast: a larger k raises the budget (64 * k > vertex count), so
    // the same query reaches the south pole — proving the empty result
    // above came from the cap, not from the match being unreachable.
    const { hits: uncapped } = findNearestVertices(
      sphereCtx,
      toCartesian({ lat: 90, lon: 0 }),
      80,
      { filter },
    );
    expect(uncapped.map((h) => h.vertex)).toEqual([southPoleVertex]);
  });

  it("finds a sparse match that lies within the visit budget", () => {
    const { hits } = findNearestVertices(
      sphereCtx,
      toCartesian({ lat: -89, lon: 0 }),
      1,
      {
        filter: (v) => sphereWeights[v] >= 50,
      },
    );

    expect(hits).toHaveLength(1);
    expect(hits[0].vertex).toBe(southPoleVertex);
  });
});

// ---------- Walk tracing ----------

/**
 * Quasi-uniform Fibonacci sphere: every 5th vertex is a highlight, the rest
 * stubs. Dense enough to exercise multi-step descents and BFS expansion,
 * weighted so filtered queries have matches to find.
 */
function buildTracedSphere(count: number): {
  ctx: QueryContext;
  weights: number[];
} {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const inputs = Array.from({ length: count }, (_, i) => {
    const z = 1 - (i / (count - 1)) * 2;
    const theta = golden * i;
    return {
      lat: (Math.asin(z) * 180) / Math.PI,
      lon: (Math.atan2(Math.sin(theta), Math.cos(theta)) * 180) / Math.PI,
      weight: i % 5 === 0 ? HIGHLIGHT_WEIGHT : STUB_WEIGHT,
    };
  });
  return buildWeighted(inputs);
}

describe("findNearestVertices (walk tracing)", () => {
  let traceCtx: QueryContext;
  let traceWeights: number[];

  beforeAll(() => {
    const built = buildTracedSphere(400);
    traceCtx = built.ctx;
    traceWeights = built.weights;
  });

  it("returns identical results for an unfiltered k=1 query with and without a trace", () => {
    const q = toCartesian({ lat: 12, lon: 34 });
    const without = findNearestVertices(traceCtx, q);
    const with_ = findNearestVertices(traceCtx, q, 1, {
      trace: createWalkTrace(),
    });
    expect(with_.hits).toEqual(without.hits);
    expect(with_.nearestVertex).toBe(without.nearestVertex);
  });

  it("returns identical results for a k=5 query with and without a trace", () => {
    const q = toCartesian({ lat: 12, lon: 34 });
    const without = findNearestVertices(traceCtx, q, 5);
    const with_ = findNearestVertices(traceCtx, q, 5, {
      trace: createWalkTrace(),
    });
    expect(with_.hits).toEqual(without.hits);
    expect(with_.nearestVertex).toBe(without.nearestVertex);
  });

  it("returns identical results for a filtered query with and without a trace", () => {
    const q = toCartesian({ lat: 12, lon: 34 });
    const filter = (v: number) => traceWeights[v] >= 50;
    const without = findNearestVertices(traceCtx, q, 5, { filter });
    const with_ = findNearestVertices(traceCtx, q, 5, {
      filter,
      trace: createWalkTrace(),
    });
    expect(with_.hits).toEqual(without.hits);
    expect(with_.nearestVertex).toBe(without.nearestVertex);
  });

  it("records a trace nearestVertex matching the returned nearestVertex", () => {
    const trace = createWalkTrace();
    const { nearestVertex, hits } = findNearestVertices(
      traceCtx,
      toCartesian({ lat: 40, lon: -75 }),
      1,
      { trace },
    );
    expect(trace.nearestVertex).toBe(nearestVertex);
    expect(hits[0].vertex).toBe(nearestVertex);
  });

  it("records a descent with monotonically non-increasing distance to the query", () => {
    const trace = createWalkTrace();
    const q = toCartesian({ lat: -20, lon: 140 });
    findNearestVertices(traceCtx, q, 1, { trace });

    expect(trace.descentVertices.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < trace.descentVertices.length; i++) {
      const prev = chordSqToQuery(traceCtx.fd, trace.descentVertices[i - 1], q);
      const cur = chordSqToQuery(traceCtx.fd, trace.descentVertices[i], q);
      expect(cur).toBeLessThanOrEqual(prev);
    }
    // The descent ends at the recorded nearest vertex.
    expect(trace.descentVertices[trace.descentVertices.length - 1]).toBe(
      trace.nearestVertex,
    );
  });

  it("records BFS vertices with no duplicates, excluding the seed", () => {
    const trace = createWalkTrace();
    findNearestVertices(traceCtx, toCartesian({ lat: 12, lon: 34 }), 8, {
      trace,
    });

    expect(trace.bfsVertices.length).toBeGreaterThan(0);
    expect(new Set(trace.bfsVertices).size).toBe(trace.bfsVertices.length);
    // The seed (the unfiltered nearest vertex) is never re-emitted.
    expect(trace.bfsVertices).not.toContain(trace.nearestVertex);
  });

  it("leaves bfsVertices empty for a plain k=1 query", () => {
    const trace = createWalkTrace();
    findNearestVertices(traceCtx, toCartesian({ lat: 12, lon: 34 }), 1, {
      trace,
    });
    expect(trace.bfsVertices).toEqual([]);
  });

  it("records a non-empty locate walk ending in an in-range triangle", () => {
    const trace = createWalkTrace();
    findNearestVertices(traceCtx, toCartesian({ lat: 12, lon: 34 }), 1, {
      trace,
    });

    expect(trace.locateTriangles.length).toBeGreaterThan(0);
    const finalTri = trace.locateTriangles[trace.locateTriangles.length - 1];
    const tv = traceCtx.fd.triangleVertices;
    const vertexCount = traceCtx.fd.vertexTriangles.length;
    for (let e = 0; e < 3; e++) {
      const v = tv[finalTri * 3 + e];
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(vertexCount);
    }
    expect(trace.usedBruteForce).toBe(false);
  });

  it("round-trips vertexLatLon through toCartesian", () => {
    const fd = traceCtx.fd;
    for (const v of [0, 7, 100, 399]) {
      const { lat, lon } = vertexLatLon(fd, v);
      const [x, y, z] = toCartesian({ lat, lon });
      const vi = v * 3;
      expect(x).toBeCloseTo(fd.vertexPoints[vi], 7);
      expect(y).toBeCloseTo(fd.vertexPoints[vi + 1], 7);
      expect(z).toBeCloseTo(fd.vertexPoints[vi + 2], 7);
    }
  });
});

// ---------- Point location ----------

/** Deterministic PRNG (mulberry32) — same seed always yields the same sequence. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform random point on the sphere, in degrees. */
function randomLatLon(rand: () => number): { lat: number; lon: number } {
  const u = rand();
  const v = rand();
  return {
    lat: (Math.asin(2 * u - 1) * 180) / Math.PI,
    lon: 360 * v - 180,
  };
}

/** Minimum of a triangle's three signed edge-side values — negative means p is outside that edge. */
function minSideOfTriangle(
  fd: FlatDelaunay,
  vertices: [number, number, number],
  p: Point3D,
): number {
  const v0 = vertexPoint(fd, vertices[0]);
  const v1 = vertexPoint(fd, vertices[1]);
  const v2 = vertexPoint(fd, vertices[2]);
  return Math.min(
    sideOfGreatCircle(v0, v1, p),
    sideOfGreatCircle(v1, v2, p),
    sideOfGreatCircle(v2, v0, p),
  );
}

describe("locateTriangle (full sphere)", () => {
  const octaFd = flattenTriangulation(buildTri(OCTAHEDRON_POINTS));
  const octaCtx = createQueryContext(octaFd);

  it("returns positive weights summing to 1 at a face-interior point, aligned to the correct face", () => {
    const p = toCartesian({ lat: 30, lon: 30 });
    const loc = locateTriangle(octaCtx, p);

    expect(loc).not.toBeNull();
    const { vertices, weights } = loc!;
    expect(weights[0]).toBeGreaterThan(0);
    expect(weights[1]).toBeGreaterThan(0);
    expect(weights[2]).toBeGreaterThan(0);
    expect(Math.abs(weights[0] + weights[1] + weights[2] - 1)).toBeLessThan(
      1e-12,
    );

    // Octahedron coordinates are exact — compare the returned vertices'
    // coordinates as a set rather than assuming a flat vertex index order.
    const got = vertices
      .map((v) => JSON.stringify(vertexPoint(octaFd, v)))
      .sort();
    const expected = (
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ] as Point3D[]
    )
      .map((v) => JSON.stringify(v))
      .sort();
    expect(got).toEqual(expected);
  });

  it("assigns weight ~1 to the queried vertex when p lands exactly on it", () => {
    const p: Point3D = [1, 0, 0];
    const loc = locateTriangle(octaCtx, p);

    expect(loc).not.toBeNull();
    const { vertices, weights } = loc!;
    const pos = vertices.findIndex((v) => {
      const vp = vertexPoint(octaFd, v);
      return vp[0] === 1 && vp[1] === 0 && vp[2] === 0;
    });
    expect(pos).toBeGreaterThanOrEqual(0);
    weights.forEach((w, i) => {
      const expected = i === pos ? 1 : 0;
      expect(Math.abs(w - expected)).toBeLessThan(1e-9);
    });
  });

  it("splits weight 50/50 between the two vertices at an edge midpoint", () => {
    const p = toCartesian({ lat: 0, lon: 45 }); // midpoint of [1,0,0] and [0,1,0]
    const loc = locateTriangle(octaCtx, p);

    expect(loc).not.toBeNull();
    const { vertices, weights } = loc!;
    const xPos = vertices.findIndex((v) => {
      const vp = vertexPoint(octaFd, v);
      return vp[0] === 1 && vp[1] === 0 && vp[2] === 0;
    });
    const yPos = vertices.findIndex((v) => {
      const vp = vertexPoint(octaFd, v);
      return vp[0] === 0 && vp[1] === 1 && vp[2] === 0;
    });
    expect(xPos).toBeGreaterThanOrEqual(0);
    expect(yPos).toBeGreaterThanOrEqual(0);
    const zPos = 3 - xPos - yPos;

    expect(Math.abs(weights[xPos] - 0.5)).toBeLessThan(1e-9);
    expect(Math.abs(weights[yPos] - 0.5)).toBeLessThan(1e-9);
    expect(Math.abs(weights[zPos])).toBeLessThan(1e-9);
  });

  it("reconstructs the query direction from weighted vertices on random data", () => {
    const pointRand = mulberry32(42);
    const points = Array.from({ length: 60 }, () =>
      toCartesian(randomLatLon(pointRand)),
    );
    const fd = flattenTriangulation(buildTri(points));
    const ctx = createQueryContext(fd);
    const queryRand = mulberry32(1234);

    for (let i = 0; i < 300; i++) {
      const p = toCartesian(randomLatLon(queryRand));
      const loc = locateTriangle(ctx, p);

      expect(loc, `query ${i}`).not.toBeNull();
      const { vertices, weights } = loc!;
      const sum = weights[0] + weights[1] + weights[2];
      expect(Math.abs(sum - 1), `query ${i}`).toBeLessThan(1e-9);
      for (const w of weights) {
        expect(w, `query ${i}`).toBeGreaterThanOrEqual(0);
        expect(w, `query ${i}`).toBeLessThanOrEqual(1);
      }

      const v0 = vertexPoint(fd, vertices[0]);
      const v1 = vertexPoint(fd, vertices[1]);
      const v2 = vertexPoint(fd, vertices[2]);
      const combo: Point3D = [
        weights[0] * v0[0] + weights[1] * v1[0] + weights[2] * v2[0],
        weights[0] * v0[1] + weights[1] * v1[1] + weights[2] * v2[1],
        weights[0] * v0[2] + weights[1] * v1[2] + weights[2] * v2[2],
      ];
      expect(dot(normalize(combo), p), `query ${i}`).toBeGreaterThan(1 - 1e-9);
    }
  });

  it("agrees with the scan oracle on random data, or lands on an edge-adjacent triangle", () => {
    const pointRand = mulberry32(42);
    const points = Array.from({ length: 60 }, () =>
      toCartesian(randomLatLon(pointRand)),
    );
    const fd = flattenTriangulation(buildTri(points));
    const ctx = createQueryContext(fd);
    const queryRand = mulberry32(1234);

    for (let i = 0; i < 300; i++) {
      const p = toCartesian(randomLatLon(queryRand));
      const walked = locateTriangle(ctx, p);
      const scan = locateTriangleByScan(ctx, p);

      expect(walked, `query ${i}`).not.toBeNull();
      expect(scan, `query ${i}`).not.toBeNull();
      const sameTriangle = walked!.triangle === scan!.triangle;
      const walkedMinSide = minSideOfTriangle(fd, walked!.vertices, p);
      expect(sameTriangle || walkedMinSide >= -1e-12, `query ${i}`).toBe(true);
    }
  });

  it("gives the same result from a nearby startTriangle hint as with no hint", () => {
    const first = locateTriangle(octaCtx, toCartesian({ lat: 30, lon: 30 }));
    expect(first).not.toBeNull();
    const p2 = toCartesian({ lat: 30.5, lon: 30 });

    const hinted = locateTriangle(octaCtx, p2, first!.triangle);
    const unhinted = locateTriangle(octaCtx, p2);

    expect(hinted).not.toBeNull();
    expect(unhinted).not.toBeNull();
    expect(hinted!.triangle).toBe(unhinted!.triangle);
    expect(hinted!.weights).toEqual(unhinted!.weights);
  });

  it("still converges to the oracle's triangle from a deliberately far startTriangle hint", () => {
    const tv = octaFd.triangleVertices;
    const corners = [0, 1, 2].map((i) => vertexPoint(octaFd, tv[i]));
    const centroid: Point3D = [
      corners[0][0] + corners[1][0] + corners[2][0],
      corners[0][1] + corners[1][1] + corners[2][1],
      corners[0][2] + corners[1][2] + corners[2][2],
    ];
    const antipodal = normalize([-centroid[0], -centroid[1], -centroid[2]]);

    const result = locateTriangle(octaCtx, antipodal, 0);
    const oracle = locateTriangleByScan(octaCtx, antipodal);

    expect(result).not.toBeNull();
    expect(oracle).not.toBeNull();
    expect(result!.triangle).toBe(oracle!.triangle);
  });
});

describe("locateTriangle (patch, thin-lens hull)", () => {
  let patch: ReturnType<typeof buildPatch>;

  beforeAll(() => {
    patch = buildPatch();
  });

  it("locates in-patch queries in a front triangle, agreeing with the scan oracle", () => {
    const probes: [number, number][] = [
      [57.5, 17.5],
      [56.2, 16.1],
      [59.0, 19.2],
    ];
    for (const [lat, lon] of probes) {
      const p = toCartesian({ lat, lon });
      const label = `(${lat}, ${lon})`;
      const loc = locateTriangle(patch.ctx, p);
      const oracle = locateTriangleByScan(patch.ctx, p);

      expect(loc, label).not.toBeNull();
      expect(oracle, label).not.toBeNull();
      expect(patch.ctx.backClosure[loc!.triangle], label).toBe(0);

      const sum = loc!.weights[0] + loc!.weights[1] + loc!.weights[2];
      expect(Math.abs(sum - 1), label).toBeLessThan(1e-9);
      for (const w of loc!.weights) expect(w, label).toBeGreaterThanOrEqual(0);

      const sameTriangle = loc!.triangle === oracle!.triangle;
      const minSide = minSideOfTriangle(patch.fd, loc!.vertices, p);
      expect(sameTriangle || minSide >= -1e-12, label).toBe(true);
    }
  });

  it("returns null from both walk and scan for queries beyond the patch rim", () => {
    // ~1° beyond each edge and corner of the 55..60 / 15..20 patch, plus the
    // antipode of the patch center — no containing triangle exists for any
    // of these.
    const probes: [number, number][] = [
      [61.0, 17.5],
      [54.0, 17.5],
      [57.5, 21.0],
      [57.5, 14.0],
      [61, 21],
      [54, 14],
      [-57.5, -162.5],
    ];
    for (const [lat, lon] of probes) {
      const p = toCartesian({ lat, lon });
      const label = `(${lat}, ${lon})`;
      expect(locateTriangle(patch.ctx, p), label).toBeNull();
      expect(locateTriangleByScan(patch.ctx, p), label).toBeNull();
    }
  });

  it("agrees with the scan oracle on null-vs-contained across a probe grid spanning the rim", () => {
    for (let lat = 54; lat <= 61; lat += 0.5) {
      for (let lon = 14; lon <= 21; lon += 0.5) {
        const p = toCartesian({ lat, lon });
        const label = `(${lat}, ${lon})`;
        const walk = locateTriangle(patch.ctx, p);
        const scan = locateTriangleByScan(patch.ctx, p);

        expect(walk === null, label).toBe(scan === null);
        if (walk !== null) {
          expect(patch.ctx.backClosure[walk.triangle], label).toBe(0);
          expect(
            minSideOfTriangle(patch.fd, walk.vertices, p),
            label,
          ).toBeGreaterThanOrEqual(-1e-12);
        }
      }
    }
  });

  it("recovers the correct in-patch location from a warm start taken outside the patch", () => {
    const outside = findNearestVertices(
      patch.ctx,
      toCartesian({ lat: 61, lon: 17.5 }),
    );
    const startTriangle = patch.fd.vertexTriangles[outside.nearestVertex];
    const target = toCartesian({ lat: 57.5, lon: 17.5 });

    const warm = locateTriangle(patch.ctx, target, startTriangle);
    const cold = locateTriangle(patch.ctx, target);

    expect(warm).not.toBeNull();
    expect(warm).toEqual(cold);
  });

  it("returns finite, non-negative weights when the query lands on a coincident-duplicate cluster", () => {
    const p = toCartesian({ lat: 57.31, lon: 17.42 });
    const loc = locateTriangle(patch.ctx, p);

    expect(loc).not.toBeNull();
    const { weights } = loc!;
    for (const w of weights) {
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(0);
    }
    expect(Math.abs(weights[0] + weights[1] + weights[2] - 1)).toBeLessThan(
      1e-9,
    );
  });
});

describe("locateTriangle (degenerate triangulations)", () => {
  it("never returns NaN weights when the input contains an exact duplicate point (tour-guide-895a)", () => {
    const points: Point3D[] = [...OCTAHEDRON_POINTS, [1, 0, 0]];
    const ctx = createQueryContext(flattenTriangulation(buildTri(points)));

    const rand = mulberry32(7);
    const queries: { p: Point3D; label: string }[] = [
      { p: [1, 0, 0], label: "duplicated vertex" },
    ];
    for (let i = 0; i < 50; i++) {
      const { lat, lon } = randomLatLon(rand);
      queries.push({ p: toCartesian({ lat, lon }), label: `query ${i}` });
    }

    for (const { p, label } of queries) {
      const loc = locateTriangle(ctx, p);
      expect(loc, label).not.toBeNull();
      const { weights } = loc!;
      for (const w of weights) {
        expect(Number.isFinite(w), label).toBe(true);
        expect(w, label).toBeGreaterThanOrEqual(0);
      }
      expect(
        Math.abs(weights[0] + weights[1] + weights[2] - 1),
        label,
      ).toBeLessThan(1e-9);
    }
  });

  it("locates a query on the Stockholm Float32-quantization fixture (tour-guide-mae)", () => {
    const inputs = [
      { lat: 59.3208, lon: 18.0594 }, // Stockholm A
      { lat: 59.3208, lon: 18.05941 }, // Stockholm B, ~0.07m from A
      { lat: 59.3209, lon: 18.0594 }, // Stockholm C
      { lat: -59.0, lon: -160.0 }, // Antipode
    ];
    const tri = buildTri(inputs.map(toCartesian));
    const fd = quantizeToFloat32(flattenTriangulation(tri));
    const ctx = createQueryContext(fd);
    const p = toCartesian(inputs[0]);

    const loc = locateTriangle(ctx, p);
    const oracle = locateTriangleByScan(ctx, p);

    expect(loc).not.toBeNull();
    expect(oracle).not.toBeNull();
    const { weights } = loc!;
    for (const w of weights) {
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(0);
    }
    expect(Math.abs(weights[0] + weights[1] + weights[2] - 1)).toBeLessThan(
      1e-9,
    );

    const sameTriangle = loc!.triangle === oracle!.triangle;
    const minSide = minSideOfTriangle(fd, loc!.vertices, p);
    expect(sameTriangle || minSide >= -1e-12).toBe(true);
  });
});
