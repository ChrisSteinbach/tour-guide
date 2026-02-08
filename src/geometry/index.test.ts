import {
  toCartesian,
  toLatLon,
  greatCircleNormal,
  sideOfGreatCircle,
  sphericalDistance,
  haversineDistance,
  sphericalCircumcenter,
} from "./index";
import type { Point3D, LatLon } from "./index";

const EPSILON = 1e-10;

function expectClose(actual: number, expected: number, tol = EPSILON) {
  expect(Math.abs(actual - expected)).toBeLessThan(tol);
}

function pointLength(p: Point3D): number {
  return Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
}

// ---------- Coordinate conversion ----------

describe("toCartesian", () => {
  it("converts north pole", () => {
    const p = toCartesian({ lat: 90, lon: 0 });
    expectClose(p[0], 0);
    expectClose(p[1], 0);
    expectClose(p[2], 1);
  });

  it("converts south pole", () => {
    const p = toCartesian({ lat: -90, lon: 0 });
    expectClose(p[0], 0);
    expectClose(p[1], 0);
    expectClose(p[2], -1);
  });

  it("converts equator/prime meridian intersection (0,0)", () => {
    const p = toCartesian({ lat: 0, lon: 0 });
    expectClose(p[0], 1);
    expectClose(p[1], 0);
    expectClose(p[2], 0);
  });

  it("converts equator at 90° east", () => {
    const p = toCartesian({ lat: 0, lon: 90 });
    expectClose(p[0], 0);
    expectClose(p[1], 1);
    expectClose(p[2], 0);
  });

  it("converts equator at 180°", () => {
    const p = toCartesian({ lat: 0, lon: 180 });
    expectClose(p[0], -1);
    expectClose(p[1], 0);
    expectClose(p[2], 0);
  });

  it("produces unit-length vectors", () => {
    const cases: LatLon[] = [
      { lat: 45, lon: 45 },
      { lat: -30, lon: 120 },
      { lat: 89.99, lon: -179.99 },
      { lat: 0, lon: 0 },
    ];
    for (const loc of cases) {
      expectClose(pointLength(toCartesian(loc)), 1, 1e-14);
    }
  });
});

describe("toLatLon", () => {
  it("inverts north pole", () => {
    const ll = toLatLon([0, 0, 1]);
    expectClose(ll.lat, 90);
  });

  it("inverts south pole", () => {
    const ll = toLatLon([0, 0, -1]);
    expectClose(ll.lat, -90);
  });

  it("inverts equator/prime meridian", () => {
    const ll = toLatLon([1, 0, 0]);
    expectClose(ll.lat, 0);
    expectClose(ll.lon, 0);
  });
});

describe("round-trip toCartesian ↔ toLatLon", () => {
  const cases: LatLon[] = [
    { lat: 0, lon: 0 },
    { lat: 48.8566, lon: 2.3522 }, // Paris
    { lat: -33.8688, lon: 151.2093 }, // Sydney
    { lat: 90, lon: 0 },
    { lat: -90, lon: 0 },
    { lat: 0, lon: 180 },
    { lat: 0, lon: -180 },
    { lat: 45, lon: -120 },
  ];

  for (const loc of cases) {
    it(`round-trips (${loc.lat}, ${loc.lon})`, () => {
      const result = toLatLon(toCartesian(loc));
      expectClose(result.lat, loc.lat, 1e-9);
      // lon is ambiguous at the poles
      if (Math.abs(loc.lat) < 89.99) {
        // Normalize to [-180, 180] for comparison
        let expectedLon = loc.lon;
        let actualLon = result.lon;
        // Handle ±180 wrap
        if (Math.abs(expectedLon) === 180) {
          expectedLon = Math.abs(expectedLon);
          actualLon = Math.abs(actualLon);
        }
        expectClose(actualLon, expectedLon, 1e-9);
      }
    });
  }
});

// ---------- Great circle fundamentals ----------

describe("greatCircleNormal", () => {
  it("returns unit vector", () => {
    const a = toCartesian({ lat: 0, lon: 0 });
    const b = toCartesian({ lat: 0, lon: 90 });
    const n = greatCircleNormal(a, b);
    expectClose(pointLength(n), 1, 1e-14);
  });

  it("returns vector perpendicular to both inputs", () => {
    const a = toCartesian({ lat: 30, lon: 10 });
    const b = toCartesian({ lat: -20, lon: 60 });
    const n = greatCircleNormal(a, b);
    expectClose(
      n[0] * a[0] + n[1] * a[1] + n[2] * a[2],
      0,
    );
    expectClose(
      n[0] * b[0] + n[1] * b[1] + n[2] * b[2],
      0,
    );
  });

  it("equator great circle has normal along z-axis", () => {
    // Two points on the equator → normal is ±z
    const a = toCartesian({ lat: 0, lon: 0 });
    const b = toCartesian({ lat: 0, lon: 90 });
    const n = greatCircleNormal(a, b);
    expectClose(Math.abs(n[2]), 1);
    expectClose(n[0], 0);
    expectClose(n[1], 0);
  });
});

describe("sideOfGreatCircle", () => {
  it("north pole is on left side of equator arc (0,0)→(0,90)", () => {
    const a = toCartesian({ lat: 0, lon: 0 });
    const b = toCartesian({ lat: 0, lon: 90 });
    const northPole: Point3D = [0, 0, 1];
    expect(sideOfGreatCircle(a, b, northPole)).toBeGreaterThan(0);
  });

  it("south pole is on right side of equator arc (0,0)→(0,90)", () => {
    const a = toCartesian({ lat: 0, lon: 0 });
    const b = toCartesian({ lat: 0, lon: 90 });
    const southPole: Point3D = [0, 0, -1];
    expect(sideOfGreatCircle(a, b, southPole)).toBeLessThan(0);
  });

  it("point on the great circle returns ~0", () => {
    const a = toCartesian({ lat: 0, lon: 0 });
    const b = toCartesian({ lat: 0, lon: 90 });
    const onCircle = toCartesian({ lat: 0, lon: 45 });
    expectClose(sideOfGreatCircle(a, b, onCircle), 0, 1e-9);
  });

  it("swapping a,b flips the sign", () => {
    const a = toCartesian({ lat: 10, lon: 20 });
    const b = toCartesian({ lat: -30, lon: 80 });
    const p = toCartesian({ lat: 50, lon: 50 });
    const s1 = sideOfGreatCircle(a, b, p);
    const s2 = sideOfGreatCircle(b, a, p);
    expectClose(s1, -s2, 1e-12);
  });
});

// ---------- Spherical distance ----------

describe("sphericalDistance", () => {
  it("same point → 0", () => {
    const p = toCartesian({ lat: 45, lon: 90 });
    expectClose(sphericalDistance(p, p), 0);
  });

  it("antipodal points → π", () => {
    const a = toCartesian({ lat: 0, lon: 0 });
    const b = toCartesian({ lat: 0, lon: 180 });
    expectClose(sphericalDistance(a, b), Math.PI);
  });

  it("north pole to south pole → π", () => {
    const np: Point3D = [0, 0, 1];
    const sp: Point3D = [0, 0, -1];
    expectClose(sphericalDistance(np, sp), Math.PI);
  });

  it("equator quarter arc → π/2", () => {
    const a = toCartesian({ lat: 0, lon: 0 });
    const b = toCartesian({ lat: 0, lon: 90 });
    expectClose(sphericalDistance(a, b), Math.PI / 2);
  });

  it("is symmetric", () => {
    const a = toCartesian({ lat: 30, lon: 40 });
    const b = toCartesian({ lat: -20, lon: 100 });
    expectClose(
      sphericalDistance(a, b),
      sphericalDistance(b, a),
    );
  });

  it("satisfies triangle inequality", () => {
    const a = toCartesian({ lat: 10, lon: 20 });
    const b = toCartesian({ lat: 40, lon: 80 });
    const c = toCartesian({ lat: -10, lon: -30 });
    const ab = sphericalDistance(a, b);
    const bc = sphericalDistance(b, c);
    const ac = sphericalDistance(a, c);
    expect(ac).toBeLessThanOrEqual(ab + bc + EPSILON);
    expect(ab).toBeLessThanOrEqual(ac + bc + EPSILON);
    expect(bc).toBeLessThanOrEqual(ab + ac + EPSILON);
  });
});

describe("haversineDistance", () => {
  it("same point → 0", () => {
    expectClose(
      haversineDistance({ lat: 45, lon: 90 }, { lat: 45, lon: 90 }),
      0,
    );
  });

  it("antipodal points → π", () => {
    expectClose(
      haversineDistance({ lat: 0, lon: 0 }, { lat: 0, lon: 180 }),
      Math.PI,
    );
  });

  it("equator quarter arc → π/2", () => {
    expectClose(
      haversineDistance({ lat: 0, lon: 0 }, { lat: 0, lon: 90 }),
      Math.PI / 2,
    );
  });

  it("is symmetric", () => {
    const a: LatLon = { lat: 30, lon: 40 };
    const b: LatLon = { lat: -20, lon: 100 };
    expectClose(haversineDistance(a, b), haversineDistance(b, a));
  });

  it("agrees with sphericalDistance", () => {
    const cases: [LatLon, LatLon][] = [
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 90 }],
      [{ lat: 48.8566, lon: 2.3522 }, { lat: 40.7128, lon: -74.006 }],
      [{ lat: 90, lon: 0 }, { lat: -90, lon: 0 }],
      [{ lat: 1, lon: 1 }, { lat: 1.001, lon: 1.001 }], // very close points
    ];
    for (const [a, b] of cases) {
      const d1 = sphericalDistance(toCartesian(a), toCartesian(b));
      const d2 = haversineDistance(a, b);
      expectClose(d1, d2, 1e-9);
    }
  });
});

// ---------- Circumcenter on sphere ----------

describe("sphericalCircumcenter", () => {
  it("result lies on the unit sphere", () => {
    const a = toCartesian({ lat: 10, lon: 20 });
    const b = toCartesian({ lat: 30, lon: 50 });
    const c = toCartesian({ lat: 20, lon: 80 });
    const cc = sphericalCircumcenter(a, b, c);
    expectClose(pointLength(cc), 1, 1e-14);
  });

  it("is equidistant from all three vertices", () => {
    const a = toCartesian({ lat: 10, lon: 20 });
    const b = toCartesian({ lat: 30, lon: 50 });
    const c = toCartesian({ lat: 20, lon: 80 });
    const cc = sphericalCircumcenter(a, b, c);
    const da = sphericalDistance(cc, a);
    const db = sphericalDistance(cc, b);
    const dc = sphericalDistance(cc, c);
    expectClose(da, db, 1e-9);
    expectClose(db, dc, 1e-9);
  });

  it("equilateral triangle on equator", () => {
    // Three equally-spaced points on the equator
    const a = toCartesian({ lat: 0, lon: 0 });
    const b = toCartesian({ lat: 0, lon: 120 });
    const c = toCartesian({ lat: 0, lon: 240 });
    const cc = sphericalCircumcenter(a, b, c);
    // Circumcenter should be at a pole
    expectClose(Math.abs(cc[2]), 1, 1e-9);
    expectClose(cc[0], 0, 1e-9);
    expectClose(cc[1], 0, 1e-9);
  });

  it("is on the same side as the triangle", () => {
    const a = toCartesian({ lat: 10, lon: 20 });
    const b = toCartesian({ lat: 30, lon: 50 });
    const c = toCartesian({ lat: 20, lon: 80 });
    const cc = sphericalCircumcenter(a, b, c);
    // Circumcenter should be on same hemisphere as centroid
    const centroid: Point3D = [
      a[0] + b[0] + c[0],
      a[1] + b[1] + c[1],
      a[2] + b[2] + c[2],
    ];
    const dotProd =
      cc[0] * centroid[0] + cc[1] * centroid[1] + cc[2] * centroid[2];
    expect(dotProd).toBeGreaterThan(0);
  });

  it("works for a small triangle (close points)", () => {
    const a = toCartesian({ lat: 48.856, lon: 2.352 });
    const b = toCartesian({ lat: 48.857, lon: 2.353 });
    const c = toCartesian({ lat: 48.856, lon: 2.354 });
    const cc = sphericalCircumcenter(a, b, c);
    expectClose(pointLength(cc), 1, 1e-12);
    const da = sphericalDistance(cc, a);
    const db = sphericalDistance(cc, b);
    const dc = sphericalDistance(cc, c);
    expectClose(da, db, 1e-9);
    expectClose(db, dc, 1e-9);
  });

  it("works for a large triangle spanning hemispheres", () => {
    const a = toCartesian({ lat: 60, lon: -30 });
    const b = toCartesian({ lat: -40, lon: 50 });
    const c = toCartesian({ lat: 10, lon: 170 });
    const cc = sphericalCircumcenter(a, b, c);
    expectClose(pointLength(cc), 1, 1e-14);
    const da = sphericalDistance(cc, a);
    const db = sphericalDistance(cc, b);
    const dc = sphericalDistance(cc, c);
    expectClose(da, db, 1e-9);
    expectClose(db, dc, 1e-9);
  });
});
