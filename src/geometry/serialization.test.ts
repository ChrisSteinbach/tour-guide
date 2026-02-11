import {
  toCartesian,
  convexHull,
  buildTriangulation,
  sphericalDistance,
  findNearest,
  serialize,
  deserialize,
} from "./index";
import type { Point3D, SphericalDelaunay, ArticleMeta } from "./index";

// ---------- Fixtures ----------

const WORLD_CITIES = [
  { lat: 48.8566, lon: 2.3522, title: "Eiffel Tower", desc: "Paris, France" },
  { lat: 40.7128, lon: -74.006, title: "Statue of Liberty", desc: "New York, USA" },
  { lat: 35.6762, lon: 139.6503, title: "Tokyo Tower", desc: "Tokyo, Japan" },
  { lat: -33.8688, lon: 151.2093, title: "Sydney Opera House", desc: "Sydney, Australia" },
  { lat: 51.5074, lon: -0.1278, title: "Big Ben", desc: "London, UK" },
  { lat: -22.9068, lon: -43.1729, title: "Christ the Redeemer", desc: "Rio de Janeiro, Brazil" },
  { lat: 55.7558, lon: 37.6173, title: "Kremlin", desc: "Moscow, Russia" },
  { lat: 1.3521, lon: 103.8198, title: "Merlion", desc: "Singapore" },
  { lat: -1.2921, lon: 36.8219, title: "Nairobi National Park", desc: "Nairobi, Kenya" },
  { lat: 64.1466, lon: -21.9426, title: "Hallgrímskirkja", desc: "Reykjavik, Iceland" },
];

function buildFixture(): {
  tri: SphericalDelaunay;
  articles: ArticleMeta[];
  points: Point3D[];
} {
  const points = WORLD_CITIES.map((c) => toCartesian({ lat: c.lat, lon: c.lon }));
  const hull = convexHull(points);
  const tri = buildTriangulation(hull);
  const articles = WORLD_CITIES.map((c) => ({ title: c.title, desc: c.desc }));
  return { tri, articles, points };
}

/** Linear scan for ground-truth nearest vertex. */
function bruteForceNearest(tri: SphericalDelaunay, query: Point3D): number {
  let bestIdx = 0;
  let bestDist = sphericalDistance(tri.vertices[0].point, query);
  for (let i = 1; i < tri.vertices.length; i++) {
    const d = sphericalDistance(tri.vertices[i].point, query);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// ---------- serialize ----------

describe("serialize", () => {
  it("produces correct array lengths", () => {
    const { tri, articles } = buildFixture();
    const data = serialize(tri, articles);

    expect(data.vertexCount).toBe(tri.vertices.length);
    expect(data.triangleCount).toBe(tri.triangles.length);
    expect(data.vertices.length).toBe(tri.vertices.length * 3);
    expect(data.vertexTriangles.length).toBe(tri.vertices.length);
    expect(data.triangleVertices.length).toBe(tri.triangles.length * 3);
    expect(data.triangleNeighbors.length).toBe(tri.triangles.length * 3);
    expect(data.articles.length).toBe(tri.vertices.length);
  });

  it("truncates floats to at most 8 decimal places", () => {
    const { tri, articles } = buildFixture();
    const data = serialize(tri, articles);

    for (const v of data.vertices) {
      const s = v.toString();
      const dotIdx = s.indexOf(".");
      if (dotIdx !== -1) {
        expect(s.length - dotIdx - 1).toBeLessThanOrEqual(8);
      }
    }
  });

  it("preserves article metadata", () => {
    const { tri, articles } = buildFixture();
    const data = serialize(tri, articles);

    for (let i = 0; i < articles.length; i++) {
      expect(data.articles[i][0]).toBe(articles[i].title);
      expect(data.articles[i][1]).toBe(articles[i].desc);
    }
  });

  it("throws on article/vertex count mismatch", () => {
    const { tri, articles } = buildFixture();
    expect(() => serialize(tri, articles.slice(0, 5))).toThrow(/count/i);
  });
});

// ---------- deserialize ----------

describe("deserialize", () => {
  it("reconstructs vertex points", () => {
    const { tri, articles } = buildFixture();
    const data = serialize(tri, articles);
    const { tri: restored } = deserialize(data);

    expect(restored.vertices.length).toBe(tri.vertices.length);
    for (let i = 0; i < tri.vertices.length; i++) {
      const orig = tri.vertices[i].point;
      const rest = restored.vertices[i].point;
      // 8-decimal truncation introduces up to ~1e-3 radian error (~6m)
      expect(sphericalDistance(orig, rest)).toBeLessThan(1e-3);
    }
  });

  it("reconstructs vertex triangles", () => {
    const { tri, articles } = buildFixture();
    const data = serialize(tri, articles);
    const { tri: restored } = deserialize(data);

    for (let i = 0; i < tri.vertices.length; i++) {
      expect(restored.vertices[i].triangle).toBe(tri.vertices[i].triangle);
    }
  });

  it("reconstructs triangle vertices and neighbors", () => {
    const { tri, articles } = buildFixture();
    const data = serialize(tri, articles);
    const { tri: restored } = deserialize(data);

    expect(restored.triangles.length).toBe(tri.triangles.length);
    for (let i = 0; i < tri.triangles.length; i++) {
      expect(restored.triangles[i].vertices).toEqual(tri.triangles[i].vertices);
      expect(restored.triangles[i].neighbor).toEqual(tri.triangles[i].neighbor);
    }
  });

  it("reconstructs article metadata", () => {
    const { tri, articles } = buildFixture();
    const data = serialize(tri, articles);
    const { articles: restored } = deserialize(data);

    expect(restored).toEqual(articles);
  });
});

// ---------- round-trip ----------

describe("round-trip", () => {
  it("preserves vertex positions within 1e-3 radians", () => {
    const { tri, articles } = buildFixture();
    const data = serialize(tri, articles);
    const { tri: restored } = deserialize(data);

    for (let i = 0; i < tri.vertices.length; i++) {
      expect(
        sphericalDistance(tri.vertices[i].point, restored.vertices[i].point),
      ).toBeLessThan(1e-3);
    }
  });

  it("preserves triangle topology exactly", () => {
    const { tri, articles } = buildFixture();
    const data = serialize(tri, articles);
    const { tri: restored } = deserialize(data);

    for (let i = 0; i < tri.triangles.length; i++) {
      expect(restored.triangles[i].vertices).toEqual(tri.triangles[i].vertices);
      expect(restored.triangles[i].neighbor).toEqual(tri.triangles[i].neighbor);
    }
  });

  it("findNearest on deserialized data matches brute-force for 50 random queries", () => {
    const { tri, articles } = buildFixture();
    const data = serialize(tri, articles);
    const { tri: restored } = deserialize(data);

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
      const walkResult = findNearest(restored, query);
      const bruteResult = bruteForceNearest(restored, query);
      expect(walkResult).toBe(bruteResult);
    }
  });

  it("survives JSON.parse round-trip", () => {
    const { tri, articles } = buildFixture();
    const data = serialize(tri, articles);
    const json = JSON.stringify(data);
    const parsed = JSON.parse(json);
    const { tri: restored, articles: restoredArticles } = deserialize(parsed);

    expect(restored.vertices.length).toBe(tri.vertices.length);
    expect(restored.triangles.length).toBe(tri.triangles.length);
    expect(restoredArticles).toEqual(articles);

    // Verify findNearest still works after full JSON round-trip
    const query = toCartesian({ lat: 48.5, lon: 2.0 });
    const result = findNearest(restored, query);
    const brute = bruteForceNearest(restored, query);
    expect(result).toBe(brute);
  });
});
