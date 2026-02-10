// Shared geometry library — spherical math primitives and algorithms
// Used by both the offline build pipeline and the client-side query module

// ---------- Types ----------

/** [x, y, z] on unit sphere */
export type Point3D = [number, number, number];

/** Latitude/longitude in degrees */
export type LatLon = { lat: number; lon: number };

// ---------- Internal helpers ----------

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function vecLength(v: Point3D): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

export function normalize(v: Point3D): Point3D {
  const len = vecLength(v);
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function dot(a: Point3D, b: Point3D): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Point3D, b: Point3D): Point3D {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

// ---------- Coordinate conversion ----------

/** Convert lat/lon (degrees) to unit-sphere Cartesian coordinates. */
export function toCartesian(loc: LatLon): Point3D {
  const latRad = loc.lat * DEG_TO_RAD;
  const lonRad = loc.lon * DEG_TO_RAD;
  const cosLat = Math.cos(latRad);
  return [
    cosLat * Math.cos(lonRad),
    cosLat * Math.sin(lonRad),
    Math.sin(latRad),
  ];
}

/** Convert unit-sphere Cartesian coordinates to lat/lon (degrees). */
export function toLatLon(p: Point3D): LatLon {
  return {
    lat: Math.asin(clamp(p[2], -1, 1)) * RAD_TO_DEG,
    lon: Math.atan2(p[1], p[0]) * RAD_TO_DEG,
  };
}

// ---------- Great circle fundamentals ----------

/** Cross product a × b, normalized. Normal to the great circle through a and b. */
export function greatCircleNormal(a: Point3D, b: Point3D): Point3D {
  return normalize(cross(a, b));
}

/**
 * Sign of dot(cross(a, b), p).
 * Positive → p is to the left of the great circle from a to b.
 * Negative → right side. Zero → on the great circle.
 */
export function sideOfGreatCircle(
  a: Point3D,
  b: Point3D,
  p: Point3D,
): number {
  return dot(cross(a, b), p);
}

// ---------- Spherical distance ----------

/** Central angle (radians) between two unit-sphere points via acos(dot). */
export function sphericalDistance(a: Point3D, b: Point3D): number {
  return Math.acos(clamp(dot(a, b), -1, 1));
}

/** Haversine distance (radians) between two lat/lon points. More stable for small distances. */
export function haversineDistance(a: LatLon, b: LatLon): number {
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const dLat = lat2 - lat1;
  const dLon = (b.lon - a.lon) * DEG_TO_RAD;

  const sinHalfDLat = Math.sin(dLat / 2);
  const sinHalfDLon = Math.sin(dLon / 2);
  const h =
    sinHalfDLat * sinHalfDLat +
    Math.cos(lat1) * Math.cos(lat2) * sinHalfDLon * sinHalfDLon;

  return 2 * Math.asin(Math.sqrt(clamp(h, 0, 1)));
}

// ---------- Circumcenter on sphere ----------

/**
 * Spherical circumcenter: the point on the unit sphere equidistant to a, b, c.
 * Computed as normalize((b−a) × (c−a)), with sign chosen so it's on the same
 * side as the triangle's centroid.
 */
export function sphericalCircumcenter(
  a: Point3D,
  b: Point3D,
  c: Point3D,
): Point3D {
  const ba: Point3D = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ca: Point3D = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = normalize(cross(ba, ca));

  // Pick the sign that places the circumcenter on the same side as the centroid
  const centroid: Point3D = [
    a[0] + b[0] + c[0],
    a[1] + b[1] + c[1],
    a[2] + b[2] + c[2],
  ];

  if (dot(n, centroid) < 0) {
    return [-n[0], -n[1], -n[2]];
  }
  return n;
}

// ---------- Convex hull (re-exports) ----------

export { convexHull, orient3D } from "./convex-hull";
export type { HullFace, ConvexHull } from "./convex-hull";

// ---------- Delaunay triangulation (re-exports) ----------

export { buildTriangulation } from "./delaunay";
export type {
  DelaunayTriangle,
  DelaunayVertex,
  SphericalDelaunay,
} from "./delaunay";
