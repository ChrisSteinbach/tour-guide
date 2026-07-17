import {
  convexHull,
  buildTriangulation,
  serialize,
  toCartesian,
  toFlatDelaunay,
  createWalkTrace,
} from "spherical-delaunay";
import type { Point3D } from "spherical-delaunay";
import { NearestQuery } from "./query";

// The query algorithms themselves (locate walk, plateau escape, filtered
// BFS expansion, tracing) are tested in src/geometry/flat-query.test.ts.
// These tests cover the adapter: mapping vertices to titles, weight
// classes, and distances in meters, and the minWeight → filter bridge.

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

// ---------- Weight filtering (minWeight → filter bridge) ----------

const STUB_WEIGHT = 10;
const HIGHLIGHT_WEIGHT = 100;

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

/**
 * Concentric rings around (0,0): two inner rings of low-weight stubs and an
 * outer ring of high-weight highlights, so filtered queries have both
 * matching and non-matching articles to report. An antipodal stub closes
 * the hull.
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

  it("returns only articles meeting minWeight, with their weights", () => {
    const { results } = ringQ.findNearest(0, 0, 3, undefined, {
      minWeight: 50,
    });

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.weight).toBeGreaterThanOrEqual(50);
      expect(r.title).toMatch(/^Highlight/);
    }
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

  it("fills a provided trace whose nearestVertex maps to the returned title", () => {
    const trace = createWalkTrace();
    const { results } = ringQ.findNearest(0.5, 0.5, 1, undefined, { trace });
    expect(trace.locateTriangles.length).toBeGreaterThan(0);
    expect(ringQ.articleTitle(trace.nearestVertex)).toBe(results[0].title);
  });
});

// ---------- Accessors ----------

describe("NearestQuery (accessors)", () => {
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
