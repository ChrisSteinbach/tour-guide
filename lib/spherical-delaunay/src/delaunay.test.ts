import { buildTriangulation } from "./delaunay";
import type { SphericalDelaunay } from "./delaunay";
import type { ConvexHull } from "./convex-hull";
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
      expect(vi, `triangle ${ti} vertex out of range`).toBeGreaterThanOrEqual(
        0,
      );
      expect(vi, `triangle ${ti} vertex out of range`).toBeLessThan(nV);
    }
  }

  // No degenerate triangles (3 distinct vertices)
  for (let ti = 0; ti < nT; ti++) {
    const [a, b, c] = triangles[ti].vertices;
    expect(a, `triangle ${ti} degenerate`).not.toBe(b);
    expect(b, `triangle ${ti} degenerate`).not.toBe(c);
    expect(a, `triangle ${ti} degenerate`).not.toBe(c);
  }

  // All neighbor indices in range
  for (let ti = 0; ti < nT; ti++) {
    for (const ni of triangles[ti].neighbor) {
      expect(ni, `triangle ${ti} neighbor out of range`).toBeGreaterThanOrEqual(
        0,
      );
      expect(ni, `triangle ${ti} neighbor out of range`).toBeLessThan(nT);
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
          expect(
            nt.neighbor[ne],
            `triangle ${ti} edge ${e}: neighbor ${ni} doesn't point back`,
          ).toBe(ti);
          found = true;
          break;
        }
      }
      expect(
        found,
        `triangle ${ti} edge ${e}: shared edge not found in neighbor ${ni}`,
      ).toBe(true);
    }
  }

  // Every vertex's triangle field points to a triangle that includes that vertex
  for (let vi = 0; vi < nV; vi++) {
    const ti = vertices[vi].triangle;
    if (ti === -1) continue;
    expect(ti, `vertex ${vi} triangle out of range`).toBeGreaterThanOrEqual(0);
    expect(ti, `vertex ${vi} triangle out of range`).toBeLessThan(nT);
    const verts = triangles[ti].vertices;
    expect(verts, `vertex ${vi} not in its own triangle ${ti}`).toContain(vi);
  }

  // Circumcenters on unit sphere (length ≈ 1)
  for (let ti = 0; ti < nT; ti++) {
    const len = vecLength(triangles[ti].circumcenter!);
    expect(len, `triangle ${ti} circumcenter not on unit sphere`).toBeCloseTo(
      1,
      10,
    );
  }

  // Circumradii positive
  for (let ti = 0; ti < nT; ti++) {
    expect(
      triangles[ti].circumradius!,
      `triangle ${ti} circumradius not positive`,
    ).toBeGreaterThan(0);
  }

  // Circumcenters equidistant from all 3 vertices (within tolerance)
  for (let ti = 0; ti < nT; ti++) {
    const t = triangles[ti];
    const da = sphericalDistance(
      t.circumcenter!,
      vertices[t.vertices[0]].point,
    );
    const db = sphericalDistance(
      t.circumcenter!,
      vertices[t.vertices[1]].point,
    );
    const dc = sphericalDistance(
      t.circumcenter!,
      vertices[t.vertices[2]].point,
    );
    expect(da, `triangle ${ti} circumcenter not equidistant`).toBeCloseTo(
      t.circumradius!,
      10,
    );
    expect(db, `triangle ${ti} circumcenter not equidistant`).toBeCloseTo(
      t.circumradius!,
      10,
    );
    expect(dc, `triangle ${ti} circumcenter not equidistant`).toBeCloseTo(
      t.circumradius!,
      10,
    );
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
        const cc = t.circumcenter!;
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

  describe("originalIndices remapping", () => {
    // The convex hull's perturbPoints normalizes all points to the unit sphere,
    // so we can't create interior points through convexHull(). Instead, we craft
    // a ConvexHull directly with unused points to exercise the remapping logic
    // in buildTriangulation.

    /** Build a ConvexHull where only `usedIndices` appear in faces. */
    function hullWithUnusedPoints(
      points: Point3D[],
      usedIndices: number[],
    ): ConvexHull {
      const realHull = convexHull(usedIndices.map((i) => points[i]));
      const faces = realHull.faces.map((f) => ({
        vertices: f.vertices.map((v) => usedIndices[v]) as [
          number,
          number,
          number,
        ],
        neighbor: [...f.neighbor] as [number, number, number],
      }));
      return { points, faces };
    }

    it("drops unused points and remaps indices correctly", () => {
      // 7 input points; index 3 is unused
      const points: Point3D[] = [
        [1, 0, 0], // 0
        [-1, 0, 0], // 1
        [0, 1, 0], // 2
        [0, 0.5, 0.5], // 3 — unused
        [0, -1, 0], // 4
        [0, 0, 1], // 5
        [0, 0, -1], // 6
      ];

      const hull = hullWithUnusedPoints(points, [0, 1, 2, 4, 5, 6]);
      const tri = buildTriangulation(hull);

      expect(tri.vertices.length).toBe(6);
      expect(tri.originalIndices.length).toBe(6);
      expect(tri.originalIndices).not.toContain(3);

      for (const idx of [0, 1, 2, 4, 5, 6]) {
        expect(
          tri.originalIndices,
          `original index ${idx} should be in originalIndices`,
        ).toContain(idx);
      }

      // Each vertex's point should match the original input point
      for (let vi = 0; vi < tri.vertices.length; vi++) {
        const origIdx = tri.originalIndices[vi];
        const expected = points[origIdx];
        const actual = tri.vertices[vi].point;
        expect(actual[0]).toBeCloseTo(expected[0], 10);
        expect(actual[1]).toBeCloseTo(expected[1], 10);
        expect(actual[2]).toBeCloseTo(expected[2], 10);
      }
    });

    it("maps to identity when all points are on the hull", () => {
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

      expect(tri.originalIndices).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("handles multiple unused points with correct monotonic remapping", () => {
      // 8 input points, indices 1 and 3 unused
      const points: Point3D[] = [
        [1, 0, 0], // 0 — hull
        [0.5, 0.5, 0], // 1 — unused
        [-1, 0, 0], // 2 — hull
        [0, 0, 0.1], // 3 — unused
        [0, 1, 0], // 4 — hull
        [0, -1, 0], // 5 — hull
        [0, 0, 1], // 6 — hull
        [0, 0, -1], // 7 — hull
      ];

      const hull = hullWithUnusedPoints(points, [0, 2, 4, 5, 6, 7]);
      const tri = buildTriangulation(hull);

      expect(tri.vertices.length).toBe(6);
      expect(tri.originalIndices).not.toContain(1);
      expect(tri.originalIndices).not.toContain(3);

      // Verify remapping is monotonically increasing (preserves input order)
      for (let i = 1; i < tri.originalIndices.length; i++) {
        expect(tri.originalIndices[i]).toBeGreaterThan(
          tri.originalIndices[i - 1],
        );
      }
    });

    it("remapped triangle vertices are valid indices into the new vertex array", () => {
      // 7 input points; index 1 unused
      const points: Point3D[] = [
        [1, 0, 0], // 0
        [0, 0, 0], // 1 — unused
        [-1, 0, 0], // 2
        [0, 1, 0], // 3
        [0, -1, 0], // 4
        [0, 0, 1], // 5
        [0, 0, -1], // 6
      ];

      const hull = hullWithUnusedPoints(points, [0, 2, 3, 4, 5, 6]);
      const tri = buildTriangulation(hull);

      for (const t of tri.triangles) {
        for (const vi of t.vertices) {
          expect(vi).toBeGreaterThanOrEqual(0);
          expect(vi).toBeLessThan(tri.vertices.length);
        }
      }

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
});
