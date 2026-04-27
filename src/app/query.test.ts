import {
  convexHull,
  buildTriangulation,
  serialize,
  serializeBinary,
  deserializeBinary,
  toCartesian,
} from "spherical-delaunay";
import type { Point3D } from "spherical-delaunay";
import { NearestQuery, toFlatDelaunay } from "./query";

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
