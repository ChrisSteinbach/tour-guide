// Pure geometry helpers for the X-ray overlay.
//
// No Leaflet, no DOM — just typed-array crunching over a FlatDelaunay plus
// tile-rectangle math. Everything here is deterministic and unit-testable.

import type { FlatDelaunay } from "../geometry";
import { toLatLon } from "../geometry";
import { BUFFER_DEG, GRID_DEG } from "../tiles";

/**
 * Edges longer than this (great-circle arc, radians) are treated as
 * back-closure facets of the spherical convex hull rather than real mesh
 * edges, and are skipped when drawing. ~0.18 rad ≈ 10° comfortably exceeds
 * the spacing of adjacent articles inside a 5°-tile-plus-buffer cap while
 * staying well under the span of the huge facets that close the hull behind
 * the cap.
 */
export const MAX_MESH_EDGE_RAD = 0.18;

/** A lat/lon rectangle. `east` may exceed +180 (or `west` drop below -180)
 *  for tiles touching the antimeridian — callers unwrap as needed. */
export interface GeoBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** One drawable mesh edge as a pair of [lat, lon] endpoints. */
export type Segment = [[number, number], [number, number]];

/** Great-circle arc length (radians) between two unit vectors via chord. */
function arcLength(vp: Float64Array, ai: number, bi: number): number {
  const dx = vp[ai] - vp[bi];
  const dy = vp[ai + 1] - vp[bi + 1];
  const dz = vp[ai + 2] - vp[bi + 2];
  const chord = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return 2 * Math.asin(chord < 2 ? chord / 2 : 1);
}

/** Shift `lon` by ±360 until it lands within 180° of `center`. */
function unwrapLon(lon: number, center: number): number {
  let l = lon;
  while (l - center > 180) l -= 360;
  while (l - center < -180) l += 360;
  return l;
}

/** Cheap bbox membership, tolerant of ±360 longitude wrap. */
function inBounds(lat: number, lon: number, b: GeoBounds): boolean {
  if (lat < b.south || lat > b.north) return false;
  if (
    (lon >= b.west && lon <= b.east) ||
    (lon + 360 >= b.west && lon + 360 <= b.east) ||
    (lon - 360 >= b.west && lon - 360 <= b.east)
  ) {
    return true;
  }
  return false;
}

/**
 * Deduped, filtered, unwrapped mesh edges of a triangulation.
 *
 * Each interior edge is shared by exactly two triangles; we emit it once, when
 * the neighbouring triangle index is greater than the current one. Edges longer
 * than `maxEdgeRad` (the hull's back-closure facets) are skipped. Both endpoints
 * are unwrapped around `unwrapLon` so antimeridian tiles render contiguously,
 * and — if `clip` is given — a segment is kept when EITHER endpoint falls inside
 * it (a deliberately loose viewport test).
 */
export function meshSegments(
  fd: FlatDelaunay,
  opts: {
    maxEdgeRad?: number;
    unwrapLon: number;
    clip?: GeoBounds;
  },
): Segment[] {
  const { triangleVertices, triangleNeighbors, vertexPoints } = fd;
  const maxEdge = opts.maxEdgeRad ?? MAX_MESH_EDGE_RAD;
  const center = opts.unwrapLon;
  const clip = opts.clip;
  const triangleCount = triangleVertices.length / 3;
  const segments: Segment[] = [];

  for (let t = 0; t < triangleCount; t++) {
    const ti = t * 3;
    for (let e = 0; e < 3; e++) {
      // Emit each shared edge exactly once.
      if (triangleNeighbors[ti + e] <= t) continue;

      const va = triangleVertices[ti + e];
      const vb = triangleVertices[ti + ((e + 1) % 3)];
      const ai = va * 3;
      const bi = vb * 3;

      if (arcLength(vertexPoints, ai, bi) > maxEdge) continue;

      const a = toLatLon([
        vertexPoints[ai],
        vertexPoints[ai + 1],
        vertexPoints[ai + 2],
      ]);
      const b = toLatLon([
        vertexPoints[bi],
        vertexPoints[bi + 1],
        vertexPoints[bi + 2],
      ]);
      const aLon = unwrapLon(a.lon, center);
      const bLon = unwrapLon(b.lon, center);

      if (
        clip &&
        !inBounds(a.lat, aLon, clip) &&
        !inBounds(b.lat, bLon, clip)
      ) {
        continue;
      }

      segments.push([
        [a.lat, aLon],
        [b.lat, bLon],
      ]);
    }
  }

  return segments;
}

/**
 * Core rectangle of a tile, derived from its row/col (NOT from any stored
 * bounds). `south = row*GRID_DEG - 90`, `west = col*GRID_DEG - 180`.
 */
export function tileCoreBounds(row: number, col: number): GeoBounds {
  const south = row * GRID_DEG - 90;
  const west = col * GRID_DEG - 180;
  return { south, west, north: south + GRID_DEG, east: west + GRID_DEG };
}

/**
 * The buffer ring of a tile: the core rectangle (`inner`) and the core
 * extended by BUFFER_DEG on every side (`outer`). Latitude is clamped to
 * ±90; longitude is allowed to exceed ±180 at the antimeridian so the ring
 * stays a contiguous rectangle.
 */
export function tileBufferRing(
  row: number,
  col: number,
): { outer: GeoBounds; inner: GeoBounds } {
  const inner = tileCoreBounds(row, col);
  const outer: GeoBounds = {
    south: Math.max(-90, inner.south - BUFFER_DEG),
    west: inner.west - BUFFER_DEG,
    north: Math.min(90, inner.north + BUFFER_DEG),
    east: inner.east + BUFFER_DEG,
  };
  return { outer, inner };
}

/**
 * A deterministic palette bucket for a tile id, stable across reloads. Uses a
 * simple polynomial string hash folded into [0, paletteSize).
 */
export function tileHueIndex(id: string, paletteSize: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  }
  return ((h % paletteSize) + paletteSize) % paletteSize;
}
