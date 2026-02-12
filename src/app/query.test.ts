import {
  convexHull,
  buildTriangulation,
  serialize,
  deserialize,
} from "../geometry";
import type { Point3D } from "../geometry";
import { NearestQuery, loadQuery } from "./query";

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
  const { tri: restored, articles: restoredArticles } = deserialize(data);
  return new NearestQuery(restored, restoredArticles);
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
    // Query exactly at north pole → should return Point +Z
    const results = nq.findNearest(90, 0);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Point +Z");
    expect(results[0].distanceM).toBeLessThan(1); // essentially zero
  });

  it("finds nearest to interpolated point", () => {
    // Query near +X axis (slightly offset) → should return Point +X
    const results = nq.findNearest(5, 5);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Point +X");
  });

  it("returns k=3 results sorted by ascending distance", () => {
    const results = nq.findNearest(45, 0, 3);
    expect(results).toHaveLength(3);
    // Distances should be sorted ascending
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distanceM).toBeGreaterThanOrEqual(results[i - 1].distanceM);
    }
  });

  it("computes distances in meters correctly", () => {
    const EARTH_RADIUS_M = 6_371_000;
    // Query at north pole → nearest is +Z (distance ≈ 0)
    // The second nearest should be one of the equatorial points at π/2 radians
    const results = nq.findNearest(90, 0, 2);
    expect(results[0].distanceM).toBeLessThan(1);
    // Equatorial points are π/2 radians from pole ≈ 10_007_543 m
    const expectedM = (Math.PI / 2) * EARTH_RADIUS_M;
    expect(Math.abs(results[1].distanceM - expectedM)).toBeLessThan(1000);
  });

  it("returns correct lat/lon in results", () => {
    const results = nq.findNearest(90, 0);
    // North pole: lat ≈ 90, lon ≈ 0
    expect(results[0].lat).toBeCloseTo(90, 0);
  });

  it("walk cache provides spatial locality", () => {
    // Two nearby queries should both return correct results
    // (exercises the lastTriangle cache path)
    const r1 = nq.findNearest(85, 10);
    expect(r1[0].title).toBe("Point +Z");

    const r2 = nq.findNearest(80, 15);
    expect(r2[0].title).toBe("Point +Z");
  });

  it("handles k larger than vertex count", () => {
    const results = nq.findNearest(0, 0, 10);
    // Should return at most 6 results (all vertices)
    expect(results.length).toBeLessThanOrEqual(6);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

describe("loadQuery", () => {
  it("loads from mocked fetch", async () => {
    const points = OCTAHEDRON.map((o) => o.point);
    const hull = convexHull(points);
    const tri = buildTriangulation(hull);
    const articles = OCTAHEDRON.map((o) => ({ title: o.title, desc: o.desc }));
    const data = serialize(tri, articles);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      json: async () => data,
    })) as unknown as typeof fetch;

    try {
      const query = await loadQuery("http://test/triangulation.json");
      expect(query.size).toBe(6);
      const results = query.findNearest(90, 0);
      expect(results[0].title).toBe("Point +Z");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
