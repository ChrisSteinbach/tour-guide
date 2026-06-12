import {
  convexHull,
  buildTriangulation,
  serialize,
  serializeBinary,
  deserializeBinary,
  toCartesian,
} from "../geometry";
import type { Point3D } from "../geometry";
import {
  NearestQuery,
  toFlatDelaunay,
  createWalkTrace,
  vertexLatLon,
} from "./query";

// ---------- Fixtures ----------

/** 6 axis-aligned points forming an octahedron */
const OCTAHEDRON: { point: Point3D; title: string }[] = [
  { point: [1, 0, 0], title: "Point +X" },
  { point: [-1, 0, 0], title: "Point -X" },
  { point: [0, 1, 0], title: "Point +Y" },
  { point: [0, -1, 0], title: "Point -Y" },
  { point: [0, 0, 1], title: "Point +Z" },
  { point: [0, 0, -1], title: "Point -Z" },
];

function buildNearestQuery(): NearestQuery {
  const points = OCTAHEDRON.map((o) => o.point);
  const hull = convexHull(points);
  const tri = buildTriangulation(hull);
  const articles = OCTAHEDRON.map((o) => ({ title: o.title }));
  const data = serialize(tri, articles);
  const fd = toFlatDelaunay(data);
  const metas = data.articles.map((title) => ({ title }));
  return new NearestQuery(fd, metas);
}

// Build once, share across tests
let nq: NearestQuery;

beforeAll(() => {
  nq = buildNearestQuery();
});

// ---------- Tests ----------

describe("NearestQuery", () => {
  it("has correct size", () => {
    expect(nq.size).toBe(6);
  });

  it("finds nearest to axis point", () => {
    const { results } = nq.findNearest(90, 0);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Point +Z");
    expect(results[0].distanceM).toBeLessThan(1);
  });

  it("finds nearest to interpolated point", () => {
    const { results } = nq.findNearest(5, 5);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Point +X");
  });

  it("returns k=3 results sorted by ascending distance", () => {
    const { results } = nq.findNearest(45, 0, 3);
    expect(results).toHaveLength(3);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distanceM).toBeGreaterThanOrEqual(
        results[i - 1].distanceM,
      );
    }
  });

  it("computes distances in meters correctly", () => {
    const EARTH_RADIUS_M = 6_371_000;
    const { results } = nq.findNearest(90, 0, 2);
    expect(results[0].distanceM).toBeLessThan(1);
    const expectedM = (Math.PI / 2) * EARTH_RADIUS_M;
    expect(Math.abs(results[1].distanceM - expectedM)).toBeLessThan(1000);
  });

  it("returns correct lat/lon in results", () => {
    const { results } = nq.findNearest(90, 0);
    expect(results[0].lat).toBeCloseTo(90, 0);
  });

  it("handles k larger than vertex count", () => {
    const { results } = nq.findNearest(0, 0, 10);
    expect(results.length).toBeLessThanOrEqual(6);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("returns lastTriangle for warm-start", () => {
    const { lastTriangle } = nq.findNearest(90, 0);
    expect(typeof lastTriangle).toBe("number");
    expect(lastTriangle).toBeGreaterThanOrEqual(0);
  });

  it("reports weight 0 for articles without weight data", () => {
    const { results } = nq.findNearest(90, 0);
    expect(results[0].weight).toBe(0);
  });
});

describe("NearestQuery (degenerate triangulation)", () => {
  /**
   * Regression test: near-duplicate vertices (from Float32 quantization of
   * very close coordinates) can create degenerate triangles where the
   * triangle walk loops forever. The fix detects cycles and falls back
   * to brute-force search. Reproduces the Stockholm bug (tour-guide-mae).
   */
  it("finds nearest vertex when triangle walk hits a cycle", () => {
    // Create a triangulation with near-duplicate vertices that will
    // produce degenerate triangles after Float32 round-trip
    const articles = [
      { lat: 59.3208, lon: 18.0594, title: "Stockholm A" },
      { lat: 59.3208, lon: 18.05941, title: "Stockholm B" }, // ~0.07m from A
      { lat: 59.3209, lon: 18.0594, title: "Stockholm C" },
      { lat: -59.0, lon: -160.0, title: "Antipode" },
    ];

    const points = articles.map((a) => toCartesian({ lat: a.lat, lon: a.lon }));
    const hull = convexHull(points);
    const tri = buildTriangulation(hull);
    const metas = tri.originalIndices.map((i) => ({
      title: articles[i].title,
    }));
    const data = serialize(tri, metas);

    // Round-trip through Float32 binary to trigger near-duplicates
    const bin = serializeBinary(data);
    const { fd, articles: roundTripped } = deserializeBinary(bin);
    const query = new NearestQuery(fd, roundTripped);

    // Query from Stockholm — should find a nearby article, not diverge
    const { results } = query.findNearest(59.3208, 18.0594);
    expect(results[0].distanceM).toBeLessThan(100);
    expect(results[0].title).toMatch(/^Stockholm/);
  });
});

describe("NearestQuery (Float32 round-trip)", () => {
  /**
   * Regression test: the binary format stores vertex coordinates as Float32.
   * With dot-product distance (acos(dot)), nearby points (<~4 km) in the
   * same region would all collapse to 0 m because Float32 rounding error
   * exceeds (1 − dot).  The chord-length formula avoids this.
   */
  it("distinguishes nearby points after Float32 quantisation", () => {
    // Three articles within ~1 km of each other in Stockholm
    const nearby = [
      { lat: 59.308, lon: 18.028, title: "A" },
      { lat: 59.315, lon: 18.039, title: "B" },
      { lat: 59.315, lon: 18.019, title: "C" },
      // Need ≥4 points for convex hull — add antipodal point
      { lat: -59.31, lon: -161.97, title: "Far" },
    ];

    const points = nearby.map((a) => toCartesian({ lat: a.lat, lon: a.lon }));
    const hull = convexHull(points);
    const tri = buildTriangulation(hull);
    const articles = tri.originalIndices.map((i) => ({
      title: nearby[i].title,
    }));
    const data = serialize(tri, articles);

    // Round-trip through binary (Float32) format
    const bin = serializeBinary(data);
    const { fd, articles: metas } = deserializeBinary(bin);
    const query = new NearestQuery(fd, metas);

    // Query from point A's location — should find A as nearest, not B or C
    const { results } = query.findNearest(59.308, 18.028, 3);
    expect(results[0].title).toBe("A");
    expect(results[0].distanceM).toBeLessThan(10); // essentially 0 after quantisation
    // B and C should be ~900–1000 m away, definitely not 0
    expect(results[1].distanceM).toBeGreaterThan(500);
    expect(results[2].distanceM).toBeGreaterThan(500);
  });
});

// ---------- Patch tiles (out-of-cap queries) ----------

/**
 * Build a tile-like NearestQuery: a jittered grid of points covering a
 * single 5°×5°-ish patch of the sphere (like a production tile, including
 * the Float32 binary round-trip), with a few coincident-duplicate clusters
 * mimicking bot-generated articles that share one coordinate.
 *
 * Unlike the full-sphere fixtures above, the convex hull of a patch is a
 * thin lens whose underside ("back closure") gives the locate walk no
 * containing triangle for queries outside the patch — the regression area
 * for tour-guide-8lmb.
 */
function buildPatchQuery(): NearestQuery {
  const articles: { lat: number; lon: number; title: string }[] = [];
  const south = 55;
  const west = 15;
  const n = 24;
  const step = 5 / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // Deterministic jitter, ±20% of a cell — irregular but reproducible.
      const jLat = 0.2 * step * Math.sin(i * 12.9898 + j * 78.233);
      const jLon = 0.2 * step * Math.sin(i * 39.346 + j * 11.135);
      articles.push({
        lat: south + (i + 0.5) * step + jLat,
        lon: west + (j + 0.5) * step + jLon,
        title: `P${i}-${j}`,
      });
    }
  }
  // Coincident duplicates: several articles at exactly the same coordinate
  // (Float32 quantization makes them identical vertices in the data).
  for (const [lat, lon, name] of [
    [57.31, 17.42, "DupA"],
    [55.87, 16.11, "DupB"],
    [59.13, 19.55, "DupC"],
  ] as const) {
    for (let c = 0; c < 5; c++) {
      articles.push({ lat, lon, title: `${name}-${c}` });
    }
  }

  const points = articles.map((a) => toCartesian({ lat: a.lat, lon: a.lon }));
  const hull = convexHull(points);
  const tri = buildTriangulation(hull);
  const metas = tri.originalIndices.map((i) => ({
    title: articles[i].title,
  }));
  const data = serialize(tri, metas);
  const bin = serializeBinary(data);
  const { fd, articles: roundTripped } = deserializeBinary(bin);
  return new NearestQuery(fd, roundTripped);
}

/** Exact nearest distance in meters by scanning every vertex. */
function bruteNearestM(nq: NearestQuery, lat: number, lon: number): number {
  const [qx, qy, qz] = toCartesian({ lat, lon });
  const vp = nq.delaunay.vertexPoints;
  let best = Infinity;
  for (let v = 0; v < nq.size; v++) {
    const dx = vp[v * 3] - qx;
    const dy = vp[v * 3 + 1] - qy;
    const dz = vp[v * 3 + 2] - qz;
    const chord = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const d = 2 * Math.asin(chord < 2 ? chord / 2 : 1) * 6_371_000;
    if (d < best) best = d;
  }
  return best;
}

describe("NearestQuery (patch tile, queries outside the patch)", () => {
  let patchQ: NearestQuery;

  beforeAll(() => {
    patchQ = buildPatchQuery();
  });

  it("finds the exact nearest article for queries outside the patch on every side", () => {
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
      const { results } = patchQ.findNearest(lat, lon);
      expect(results).toHaveLength(1);
      // Compare distances, not titles: coincident duplicates tie exactly.
      expect(results[0].distanceM).toBeCloseTo(
        bruteNearestM(patchQ, lat, lon),
        6,
      );
    }
  });

  it("terminates out-of-patch walks in bounded hops without brute force", () => {
    const trace = createWalkTrace();
    patchQ.findNearest(61.0, 17.5, 1, undefined, { trace });

    // The pre-fix walk either orbited the hull's back closure until
    // maxSteps (≈ triangle count, >1000 here) or fell back to an O(V)
    // brute-force scan. The patience rule stops it shortly after it has
    // passed the rim vertices nearest the query.
    expect(trace.usedBruteForce).toBe(false);
    expect(trace.locateTriangles.length).toBeLessThan(300);
  });

  it("keeps out-of-patch walk traces off tile-spanning back-closure chords", () => {
    // The hull's underside triangulates the rim with chords that can span
    // the whole patch. A walk that slides across them paints tile-wide
    // streaks in the X-ray overlay, so they are walled off; the walk slides
    // along the rim's narrow front triangles instead. The probe sits south
    // of the patch: on the equatorward rim every wide facet is an underside
    // chord. (Poleward rims also own wide FRONT facets — great-circle
    // chords bulge poleward of the small-circle rim line — and the walk is
    // allowed to cross those.)
    const trace = createWalkTrace();
    patchQ.findNearest(54.0, 17.5, 1, undefined, { trace });

    const fd = patchQ.delaunay;
    let maxLonSpan = 0;
    for (const t of trace.locateTriangles) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < 3; i++) {
        const { lon } = vertexLatLon(fd, fd.triangleVertices[t * 3 + i]);
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
      const { results } = patchQ.findNearest(lat, lon);
      expect(results[0].distanceM).toBeCloseTo(
        bruteNearestM(patchQ, lat, lon),
        6,
      );
    }
  });

  it("returns the exact nearest when it is a coincident-duplicate cluster", () => {
    // Query right next to the DupA cluster: greedy descent must not stall
    // on a cluster vertex whose only equal-distance neighbors are its
    // twins (the plateau is tunneled through).
    const { results } = patchQ.findNearest(57.312, 17.423, 3);
    expect(results[0].title).toMatch(/^DupA/);
    expect(results[0].distanceM).toBeCloseTo(
      bruteNearestM(patchQ, 57.312, 17.423),
      6,
    );
  });

  it("recovers exact answers from a warm start taken outside the patch", () => {
    // An out-of-patch query's lastTriangle can sit on the hull's back
    // closure, where edge tests are flipped. A later query warm-started
    // from it must still answer exactly (the walk restarts from its
    // anchor when the start strands).
    const outside = patchQ.findNearest(61.0, 17.5);
    const warm = patchQ.findNearest(57.5, 17.5, 1, outside.lastTriangle);
    expect(warm.results[0].distanceM).toBeCloseTo(
      bruteNearestM(patchQ, 57.5, 17.5),
      6,
    );
  });
});

// ---------- Weight filtering ----------

/** Build a NearestQuery from weighted lat/lon articles. */
function buildWeightedQuery(
  articles: { title: string; lat: number; lon: number; weight: number }[],
): NearestQuery {
  const points = articles.map((a) => toCartesian({ lat: a.lat, lon: a.lon }));
  const hull = convexHull(points);
  const tri = buildTriangulation(hull);
  const meta = tri.originalIndices.map((i) => ({
    title: articles[i].title,
    weight: articles[i].weight,
  }));
  const data = serialize(tri, meta);
  const fd = toFlatDelaunay(data);
  const metas = data.articles.map((title, i) => ({
    title,
    weight: data.weights[i],
  }));
  return new NearestQuery(fd, metas);
}

const STUB_WEIGHT = 10;
const HIGHLIGHT_WEIGHT = 100;

/**
 * Concentric rings around (0,0): two inner rings of low-weight stubs
 * (12 vertices, every one of them nearer than any highlight) and an outer
 * ring of high-weight highlights. The nearest matches sit behind a wall of
 * stubs, so a filtered query must expand through non-matching vertices.
 * An antipodal stub closes the hull.
 */
function ringArticles(): {
  title: string;
  lat: number;
  lon: number;
  weight: number;
}[] {
  const articles: {
    title: string;
    lat: number;
    lon: number;
    weight: number;
  }[] = [];
  const ring = (
    radiusDeg: number,
    offsetDeg: number,
    titlePrefix: string,
    weight: number,
  ) => {
    for (let i = 0; i < 6; i++) {
      const angle = ((i * 60 + offsetDeg) * Math.PI) / 180;
      articles.push({
        title: `${titlePrefix} ${i}`,
        lat: Math.sin(angle) * radiusDeg,
        lon: Math.cos(angle) * radiusDeg,
        weight,
      });
    }
  };
  ring(1, 0, "Inner stub", STUB_WEIGHT);
  ring(2, 30, "Mid stub", STUB_WEIGHT);
  ring(5, 0, "Highlight", HIGHLIGHT_WEIGHT);
  articles.push({
    title: "Antipode stub",
    lat: 0,
    lon: 180,
    weight: STUB_WEIGHT,
  });
  return articles;
}

describe("NearestQuery (weight filtering)", () => {
  let ringQ: NearestQuery;

  beforeAll(() => {
    ringQ = buildWeightedQuery(ringArticles());
  });

  it("returns only articles meeting minWeight, sorted by distance", () => {
    const { results } = ringQ.findNearest(0, 0, 3, undefined, {
      minWeight: 50,
    });

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.weight).toBeGreaterThanOrEqual(50);
      expect(r.title).toMatch(/^Highlight/);
    }
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distanceM).toBeGreaterThanOrEqual(
        results[i - 1].distanceM,
      );
    }
  });

  it("expands through a wall of low-weight vertices to reach matches beyond it", () => {
    // Sanity: the 12 nearest articles are all stubs — every path from the
    // query to a highlight crosses non-matching vertices.
    const { results: unfiltered } = ringQ.findNearest(0, 0, 12);
    expect(unfiltered).toHaveLength(12);
    expect(unfiltered.every((r) => r.weight === STUB_WEIGHT)).toBe(true);

    // The filtered query must traverse the stub wall to find a highlight.
    // The walk's nearest vertex (an inner stub) seeds the frontier but is
    // not returned.
    const { results } = ringQ.findNearest(0, 0, 1, undefined, {
      minWeight: 50,
    });
    expect(results).toHaveLength(1);
    expect(results[0].title).toMatch(/^Highlight/);
  });

  it("returns all matches found when fewer than k satisfy the filter", () => {
    const { results } = ringQ.findNearest(0, 0, 10, undefined, {
      minWeight: 50,
    });

    expect(results).toHaveLength(6); // the fixture has exactly 6 highlights
    expect(results.every((r) => r.title.startsWith("Highlight"))).toBe(true);
  });

  it("returns empty results when no article meets the threshold", () => {
    const { results } = ringQ.findNearest(0, 0, 3, undefined, {
      minWeight: HIGHLIGHT_WEIGHT + 1,
    });

    expect(results).toEqual([]);
  });

  it("returns the same lastTriangle as an unfiltered query", () => {
    const unfiltered = ringQ.findNearest(0.5, 0.5, 3);
    const filtered = ringQ.findNearest(0.5, 0.5, 3, undefined, {
      minWeight: 50,
    });

    expect(filtered.lastTriangle).toBe(unfiltered.lastTriangle);
  });

  it("includes the article weight on unfiltered results", () => {
    const { results } = ringQ.findNearest(0, 0, 1);
    expect(results[0].weight).toBe(STUB_WEIGHT);
  });
});

describe("NearestQuery (filtered visit cap)", () => {
  /**
   * 5000 quasi-uniform vertices (Fibonacci sphere). All are low-weight
   * stubs except the one at the south pole. Queried from the north pole,
   * the lone match lies beyond the FILTERED_VISIT_FLOOR (4096) horizon —
   * the cap bounds the scan instead of crawling the whole sphere.
   */
  const VERTEX_COUNT = 5000;
  let sphereQ: NearestQuery;

  beforeAll(() => {
    const golden = Math.PI * (3 - Math.sqrt(5));
    const articles = Array.from({ length: VERTEX_COUNT }, (_, i) => {
      const z = 1 - (i / (VERTEX_COUNT - 1)) * 2; // 1 (north) → -1 (south)
      const theta = golden * i;
      return {
        title: `P${i}`,
        lat: (Math.asin(z) * 180) / Math.PI,
        lon: (Math.atan2(Math.sin(theta), Math.cos(theta)) * 180) / Math.PI,
        weight: i === VERTEX_COUNT - 1 ? HIGHLIGHT_WEIGHT : STUB_WEIGHT,
      };
    });
    sphereQ = buildWeightedQuery(articles);
  });

  it("stops scanning at the visit cap when matches are out of reach", () => {
    // From the north pole, the only highlight (south pole) sits ~900
    // vertices beyond the 4096-vertex budget: empty result, bounded work.
    const { results } = sphereQ.findNearest(90, 0, 1, undefined, {
      minWeight: 50,
    });

    expect(results).toEqual([]);

    // Contrast: a larger k raises the budget (64 * k > vertex count), so
    // the same query reaches the south pole — proving the empty result
    // above came from the cap, not from the match being unreachable.
    const { results: uncapped } = sphereQ.findNearest(90, 0, 80, undefined, {
      minWeight: 50,
    });
    expect(uncapped.map((r) => r.title)).toEqual([`P${VERTEX_COUNT - 1}`]);
  });

  it("finds a sparse match that lies within the visit budget", () => {
    const { results } = sphereQ.findNearest(-89, 0, 1, undefined, {
      minWeight: 50,
    });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe(`P${VERTEX_COUNT - 1}`);
  });
});

// ---------- Walk tracing ----------

/**
 * Quasi-uniform Fibonacci sphere of weighted vertices: every 5th vertex is a
 * highlight, the rest stubs. Dense enough to exercise multi-step descents and
 * BFS expansion, weighted so minWeight-filtered queries have matches to find.
 */
function buildTracedSphereQuery(count: number): NearestQuery {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const articles = Array.from({ length: count }, (_, i) => {
    const z = 1 - (i / (count - 1)) * 2;
    const theta = golden * i;
    return {
      title: `T${i}`,
      lat: (Math.asin(z) * 180) / Math.PI,
      lon: (Math.atan2(Math.sin(theta), Math.cos(theta)) * 180) / Math.PI,
      weight: i % 5 === 0 ? HIGHLIGHT_WEIGHT : STUB_WEIGHT,
    };
  });
  return buildWeightedQuery(articles);
}

/** Squared chord length from a vertex to a cartesian query point. */
function chordSqToQuery(nq: NearestQuery, vertex: number, q: Point3D): number {
  const vp = nq.delaunay.vertexPoints;
  const vi = vertex * 3;
  const dx = vp[vi] - q[0];
  const dy = vp[vi + 1] - q[1];
  const dz = vp[vi + 2] - q[2];
  return dx * dx + dy * dy + dz * dz;
}

describe("NearestQuery (walk tracing)", () => {
  let traceQ: NearestQuery;

  beforeAll(() => {
    traceQ = buildTracedSphereQuery(400);
  });

  it("returns identical results for an unfiltered k=1 query with and without a trace", () => {
    const without = traceQ.findNearest(12, 34);
    const with_ = traceQ.findNearest(12, 34, 1, undefined, {
      trace: createWalkTrace(),
    });
    expect(with_.results).toEqual(without.results);
    expect(with_.lastTriangle).toBe(without.lastTriangle);
  });

  it("returns identical results for a k=5 query with and without a trace", () => {
    const without = traceQ.findNearest(12, 34, 5);
    const with_ = traceQ.findNearest(12, 34, 5, undefined, {
      trace: createWalkTrace(),
    });
    expect(with_.results).toEqual(without.results);
    expect(with_.lastTriangle).toBe(without.lastTriangle);
  });

  it("returns identical results for a minWeight-filtered query with and without a trace", () => {
    const without = traceQ.findNearest(12, 34, 5, undefined, { minWeight: 50 });
    const with_ = traceQ.findNearest(12, 34, 5, undefined, {
      minWeight: 50,
      trace: createWalkTrace(),
    });
    expect(with_.results).toEqual(without.results);
    expect(with_.lastTriangle).toBe(without.lastTriangle);
  });

  it("records a nearestVertex whose title matches the returned nearest", () => {
    const trace = createWalkTrace();
    const { results } = traceQ.findNearest(40, -75, 1, undefined, { trace });
    expect(traceQ.articleTitle(trace.nearestVertex)).toBe(results[0].title);
  });

  it("records a descent with monotonically non-increasing distance to the query", () => {
    const trace = createWalkTrace();
    const q = toCartesian({ lat: -20, lon: 140 });
    traceQ.findNearest(-20, 140, 1, undefined, { trace });

    expect(trace.descentVertices.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < trace.descentVertices.length; i++) {
      const prev = chordSqToQuery(traceQ, trace.descentVertices[i - 1], q);
      const cur = chordSqToQuery(traceQ, trace.descentVertices[i], q);
      expect(cur).toBeLessThanOrEqual(prev);
    }
    // The descent ends at the recorded nearest vertex.
    expect(trace.descentVertices[trace.descentVertices.length - 1]).toBe(
      trace.nearestVertex,
    );
  });

  it("records BFS vertices with no duplicates, excluding the seed", () => {
    const trace = createWalkTrace();
    traceQ.findNearest(12, 34, 8, undefined, { trace });

    expect(trace.bfsVertices.length).toBeGreaterThan(0);
    expect(new Set(trace.bfsVertices).size).toBe(trace.bfsVertices.length);
    // The seed (the unfiltered nearest vertex) is never re-emitted.
    expect(trace.bfsVertices).not.toContain(trace.nearestVertex);
  });

  it("leaves bfsVertices empty for a plain k=1 query", () => {
    const trace = createWalkTrace();
    traceQ.findNearest(12, 34, 1, undefined, { trace });
    expect(trace.bfsVertices).toEqual([]);
  });

  it("records a non-empty locate walk ending in an in-range triangle", () => {
    const trace = createWalkTrace();
    traceQ.findNearest(12, 34, 1, undefined, { trace });

    expect(trace.locateTriangles.length).toBeGreaterThan(0);
    const finalTri = trace.locateTriangles[trace.locateTriangles.length - 1];
    const tv = traceQ.delaunay.triangleVertices;
    for (let e = 0; e < 3; e++) {
      const v = tv[finalTri * 3 + e];
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(traceQ.size);
    }
    expect(trace.usedBruteForce).toBe(false);
  });

  it("round-trips vertexLatLon through toCartesian", () => {
    const fd = traceQ.delaunay;
    for (const v of [0, 7, 100, 399]) {
      const { lat, lon } = vertexLatLon(fd, v);
      const [x, y, z] = toCartesian({ lat, lon });
      const vi = v * 3;
      // Vertices are stored truncated to 8 decimals, so they sit a hair off
      // the unit sphere; the round-trip renormalizes within ~1e-8.
      expect(x).toBeCloseTo(fd.vertexPoints[vi], 7);
      expect(y).toBeCloseTo(fd.vertexPoints[vi + 1], 7);
      expect(z).toBeCloseTo(fd.vertexPoints[vi + 2], 7);
    }
  });

  it("exposes the delaunay, titles, and weights the constructor was given", () => {
    const points: Point3D[] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    const tri = buildTriangulation(convexHull(points));
    const fd = toFlatDelaunay(
      serialize(
        tri,
        tri.originalIndices.map((i) => ({ title: `placeholder ${i}` })),
      ),
    );
    const articles = [
      { title: "Alpha", weight: 5 },
      { title: "Beta", weight: 0 },
      { title: "Gamma", weight: 42 },
      { title: "Delta" }, // no weight → reported as 0
      { title: "Epsilon", weight: 255 },
      { title: "Zeta", weight: 17 },
    ];
    const q = new NearestQuery(fd, articles);

    expect(q.delaunay).toBe(fd);
    expect(q.articleTitle(2)).toBe("Gamma");
    expect(q.articleTitle(3)).toBe("Delta");
    expect(q.articleWeight(0)).toBe(5);
    expect(q.articleWeight(1)).toBe(0);
    expect(q.articleWeight(3)).toBe(0);
    expect(q.articleWeight(4)).toBe(255);
  });
});
