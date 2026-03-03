import { convexHull } from "./convex-hull";
import type { ConvexHull } from "./convex-hull";
import { orient3D } from "./predicates";
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
  // orient3D(v0, v1, v2, origin) should be <= 0 (origin is below/inside every face).
  // Tolerance: the hull is built with perturbed points (~1e-6 perturbation) but stores
  // unperturbed ones, so faces from near-coincident clusters can have small positive
  // orient3D values proportional to the perturbation scale.
  const origin: Point3D = [0, 0, 0];
  for (let fi = 0; fi < nF; fi++) {
    const [a, b, c] = faces[fi].vertices;
    const vol = orient3D(points[a], points[b], points[c], origin);
    expect(vol).toBeLessThan(1e-6);
  }

  // Convexity: local convexity at every edge implies global convexity for a
  // closed triangulated surface.  For each edge shared by faces f and g, the
  // vertex of g opposite the shared edge must lie on or below f's plane.
  // O(E) ≈ O(3V) orient3D calls instead of the naïve O(F·V) ≈ O(V²).
  for (let fi = 0; fi < nF; fi++) {
    const f = faces[fi];
    const [a, b, c] = f.vertices;
    for (let e = 0; e < 3; e++) {
      const ni = f.neighbor[e];
      if (ni <= fi) continue; // check each edge pair once
      const nf = faces[ni];
      const edgeA = f.vertices[e];
      const edgeB = f.vertices[(e + 1) % 3];
      // The opposite vertex is the one in the neighbor not on the shared edge
      let opposite = nf.vertices[0];
      if (opposite === edgeA || opposite === edgeB) opposite = nf.vertices[1];
      if (opposite === edgeA || opposite === edgeB) opposite = nf.vertices[2];
      const vol = orient3D(points[a], points[b], points[c], points[opposite]);
      expect(vol).toBeLessThan(1e-6);
    }
  }

  // Euler's formula for convex polyhedra with triangular faces:
  // F = 2V - 4  (when all points are on the hull)
  if (allOnHull) {
    expect(nV).toBe(points.length); // no input points dropped
    expect(nF).toBe(2 * nV - 4);
  }
}

// ---------- Shared helpers ----------

/** Generate n random unit-sphere points with a seeded PRNG */
function randomSpherePoints(n: number, seed: number): Point3D[] {
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

// ---------- Test cases ----------

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
    it("handles 1,000 random sphere points with full validation", () => {
      const points = randomSpherePoints(1000, 42);
      const hull = convexHull(points);
      const nV = new Set(hull.faces.flatMap((f) => f.vertices)).size;
      expect(hull.faces.length).toBe(2 * nV - 4);
      validateHull(hull);
    });

    it("handles 10,000 random sphere points (F = 2V - 4)", () => {
      const points = randomSpherePoints(10000, 123);
      const hull = convexHull(points);
      const nV = new Set(hull.faces.flatMap((f) => f.vertices)).size;
      expect(hull.faces.length).toBe(2 * nV - 4);
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

  describe("near-degenerate inputs", () => {
    it("great circle: equator points + poles (maximally coplanar with origin)", () => {
      // 100 points on the equator are all coplanar through the origin,
      // plus two poles. This is the worst case for orient3D: every
      // equator triplet + origin has orient3D ≈ 0.
      const points: Point3D[] = [];
      for (let i = 0; i < 100; i++) {
        const theta = (2 * Math.PI * i) / 100;
        points.push([Math.cos(theta), Math.sin(theta), 0]);
      }
      points.push([0, 0, 1]); // north pole
      points.push([0, 0, -1]); // south pole

      const hull = convexHull(points);
      const nV = new Set(hull.faces.flatMap((f) => f.vertices)).size;
      expect(hull.faces.length).toBe(2 * nV - 4);
      validateHull(hull);
    });

    it("near-coincident clusters: 4 anchors × 5 points within ~1e-8", () => {
      // Clusters of near-coincident points stress orient3D with tiny
      // determinant values near the floating-point noise floor.
      const anchors: Point3D[] = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        [-1, 0, 0],
      ];
      const EPS = 1e-8;
      let state = 0xdeadbeef | 0;
      function rand(): number {
        state = (Math.imul(state, 1664525) + 1013904223) | 0;
        return ((state >>> 0) / 0x100000000 - 0.5) * EPS;
      }

      const points: Point3D[] = [];
      for (const anchor of anchors) {
        for (let j = 0; j < 5; j++) {
          const px = anchor[0] + rand();
          const py = anchor[1] + rand();
          const pz = anchor[2] + rand();
          const len = Math.sqrt(px * px + py * py + pz * pz);
          points.push([px / len, py / len, pz / len]);
        }
      }

      const hull = convexHull(points);
      const nV = new Set(hull.faces.flatMap((f) => f.vertices)).size;
      expect(hull.faces.length).toBe(2 * nV - 4);
      validateHull(hull);
    });

    it("regular lat/lon grid: systematic near-coplanarity from grid structure", () => {
      // A regular grid produces many near-coplanar configurations because
      // grid lines share common planes through the origin.
      const points: Point3D[] = [];
      for (let lat = -80; lat <= 80; lat += 20) {
        for (let lon = -180; lon < 180; lon += 20) {
          points.push(toCartesian({ lat, lon }));
        }
      }
      // Add poles
      points.push([0, 0, 1]);
      points.push([0, 0, -1]);

      const hull = convexHull(points);
      const nV = new Set(hull.faces.flatMap((f) => f.vertices)).size;
      expect(hull.faces.length).toBe(2 * nV - 4);
      validateHull(hull);
    });

    it("Fibonacci sphere: 500 uniformly distributed points with near-degeneracies", () => {
      // Fibonacci sphere lattice produces near-degenerate configurations
      // from its quasi-uniform distribution pattern.
      const n = 500;
      const goldenAngle = Math.PI * (3 - Math.sqrt(5));
      const points: Point3D[] = [];
      for (let i = 0; i < n; i++) {
        const y = 1 - (2 * i) / (n - 1);
        const radius = Math.sqrt(1 - y * y);
        const theta = goldenAngle * i;
        points.push([radius * Math.cos(theta), radius * Math.sin(theta), y]);
      }

      const hull = convexHull(points);
      const nV = new Set(hull.faces.flatMap((f) => f.vertices)).size;
      expect(hull.faces.length).toBe(2 * nV - 4);
      validateHull(hull);
    });

    it("mixed: random points combined with axis-aligned coplanar points", () => {
      // Mix random points with points that lie exactly on coordinate planes,
      // creating many exact coplanarities.
      const points: Point3D[] = randomSpherePoints(50, 999);

      // Add points in the xy-plane
      for (let i = 0; i < 20; i++) {
        const theta = (2 * Math.PI * i) / 20;
        points.push([Math.cos(theta), Math.sin(theta), 0]);
      }
      // Add points in the xz-plane
      for (let i = 0; i < 20; i++) {
        const theta = (2 * Math.PI * i) / 20;
        points.push([Math.cos(theta), 0, Math.sin(theta)]);
      }

      const hull = convexHull(points);
      const nV = new Set(hull.faces.flatMap((f) => f.vertices)).size;
      expect(hull.faces.length).toBe(2 * nV - 4);
      validateHull(hull);
    });
  });

  describe.skip("performance", () => {
    it("computes 10,000-point hull within 10 s", () => {
      const points = randomSpherePoints(10000, 123);
      const t0 = performance.now();
      convexHull(points);
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeLessThan(10_000);
    });
  });
});
