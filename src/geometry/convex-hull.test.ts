import { convexHull, orient3D } from "./convex-hull";
import type { ConvexHull } from "./convex-hull";
import { toCartesian } from "./index";
import type { Point3D } from "./index";

// ---------- Structural invariant validator ----------

function validateHull(hull: ConvexHull, allOnHull = true) {
  const { points, faces } = hull;
  const nF = faces.length;
  const nV = new Set(faces.flatMap((f) => f.vertices)).size;

  // All vertex indices in range
  for (let fi = 0; fi < nF; fi++) {
    for (const vi of faces[fi].vertices) {
      expect(vi).toBeGreaterThanOrEqual(0);
      expect(vi).toBeLessThan(points.length);
    }
  }

  // No degenerate faces (3 distinct vertices)
  for (let fi = 0; fi < nF; fi++) {
    const [a, b, c] = faces[fi].vertices;
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  }

  // All neighbor indices in range
  for (let fi = 0; fi < nF; fi++) {
    for (const ni of faces[fi].neighbor) {
      expect(ni).toBeGreaterThanOrEqual(0);
      expect(ni).toBeLessThan(nF);
    }
  }

  // Adjacency symmetry: if face i has neighbor j at edge e,
  // then j must have i as a neighbor, sharing the same two vertices (reversed)
  for (let fi = 0; fi < nF; fi++) {
    const f = faces[fi];
    for (let e = 0; e < 3; e++) {
      const ni = f.neighbor[e];
      const edgeA = f.vertices[e];
      const edgeB = f.vertices[(e + 1) % 3];

      // Find the shared edge in the neighbor (should be edgeB → edgeA)
      const nf = faces[ni];
      let found = false;
      for (let ne = 0; ne < 3; ne++) {
        if (nf.vertices[ne] === edgeB && nf.vertices[(ne + 1) % 3] === edgeA) {
          // Neighbor should point back to us
          expect(nf.neighbor[ne]).toBe(fi);
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    }
  }

  // Outward orientation: every face normal points away from origin (for unit-sphere points).
  // orient3D(v0, v1, v2, origin) should be < 0 (origin is below/inside every face)
  const origin: Point3D = [0, 0, 0];
  for (let fi = 0; fi < nF; fi++) {
    const [a, b, c] = faces[fi].vertices;
    const vol = orient3D(points[a], points[b], points[c], origin);
    expect(vol).toBeLessThan(0);
  }

  // Convexity: no point is visible from any face
  for (let fi = 0; fi < nF; fi++) {
    const [a, b, c] = faces[fi].vertices;
    for (let pi = 0; pi < points.length; pi++) {
      const vol = orient3D(points[a], points[b], points[c], points[pi]);
      expect(vol).toBeLessThanOrEqual(1e-10);
    }
  }

  // Euler's formula for convex polyhedra with triangular faces:
  // F = 2V - 4  (when all points are on the hull)
  if (allOnHull) {
    expect(nF).toBe(2 * nV - 4);
  }
}

// ---------- Test cases ----------

describe("orient3D", () => {
  it("positive when d is above plane(a,b,c)", () => {
    const a: Point3D = [1, 0, 0];
    const b: Point3D = [0, 1, 0];
    const c: Point3D = [0, 0, 1];
    // Normal of (b-a)×(c-a) points into the first octant
    // Origin (0,0,0) should be below, (1,1,1) above
    expect(orient3D(a, b, c, [1, 1, 1])).toBeGreaterThan(0);
    expect(orient3D(a, b, c, [0, 0, 0])).toBeLessThan(0);
  });

  it("zero when d is coplanar", () => {
    const a: Point3D = [1, 0, 0];
    const b: Point3D = [0, 1, 0];
    const c: Point3D = [-1, -1, 0];
    const d: Point3D = [0.5, 0.5, 0];
    expect(Math.abs(orient3D(a, b, c, d))).toBeLessThan(1e-15);
  });

  it("swapping two vertices flips the sign", () => {
    const a: Point3D = [1, 0, 0];
    const b: Point3D = [0, 1, 0];
    const c: Point3D = [0, 0, 1];
    const d: Point3D = [1, 1, 1];
    const v1 = orient3D(a, b, c, d);
    const v2 = orient3D(a, c, b, d);
    expect(Math.abs(v1 + v2)).toBeLessThan(1e-15);
  });
});

describe("convexHull", () => {
  describe("tetrahedron (4 points)", () => {
    it("produces 4 faces with correct structure", () => {
      const points: Point3D[] = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        [-1, -1, -1],
      ].map((p) => {
        const len = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
        return [p[0] / len, p[1] / len, p[2] / len] as Point3D;
      });

      const hull = convexHull(points);
      expect(hull.faces.length).toBe(4);
      validateHull(hull);
    });
  });

  describe("octahedron (6 axis points)", () => {
    it("produces 8 faces with correct structure", () => {
      const points: Point3D[] = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ];

      const hull = convexHull(points);
      expect(hull.faces.length).toBe(8);
      validateHull(hull);
    });
  });

  describe("cube vertices (8 points)", () => {
    it("produces 12 triangular faces", () => {
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
      expect(hull.faces.length).toBe(12);
      validateHull(hull);
    });
  });

  describe("world cities (10 real lat/lon points)", () => {
    it("produces 16 faces with correct structure", () => {
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
      // 10 points all on hull → F = 2*10 - 4 = 16
      expect(hull.faces.length).toBe(16);
      validateHull(hull);
    });
  });

  describe("icosahedron (12 points)", () => {
    it("produces 20 faces with correct structure", () => {
      // Golden ratio icosahedron vertices
      const phi = (1 + Math.sqrt(5)) / 2;
      const raw: Point3D[] = [
        [0, 1, phi],
        [0, 1, -phi],
        [0, -1, phi],
        [0, -1, -phi],
        [1, phi, 0],
        [1, -phi, 0],
        [-1, phi, 0],
        [-1, -phi, 0],
        [phi, 0, 1],
        [phi, 0, -1],
        [-phi, 0, 1],
        [-phi, 0, -1],
      ];
      const points = raw.map((p) => {
        const len = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
        return [p[0] / len, p[1] / len, p[2] / len] as Point3D;
      });

      const hull = convexHull(points);
      // 12 points → F = 2*12 - 4 = 20
      expect(hull.faces.length).toBe(20);
      validateHull(hull);
    });
  });

  describe("BFS optimization", () => {
    /** Generate n random unit-sphere points with a seeded PRNG */
    function generateRandomSpherePoints(n: number, seed: number): Point3D[] {
      let state = seed | 0;
      function rand(): number {
        state = (Math.imul(state, 1664525) + 1013904223) | 0;
        return (state >>> 0) / 0x100000000;
      }

      const points: Point3D[] = [];
      for (let i = 0; i < n; i++) {
        // Marsaglia method for uniform sphere sampling
        let x: number, y: number, s: number;
        do {
          x = 2 * rand() - 1;
          y = 2 * rand() - 1;
          s = x * x + y * y;
        } while (s >= 1 || s === 0);
        const z = 1 - 2 * s;
        const r = 2 * Math.sqrt(1 - s);
        points.push([x * r, y * r, z]);
      }
      return points;
    }

    it("handles 1,000 random sphere points with full validation", () => {
      const points = generateRandomSpherePoints(1000, 42);
      const hull = convexHull(points);
      const nV = new Set(hull.faces.flatMap((f) => f.vertices)).size;
      expect(hull.faces.length).toBe(2 * nV - 4);
      validateHull(hull);
    });

    it("handles 10,000 random sphere points (F = 2V - 4)", () => {
      const points = generateRandomSpherePoints(10000, 123);
      const t0 = performance.now();
      const hull = convexHull(points);
      const elapsed = performance.now() - t0;
      const nV = new Set(hull.faces.flatMap((f) => f.vertices)).size;
      expect(hull.faces.length).toBe(2 * nV - 4);
      expect(elapsed).toBeLessThan(10_000); // Must complete within 10s
    });
  });

  describe("edge cases", () => {
    it("throws for fewer than 4 points", () => {
      expect(() => convexHull([[1, 0, 0]])).toThrow();
      expect(() =>
        convexHull([
          [1, 0, 0],
          [0, 1, 0],
        ]),
      ).toThrow();
      expect(() =>
        convexHull([
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ]),
      ).toThrow();
    });

    it("throws for coplanar points", () => {
      // 4 points all in the xy-plane
      expect(() =>
        convexHull([
          [1, 0, 0],
          [0, 1, 0],
          [-1, 0, 0],
          [0, -1, 0],
        ]),
      ).toThrow("coplanar");
    });

    it("includes all unit-sphere points (none dropped as interior)", () => {
      // Octahedron vertices plus a nearby sphere point that would previously
      // be dropped as "interior" due to perturbation pushing it inward
      const extra: Point3D = [
        Math.sqrt(1 / 3),
        Math.sqrt(1 / 3),
        Math.sqrt(1 / 3),
      ];
      const points: Point3D[] = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
        extra,
      ];

      const hull = convexHull(points);
      // All 7 sphere points are hull vertices: F = 2V - 4 = 10
      expect(hull.faces.length).toBe(10);
      validateHull(hull);
    });
  });
});
