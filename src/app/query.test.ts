import {
  convexHull,
  buildTriangulation,
  flattenTriangulation,
  toCartesian,
  createWalkTrace,
} from "spherical-delaunay";
import type { Point3D } from "spherical-delaunay";
import { NearestQuery, EARTH_RADIUS_M } from "./query";
import type { ArticleMeta } from "../article-payload";

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
  const fd = flattenTriangulation(tri);
  // One article per vertex → a singleton group each.
  const groups = OCTAHEDRON.map((o) => [{ title: o.title }]);
  return new NearestQuery(fd, groups);
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
  const fd = flattenTriangulation(tri);
  const groups = tri.originalIndices.map((i) => [
    { title: articles[i].title, weight: articles[i].weight },
  ]);
  return new NearestQuery(fd, groups);
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

// ---------- Coincident-article groups ----------

/** Build a NearestQuery from per-point article groups (weight-desc within). */
function buildGroupedQuery(
  pointGroups: { point: Point3D; group: ArticleMeta[] }[],
): NearestQuery {
  const points = pointGroups.map((p) => p.point);
  const tri = buildTriangulation(convexHull(points));
  const fd = flattenTriangulation(tri);
  const groups = tri.originalIndices.map((i) => pointGroups[i].group);
  return new NearestQuery(fd, groups);
}

describe("NearestQuery (coincident-article groups)", () => {
  // Octahedron whose +Z vertex carries three co-located articles of differing
  // weight — mimicking a venue with several articles at one exact coordinate.
  const pointGroups: { point: Point3D; group: ArticleMeta[] }[] = [
    { point: [1, 0, 0], group: [{ title: "Point +X", weight: 0 }] },
    { point: [-1, 0, 0], group: [{ title: "Point -X", weight: 0 }] },
    { point: [0, 1, 0], group: [{ title: "Point +Y", weight: 0 }] },
    { point: [0, -1, 0], group: [{ title: "Point -Y", weight: 0 }] },
    {
      point: [0, 0, 1],
      group: [
        { title: "Summit museum", weight: 200 },
        { title: "Summit chapel", weight: 80 },
        { title: "Summit marker", weight: 5 },
      ],
    },
    { point: [0, 0, -1], group: [{ title: "Point -Z", weight: 0 }] },
  ];

  it("expands one vertex hit into a result per co-located article", () => {
    const q = buildGroupedQuery(pointGroups);

    // k=1 asks for the single nearest VERTEX (+Z), which expands to 3 results.
    const { results } = q.findNearest(90, 0, 1);

    expect(results.map((r) => r.title)).toEqual([
      "Summit museum",
      "Summit chapel",
      "Summit marker",
    ]);
    // All three share the vertex's coordinate and distance.
    expect(results[0].lat).toBeCloseTo(90, 0);
    expect(results[1].distanceM).toBe(results[0].distanceM);
    expect(results[2].distanceM).toBe(results[0].distanceM);
  });

  it("keeps only group members meeting minWeight, preserving order", () => {
    const q = buildGroupedQuery(pointGroups);

    const { results } = q.findNearest(90, 0, 1, undefined, { minWeight: 50 });

    expect(results.map((r) => r.title)).toEqual([
      "Summit museum",
      "Summit chapel",
    ]);
  });

  it("drops the whole vertex when its representative is below minWeight", () => {
    const q = buildGroupedQuery(pointGroups);

    // 201 exceeds every article's weight, including the +Z representative (200).
    const { results } = q.findNearest(90, 0, 6, undefined, { minWeight: 201 });

    expect(results).toEqual([]);
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
    const fd = flattenTriangulation(tri);
    const groups = [
      [{ title: "Alpha", weight: 5 }],
      [{ title: "Beta", weight: 0 }],
      [{ title: "Gamma", weight: 42 }],
      [{ title: "Delta" }], // no weight → reported as 0
      [{ title: "Epsilon", weight: 255 }],
      [{ title: "Zeta", weight: 17 }],
    ];
    const q = new NearestQuery(fd, groups);

    expect(q.delaunay).toBe(fd);
    expect(q.articleTitle(2)).toBe("Gamma");
    expect(q.articleTitle(3)).toBe("Delta");
    expect(q.articleWeight(0)).toBe(5);
    expect(q.articleWeight(1)).toBe(0);
    expect(q.articleWeight(3)).toBe(0);
    expect(q.articleWeight(4)).toBe(255);
  });
});

// ---------- withinRadius (range scan) ----------

describe("NearestQuery (withinRadius)", () => {
  let ringQ: NearestQuery;

  beforeAll(() => {
    ringQ = buildWeightedQuery(ringArticles());
  });

  it("returns every article inside the radius and nothing outside it", () => {
    // Inner (~1°) and Mid (~2°) rings sit inside a 3° radius from the origin;
    // the Highlight (~5°) ring and the antipodal stub sit outside it.
    const radiusM = 3 * (Math.PI / 180) * EARTH_RADIUS_M;

    const results = ringQ.withinRadius(0, 0, radiusM);

    const expectedTitles = [0, 1, 2, 3, 4, 5].flatMap((i) => [
      `Inner stub ${i}`,
      `Mid stub ${i}`,
    ]);
    expect(results.map((r) => r.title).sort()).toEqual(expectedTitles.sort());
  });

  it("radiusM: Infinity returns the whole tile", () => {
    const results = ringQ.withinRadius(0, 0, Infinity);

    expect(results.map((r) => r.title).sort()).toEqual(
      ringArticles()
        .map((a) => a.title)
        .sort(),
    );
  });

  it("agrees with findNearest filtered to the same radius, on both titles and distances", () => {
    // The strongest guarantee that the range scan is a drop-in for the walk:
    // for the same triangulation and query point, the scan must return
    // exactly the vertices the k-nearest walk would return within that same
    // radius, with matching per-title distances.
    const radiusM = 4 * (Math.PI / 180) * EARTH_RADIUS_M;
    const lat = 1;
    const lon = 1;

    const scanned = ringQ.withinRadius(lat, lon, radiusM);
    const { results: walked } = ringQ.findNearest(lat, lon, ringQ.size);
    const walkedInRadius = walked.filter((r) => r.distanceM <= radiusM);

    expect(scanned.map((r) => r.title).sort()).toEqual(
      walkedInRadius.map((r) => r.title).sort(),
    );

    const scannedByTitle = new Map(scanned.map((r) => [r.title, r]));
    for (const r of walkedInRadius) {
      expect(
        Math.abs(scannedByTitle.get(r.title)!.distanceM - r.distanceM),
      ).toBeLessThan(1e-3); // sub-millimeter — floating-point tolerance, not a real discrepancy
    }
  });

  // Octahedron whose +Z vertex carries three co-located articles of differing
  // weight — mirrors the findNearest coincident-groups fixture above.
  const pointGroups: { point: Point3D; group: ArticleMeta[] }[] = [
    { point: [1, 0, 0], group: [{ title: "Axis +X", weight: 0 }] },
    { point: [-1, 0, 0], group: [{ title: "Axis -X", weight: 0 }] },
    { point: [0, 1, 0], group: [{ title: "Axis +Y", weight: 0 }] },
    { point: [0, -1, 0], group: [{ title: "Axis -Y", weight: 0 }] },
    {
      point: [0, 0, 1],
      group: [
        { title: "Summit museum", weight: 200 },
        { title: "Summit chapel", weight: 80 },
        { title: "Summit marker", weight: 5 },
      ],
    },
    { point: [0, 0, -1], group: [{ title: "Axis -Z", weight: 0 }] },
  ];

  it("returns all co-located articles sharing one vertex, not just the representative", () => {
    const q = buildGroupedQuery(pointGroups);

    // A 1 km radius around the north pole vertex reaches only that vertex —
    // every axis point is thousands of kilometers away.
    const results = q.withinRadius(90, 0, 1000);

    expect(results.map((r) => r.title).sort()).toEqual(
      ["Summit chapel", "Summit marker", "Summit museum"].sort(),
    );
  });

  it("minWeight excludes individual articles below the floor", () => {
    const q = buildGroupedQuery(pointGroups);

    const results = q.withinRadius(90, 0, 1000, 50);

    expect(results.map((r) => r.title).sort()).toEqual(
      ["Summit chapel", "Summit museum"].sort(),
    );
  });
});
