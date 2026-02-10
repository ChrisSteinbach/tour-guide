import { buildTriangulation } from "./delaunay";
import type { SphericalDelaunay } from "./delaunay";
import { convexHull, sphericalDistance, toCartesian, vecLength } from "./index";
import type { Point3D } from "./index";

// ---------- Structural invariant validator ----------

function validateTriangulation(tri: SphericalDelaunay) {
  const { vertices, triangles } = tri;
  const nT = triangles.length;
  const nV = vertices.length;

  // All vertex indices in range
  for (let ti = 0; ti < nT; ti++) {
    for (const vi of triangles[ti].vertices) {
      expect(vi).toBeGreaterThanOrEqual(0);
      expect(vi).toBeLessThan(nV);
    }
  }

  // No degenerate triangles (3 distinct vertices)
  for (let ti = 0; ti < nT; ti++) {
    const [a, b, c] = triangles[ti].vertices;
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  }

  // All neighbor indices in range
  for (let ti = 0; ti < nT; ti++) {
    for (const ni of triangles[ti].neighbor) {
      expect(ni).toBeGreaterThanOrEqual(0);
      expect(ni).toBeLessThan(nT);
    }
  }

  // Adjacency symmetry
  for (let ti = 0; ti < nT; ti++) {
    const t = triangles[ti];
    for (let e = 0; e < 3; e++) {
      const ni = t.neighbor[e];
      const edgeA = t.vertices[e];
      const edgeB = t.vertices[(e + 1) % 3];

      const nt = triangles[ni];
      let found = false;
      for (let ne = 0; ne < 3; ne++) {
        if (nt.vertices[ne] === edgeB && nt.vertices[(ne + 1) % 3] === edgeA) {
          expect(nt.neighbor[ne]).toBe(ti);
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    }
  }

  // Every vertex's triangle field points to a triangle that includes that vertex
  for (let vi = 0; vi < nV; vi++) {
    const ti = vertices[vi].triangle;
    if (ti === -1) continue; // point not on hull (interior)
    expect(ti).toBeGreaterThanOrEqual(0);
    expect(ti).toBeLessThan(nT);
    const verts = triangles[ti].vertices;
    expect(verts).toContain(vi);
  }

  // Circumcenters on unit sphere (length ≈ 1)
  for (let ti = 0; ti < nT; ti++) {
    const len = vecLength(triangles[ti].circumcenter);
    expect(len).toBeCloseTo(1, 10);
  }

  // Circumradii positive
  for (let ti = 0; ti < nT; ti++) {
    expect(triangles[ti].circumradius).toBeGreaterThan(0);
  }

  // Circumcenters equidistant from all 3 vertices (within tolerance)
  for (let ti = 0; ti < nT; ti++) {
    const t = triangles[ti];
    const da = sphericalDistance(t.circumcenter, vertices[t.vertices[0]].point);
    const db = sphericalDistance(t.circumcenter, vertices[t.vertices[1]].point);
    const dc = sphericalDistance(t.circumcenter, vertices[t.vertices[2]].point);
    expect(da).toBeCloseTo(t.circumradius, 10);
    expect(db).toBeCloseTo(t.circumradius, 10);
    expect(dc).toBeCloseTo(t.circumradius, 10);
  }

  // Euler: F = 2V - 4 (count only vertices that appear in triangles)
  const usedVertices = new Set(triangles.flatMap((t) => t.vertices));
  expect(nT).toBe(2 * usedVertices.size - 4);
}

// ---------- Test cases ----------

describe("buildTriangulation", () => {
  describe("octahedron (6 axis points)", () => {
    const points: Point3D[] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];

    it("produces 8 triangles with correct structure", () => {
      const hull = convexHull(points);
      const tri = buildTriangulation(hull);
      expect(tri.triangles.length).toBe(8);
      expect(tri.vertices.length).toBe(6);
      validateTriangulation(tri);
    });

    it("has circumcenters at known positions (face midpoints on sphere)", () => {
      const hull = convexHull(points);
      const tri = buildTriangulation(hull);

      // Each octahedron face has its circumcenter at the normalized centroid
      // of 3 axis-aligned vertices, e.g. (1,0,0),(0,1,0),(0,0,1) → normalize(1,1,1)
      const s = 1 / Math.sqrt(3);
      for (const t of tri.triangles) {
        const cc = t.circumcenter;
        // Each component should be ±1/√3
        expect(Math.abs(cc[0])).toBeCloseTo(s, 10);
        expect(Math.abs(cc[1])).toBeCloseTo(s, 10);
        expect(Math.abs(cc[2])).toBeCloseTo(s, 10);
      }
    });
  });

  describe("cube vertices (8 normalized points)", () => {
    it("produces 12 triangles with correct structure", () => {
      const s = 1 / Math.sqrt(3);
      const points: Point3D[] = [
        [s, s, s],
        [s, s, -s],
        [s, -s, s],
        [s, -s, -s],
        [-s, s, s],
        [-s, s, -s],
        [-s, -s, s],
        [-s, -s, -s],
      ];

      const hull = convexHull(points);
      const tri = buildTriangulation(hull);
      expect(tri.triangles.length).toBe(12);
      expect(tri.vertices.length).toBe(8);
      validateTriangulation(tri);
    });
  });

  describe("world cities (10 points)", () => {
    it("produces 16 triangles with correct structure", () => {
      const cities = [
        { lat: 48.8566, lon: 2.3522 }, // Paris
        { lat: 40.7128, lon: -74.006 }, // New York
        { lat: -33.8688, lon: 151.2093 }, // Sydney
        { lat: 35.6762, lon: 139.6503 }, // Tokyo
        { lat: -22.9068, lon: -43.1729 }, // Rio de Janeiro
        { lat: 55.7558, lon: 37.6173 }, // Moscow
        { lat: -1.2921, lon: 36.8219 }, // Nairobi
        { lat: 51.5074, lon: -0.1278 }, // London
        { lat: -34.6037, lon: -58.3816 }, // Buenos Aires
        { lat: 1.3521, lon: 103.8198 }, // Singapore
      ];

      const points = cities.map(toCartesian);
      const hull = convexHull(points);
      const tri = buildTriangulation(hull);
      expect(tri.triangles.length).toBe(16);
      expect(tri.vertices.length).toBe(10);
      validateTriangulation(tri);
    });
  });

  describe("circumradius consistency", () => {
    it("circumradius matches distance from circumcenter to each vertex", () => {
      // Use octahedron
      const points: Point3D[] = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ];
      const hull = convexHull(points);
      const tri = buildTriangulation(hull);

      for (const t of tri.triangles) {
        for (const vi of t.vertices) {
          const dist = sphericalDistance(t.circumcenter, tri.vertices[vi].point);
          expect(dist).toBeCloseTo(t.circumradius, 10);
        }
      }
    });

    it("circumradius consistent for cube vertices", () => {
      const s = 1 / Math.sqrt(3);
      const points: Point3D[] = [
        [s, s, s],
        [s, s, -s],
        [s, -s, s],
        [s, -s, -s],
        [-s, s, s],
        [-s, s, -s],
        [-s, -s, s],
        [-s, -s, -s],
      ];
      const hull = convexHull(points);
      const tri = buildTriangulation(hull);

      for (const t of tri.triangles) {
        for (const vi of t.vertices) {
          const dist = sphericalDistance(t.circumcenter, tri.vertices[vi].point);
          expect(dist).toBeCloseTo(t.circumradius, 10);
        }
      }
    });

    it("circumradius consistent for world cities", () => {
      const cities = [
        { lat: 48.8566, lon: 2.3522 },
        { lat: 40.7128, lon: -74.006 },
        { lat: -33.8688, lon: 151.2093 },
        { lat: 35.6762, lon: 139.6503 },
        { lat: -22.9068, lon: -43.1729 },
        { lat: 55.7558, lon: 37.6173 },
        { lat: -1.2921, lon: 36.8219 },
        { lat: 51.5074, lon: -0.1278 },
        { lat: -34.6037, lon: -58.3816 },
        { lat: 1.3521, lon: 103.8198 },
      ];
      const points = cities.map(toCartesian);
      const hull = convexHull(points);
      const tri = buildTriangulation(hull);

      for (const t of tri.triangles) {
        for (const vi of t.vertices) {
          const dist = sphericalDistance(t.circumcenter, tri.vertices[vi].point);
          expect(dist).toBeCloseTo(t.circumradius, 10);
        }
      }
    });
  });
});
