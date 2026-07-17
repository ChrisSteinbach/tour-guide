import { orient3D } from "./predicates";
import type { Point3D } from "./index";

describe("orient3D (robust predicates)", () => {
  it("positive when d is above plane(a,b,c)", () => {
    const a: Point3D = [1, 0, 0];
    const b: Point3D = [0, 1, 0];
    const c: Point3D = [0, 0, 1];
    expect(orient3D(a, b, c, [1, 1, 1])).toBeGreaterThan(0);
  });

  it("negative when d is below plane(a,b,c)", () => {
    const a: Point3D = [1, 0, 0];
    const b: Point3D = [0, 1, 0];
    const c: Point3D = [0, 0, 1];
    expect(orient3D(a, b, c, [0, 0, 0])).toBeLessThan(0);
  });

  it("exact zero for coplanar points", () => {
    const a: Point3D = [1, 0, 0];
    const b: Point3D = [0, 1, 0];
    const c: Point3D = [-1, -1, 0];
    const d: Point3D = [0.5, 0.5, 0];
    expect(orient3D(a, b, c, d)).toBe(0);
  });

  it("exact zero for all points in xy-plane", () => {
    const a: Point3D = [3, 7, 0];
    const b: Point3D = [-2, 5, 0];
    const c: Point3D = [1, -4, 0];
    const d: Point3D = [100, -200, 0];
    expect(orient3D(a, b, c, d)).toBe(0);
  });

  it("swapping two vertices flips the sign exactly", () => {
    const a: Point3D = [1, 0, 0];
    const b: Point3D = [0, 1, 0];
    const c: Point3D = [0, 0, 1];
    const d: Point3D = [1, 1, 1];
    const v1 = orient3D(a, b, c, d);
    const v2 = orient3D(a, c, b, d);
    expect(v1 + v2).toBe(0);
    expect(v1).toBeGreaterThan(0);
    expect(v2).toBeLessThan(0);
  });

  it("correct sign for near-coplanar points that naive arithmetic gets wrong", () => {
    // These points are designed so that the naive 3×3 determinant suffers
    // catastrophic cancellation. The coordinates differ only in the last
    // few bits, making the true determinant extremely small but nonzero.
    const a: Point3D = [1, 0, 0];
    const b: Point3D = [0, 1, 0];
    const c: Point3D = [0, 0, 1];

    // d is just barely above the plane: the offset 1e-15 is below the
    // ~1e-16 error bound of naive double-precision determinant.
    // Move d slightly above and below the plane.
    const above: Point3D = [1 / 3 + 1e-15, 1 / 3 + 1e-15, 1 / 3 + 1e-15];
    const below: Point3D = [1 / 3 - 1e-15, 1 / 3 - 1e-15, 1 / 3 - 1e-15];

    // Robust orient3D must distinguish these correctly
    const vAbove = orient3D(a, b, c, above);
    const vBelow = orient3D(a, b, c, below);

    // They should have opposite signs (or one is zero)
    // The key property: the sign is never wrong
    expect(vAbove).toBeGreaterThanOrEqual(0);
    expect(vBelow).toBeLessThanOrEqual(0);
    // At least one should be nonzero (they can't both be exactly on the plane)
    expect(Math.abs(vAbove) + Math.abs(vBelow)).toBeGreaterThan(0);
  });

  it("consistent orientation for points on a great circle", () => {
    // All points on the equator (z=0) are coplanar with the origin
    const points: Point3D[] = [];
    for (let i = 0; i < 10; i++) {
      const theta = (2 * Math.PI * i) / 10;
      points.push([Math.cos(theta), Math.sin(theta), 0]);
    }

    // Any three equator points + origin should give orient3D = 0
    // because the origin lies in the plane z=0
    const origin: Point3D = [0, 0, 0];
    for (let i = 0; i < 8; i++) {
      expect(orient3D(points[i], points[i + 1], points[i + 2], origin)).toBe(0);
    }
  });
});
