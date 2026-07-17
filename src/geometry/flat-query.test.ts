import {
  toCartesian,
  convexHull,
  buildTriangulation,
  flattenTriangulation,
  createQueryContext,
  findNearestVertices,
  createWalkTrace,
  vertexLatLon,
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
