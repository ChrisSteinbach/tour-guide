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

// ---------- Walk replay timeline ----------
//
// The walk animation runs many tiles' traces on one shared clock. Phase
// DURATIONS are fixed up front (derived only from the WINNER's trace sizes);
// every tile then maps elapsed time to its own step index proportionally. This
// inverts the old "step time × trace length" pacing, where one giant non-winner
// trace could stretch the replay to tens of seconds. Here the total is bounded
// by construction — a 5000-hop non-winner advances thousands of steps per frame
// instead of stretching the clock.

/** A walk's trace sizes: locate hops, descent steps, and BFS-expansion steps. */
export interface WalkCounts {
  locate: number;
  descent: number;
  bfs: number;
}

/** Phase boundaries for one replay, as ms offsets from its start. */
export interface WalkTimeline {
  /** End of the locate phase (also its duration, since it starts at 0). */
  locateEnd: number;
  /** End of the descent phase. */
  descentEnd: number;
  /** End of the BFS phase. */
  bfsEnd: number;
  /** End of the whole replay, after the result-pulse window. */
  totalEnd: number;
}

// Each phase scales with the winner's count at a readable pace, then clamps to a
// [floor, ceiling] so the total is bounded no matter how large any trace is.
const WALK_LOCATE_MS_PER_HOP = 70;
const WALK_DESCENT_MS_PER_STEP = 70;
const WALK_BFS_MS_PER_STEP = 40;
const WALK_LOCATE_MIN_MS = 600;
const WALK_LOCATE_MAX_MS = 4000;
const WALK_DESCENT_MIN_MS = 300;
const WALK_DESCENT_MAX_MS = 1500;
const WALK_BFS_MIN_MS = 300;
const WALK_BFS_MAX_MS = 1500;
/** Result-pulse window appended after the BFS phase. */
const WALK_PULSE_MS = 900;

/** Hard upper bound on a replay's length: every phase ceiling plus the pulse. */
export const WALK_MAX_TOTAL_MS =
  WALK_LOCATE_MAX_MS + WALK_DESCENT_MAX_MS + WALK_BFS_MAX_MS + WALK_PULSE_MS;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Phase boundaries for one walk replay, derived solely from the WINNER's trace
 * sizes (the path the user follows and the one the status line reports). Because
 * each phase duration is clamped to a fixed ceiling, `totalEnd` never exceeds
 * {@link WALK_MAX_TOTAL_MS} regardless of how large any tile's trace is.
 */
export function walkTimeline(winner: WalkCounts): WalkTimeline {
  const locateDur = clamp(
    winner.locate * WALK_LOCATE_MS_PER_HOP,
    WALK_LOCATE_MIN_MS,
    WALK_LOCATE_MAX_MS,
  );
  const descentDur = clamp(
    winner.descent * WALK_DESCENT_MS_PER_STEP,
    WALK_DESCENT_MIN_MS,
    WALK_DESCENT_MAX_MS,
  );
  const bfsDur = clamp(
    winner.bfs * WALK_BFS_MS_PER_STEP,
    WALK_BFS_MIN_MS,
    WALK_BFS_MAX_MS,
  );
  const locateEnd = locateDur;
  const descentEnd = locateEnd + descentDur;
  const bfsEnd = descentEnd + bfsDur;
  return { locateEnd, descentEnd, bfsEnd, totalEnd: bfsEnd + WALK_PULSE_MS };
}

/**
 * How many items of a phase to draw at `elapsed` ms, given the phase spans
 * `[start, start + duration]` and holds `count` items. Proportional: 0 at/before
 * the start, exactly `count` at/after the end, `floor(fraction * count)` between.
 * Monotonic non-decreasing in `elapsed`; large traces advance many items per
 * frame, so every item is still drawn while the phase duration stays fixed.
 */
export function phaseIndex(
  elapsed: number,
  start: number,
  duration: number,
  count: number,
): number {
  if (count <= 0 || elapsed <= start) return 0;
  if (duration <= 0 || elapsed >= start + duration) return count;
  return Math.min(count, Math.floor(((elapsed - start) / duration) * count));
}
