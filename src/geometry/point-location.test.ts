import {
  toCartesian,
  normalize,
  sideOfGreatCircle,
  sphericalDistance,
  convexHull,
  buildTriangulation,
} from "./index";
import { locateTriangle, findNearest } from "./point-location";
import type { Point3D, SphericalDelaunay } from "./index";

// ---------- Helpers ----------

function buildTri(points: Point3D[]): SphericalDelaunay {
  return buildTriangulation(convexHull(points));
}

/** Verify query is on the non-negative side of all three edges. */
function triangleContains(
  tri: SphericalDelaunay,
  triIdx: number,
  query: Point3D,
): boolean {
  const t = tri.triangles[triIdx];
  for (let e = 0; e < 3; e++) {
    const a = tri.vertices[t.vertices[e]].point;
    const b = tri.vertices[t.vertices[(e + 1) % 3]].point;
    if (sideOfGreatCircle(a, b, query) < -1e-10) return false;
  }
  return true;
}

/** Linear scan to find the closest vertex — ground truth for comparison. */
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

// ---------- Fixtures ----------

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

// ---------- locateTriangle ----------

describe("locateTriangle", () => {
  describe("octahedron", () => {
    const tri = buildTri(OCTAHEDRON_POINTS);

    it("locates face centers", () => {
      // Each triangle's centroid should be located in that triangle
      for (let ti = 0; ti < tri.triangles.length; ti++) {
        const t = tri.triangles[ti];
        const a = tri.vertices[t.vertices[0]].point;
        const b = tri.vertices[t.vertices[1]].point;
        const c = tri.vertices[t.vertices[2]].point;
        const center = normalize([
          a[0] + b[0] + c[0],
          a[1] + b[1] + c[1],
          a[2] + b[2] + c[2],
        ]);
        const found = locateTriangle(tri, center);
        expect(triangleContains(tri, found, center)).toBe(true);
      }
    });

    it("locates vertices (on edge of multiple triangles)", () => {
      for (const v of tri.vertices) {
        const found = locateTriangle(tri, v.point);
        expect(triangleContains(tri, found, v.point)).toBe(true);
      }
    });

    it("locates edge midpoints", () => {
      const visited = new Set<string>();
      for (const t of tri.triangles) {
        for (let e = 0; e < 3; e++) {
          const ia = t.vertices[e];
          const ib = t.vertices[(e + 1) % 3];
          const key = `${Math.min(ia, ib)}-${Math.max(ia, ib)}`;
          if (visited.has(key)) continue;
          visited.add(key);
          const a = tri.vertices[ia].point;
          const b = tri.vertices[ib].point;
          const mid = normalize([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
          const found = locateTriangle(tri, mid);
          expect(triangleContains(tri, found, mid)).toBe(true);
        }
      }
    });
  });

  describe("walk convergence", () => {
    it("converges from every triangle on octahedron", () => {
      const tri = buildTri(OCTAHEDRON_POINTS);
      const query = normalize([1, 1, 1]);
      for (let start = 0; start < tri.triangles.length; start++) {
        const found = locateTriangle(tri, query, start);
        expect(triangleContains(tri, found, query)).toBe(true);
      }
    });

    it("converges from a distant start on world cities", () => {
      const points = WORLD_CITIES.map(toCartesian);
      const tri = buildTri(points);
      // Query near Paris, start from the triangle of the last vertex (Reykjavik)
      const query = toCartesian({ lat: 48.5, lon: 2.0 });
      const distantStart = tri.vertices[tri.vertices.length - 1].triangle;
      const found = locateTriangle(tri, query, distantStart);
      expect(triangleContains(tri, found, query)).toBe(true);
    });
  });
});

// ---------- findNearest ----------

describe("findNearest", () => {
  describe("octahedron", () => {
    const tri = buildTri(OCTAHEDRON_POINTS);

    it("finds nearest for axis-biased queries", () => {
      // A point biased toward +x should return the +x vertex
      const query = normalize([3, 0.1, 0.1]);
      const nearest = findNearest(tri, query);
      const np = tri.vertices[nearest].point;
      expect(np[0]).toBeCloseTo(1, 5);
      expect(np[1]).toBeCloseTo(0, 5);
      expect(np[2]).toBeCloseTo(0, 5);
    });

    it("finds nearest for exact vertex queries", () => {
      for (let vi = 0; vi < tri.vertices.length; vi++) {
        const nearest = findNearest(tri, tri.vertices[vi].point);
        expect(nearest).toBe(vi);
      }
    });
  });

  describe("world cities", () => {
    const points = WORLD_CITIES.map(toCartesian);
    const tri = buildTri(points);

    it("finds the correct city for nearby queries", () => {
      for (let i = 0; i < WORLD_CITIES.length; i++) {
        // Query slightly offset from each city
        const { lat, lon } = WORLD_CITIES[i];
        const query = toCartesian({ lat: lat + 0.01, lon: lon + 0.01 });
        const nearest = findNearest(tri, query);
        expect(nearest).toBe(i);
      }
    });
  });

  describe("brute-force comparison", () => {
    it("matches brute force on 10 cities with 50 random queries", () => {
      const points = WORLD_CITIES.map(toCartesian);
      const tri = buildTri(points);

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
        const walkResult = findNearest(tri, query);
        const bruteResult = bruteForceNearest(tri, query);
        expect(walkResult).toBe(bruteResult);
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
      const points = allCities.map(toCartesian);
      const tri = buildTri(points);

      let seed = 123;
      function rand(): number {
        seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
        return seed / 0x7fffffff;
      }

      for (let i = 0; i < 100; i++) {
        const lat = rand() * 180 - 90;
        const lon = rand() * 360 - 180;
        const query = toCartesian({ lat, lon });
        const walkResult = findNearest(tri, query);
        const bruteResult = bruteForceNearest(tri, query);
        expect(walkResult).toBe(bruteResult);
      }
    });
  });

  describe("edge cases", () => {
    it("handles north and south pole queries", () => {
      const points = WORLD_CITIES.map(toCartesian);
      const tri = buildTri(points);

      const northPole: Point3D = [0, 0, 1];
      const southPole: Point3D = [0, 0, -1];

      const nearestNorth = findNearest(tri, northPole);
      const nearestSouth = findNearest(tri, southPole);

      // Verify against brute force
      expect(nearestNorth).toBe(bruteForceNearest(tri, northPole));
      expect(nearestSouth).toBe(bruteForceNearest(tri, southPole));
    });

    it("respects explicit startTriangle parameter", () => {
      const points = WORLD_CITIES.map(toCartesian);
      const tri = buildTri(points);
      const query = toCartesian({ lat: 48.5, lon: 2.0 });

      // Should return the same result regardless of start
      const fromDefault = findNearest(tri, query);
      const fromExplicit = findNearest(tri, query, tri.triangles.length - 1);
      expect(fromExplicit).toBe(fromDefault);
    });
  });
});
