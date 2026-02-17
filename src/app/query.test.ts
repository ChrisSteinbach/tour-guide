import {
  convexHull,
  buildTriangulation,
  serialize,
  serializeBinary,
  deserializeBinary,
  toCartesian,
} from "../geometry";
import type { Point3D } from "../geometry";
import { NearestQuery, loadQuery, toFlatDelaunay } from "./query";

// ---------- Fixtures ----------

/** 6 axis-aligned points forming an octahedron */
const OCTAHEDRON: { point: Point3D; title: string; desc: string }[] = [
  { point: [1, 0, 0], title: "Point +X", desc: "equator prime meridian" },
  { point: [-1, 0, 0], title: "Point -X", desc: "equator antimeridian" },
  { point: [0, 1, 0], title: "Point +Y", desc: "equator 90E" },
  { point: [0, -1, 0], title: "Point -Y", desc: "equator 90W" },
  { point: [0, 0, 1], title: "Point +Z", desc: "north pole" },
  { point: [0, 0, -1], title: "Point -Z", desc: "south pole" },
];

function buildNearestQuery(): NearestQuery {
  const points = OCTAHEDRON.map((o) => o.point);
  const hull = convexHull(points);
  const tri = buildTriangulation(hull);
  const articles = OCTAHEDRON.map((o) => ({ title: o.title, desc: o.desc }));
  const data = serialize(tri, articles);
  const fd = toFlatDelaunay(data);
  const metas = data.articles.map(([title, desc]) => ({ title, desc }));
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
    const results = nq.findNearest(90, 0);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Point +Z");
    expect(results[0].distanceM).toBeLessThan(1);
  });

  it("finds nearest to interpolated point", () => {
    const results = nq.findNearest(5, 5);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Point +X");
  });

  it("returns k=3 results sorted by ascending distance", () => {
    const results = nq.findNearest(45, 0, 3);
    expect(results).toHaveLength(3);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distanceM).toBeGreaterThanOrEqual(results[i - 1].distanceM);
    }
  });

  it("computes distances in meters correctly", () => {
    const EARTH_RADIUS_M = 6_371_000;
    const results = nq.findNearest(90, 0, 2);
    expect(results[0].distanceM).toBeLessThan(1);
    const expectedM = (Math.PI / 2) * EARTH_RADIUS_M;
    expect(Math.abs(results[1].distanceM - expectedM)).toBeLessThan(1000);
  });

  it("returns correct lat/lon in results", () => {
    const results = nq.findNearest(90, 0);
    expect(results[0].lat).toBeCloseTo(90, 0);
  });

  it("walk cache provides spatial locality", () => {
    const r1 = nq.findNearest(85, 10);
    expect(r1[0].title).toBe("Point +Z");

    const r2 = nq.findNearest(80, 15);
    expect(r2[0].title).toBe("Point +Z");
  });

  it("handles k larger than vertex count", () => {
    const results = nq.findNearest(0, 0, 10);
    expect(results.length).toBeLessThanOrEqual(6);
    expect(results.length).toBeGreaterThanOrEqual(1);
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
      { lat: 59.308, lon: 18.028, title: "A", desc: "" },
      { lat: 59.315, lon: 18.039, title: "B", desc: "" },
      { lat: 59.315, lon: 18.019, title: "C", desc: "" },
      // Need ≥4 points for convex hull — add antipodal point
      { lat: -59.31, lon: -161.97, title: "Far", desc: "" },
    ];

    const points = nearby.map((a) => toCartesian({ lat: a.lat, lon: a.lon }));
    const hull = convexHull(points);
    const tri = buildTriangulation(hull);
    const articles = tri.originalIndices.map((i) => ({
      title: nearby[i].title,
      desc: nearby[i].desc,
    }));
    const data = serialize(tri, articles);

    // Round-trip through binary (Float32) format
    const bin = serializeBinary(data);
    const { fd, articles: metas } = deserializeBinary(bin);
    const query = new NearestQuery(fd, metas);

    // Query from point A's location — should find A as nearest, not B or C
    const results = query.findNearest(59.308, 18.028, 3);
    expect(results[0].title).toBe("A");
    expect(results[0].distanceM).toBeLessThan(10); // essentially 0 after quantisation
    // B and C should be ~900–1000 m away, definitely not 0
    expect(results[1].distanceM).toBeGreaterThan(500);
    expect(results[2].distanceM).toBeGreaterThan(500);
  });
});

describe("loadQuery", () => {
  it("loads from mocked fetch (binary)", async () => {
    const points = OCTAHEDRON.map((o) => o.point);
    const hull = convexHull(points);
    const tri = buildTriangulation(hull);
    const articles = OCTAHEDRON.map((o) => ({ title: o.title, desc: o.desc }));
    const data = serialize(tri, articles);
    const binData = serializeBinary(data);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => binData,
    })) as unknown as typeof fetch;

    try {
      const query = await loadQuery("http://test/triangulation.bin");
      expect(query.size).toBe(6);
      const results = query.findNearest(90, 0);
      expect(results[0].title).toBe("Point +Z");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
