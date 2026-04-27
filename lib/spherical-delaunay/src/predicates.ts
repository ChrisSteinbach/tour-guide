// Robust geometric predicates — thin adapter over vendored Shewchuk/mourner code

import type { Point3D } from "./index";
import { orient3d } from "./vendor/robust-predicates/orient3d";

/**
 * Signed volume of tetrahedron (a, b, c, d).
 * Positive when d is above the plane of (a, b, c), where "above" is the side
 * the normal (b-a)×(c-a) points toward.
 *
 * Uses adaptive-precision arithmetic (Shewchuk's method) for exact results
 * near the zero threshold where naive double-precision fails.
 *
 * Note: Shewchuk's orient3d returns det(a-d, b-d, c-d) which equals
 * -det(b-a, c-a, d-a). We negate to match the project convention.
 */
export function orient3D(
  a: Point3D,
  b: Point3D,
  c: Point3D,
  d: Point3D,
): number {
  return (
    -orient3d(
      a[0],
      a[1],
      a[2],
      b[0],
      b[1],
      b[2],
      c[0],
      c[1],
      c[2],
      d[0],
      d[1],
      d[2],
    ) || 0
  ); // || 0 normalizes -0 to 0
}
