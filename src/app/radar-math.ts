// Pure radar geometry — range-ring selection, polar→screen projection,
// blip hit-testing, and sweep-trail brightness. No DOM access; the
// canvas adapter in radar-view.ts consumes these.

/** Radar range scale: ring distances in meters, innermost first. */
export interface RadarRange {
  /** Full-scale range in meters (the outermost ring). */
  maxM: number;
  /** Ring distances in meters; the last entry equals `maxM`. */
  rings: number[];
}

/** Default full-scale range when there is nothing to fit yet. */
const DEFAULT_RANGE_M = 1000;

/** Smallest "nice" step (1/2/2.5/5 × 10^k meters) whose 4th multiple covers `max`. */
function niceStep(max: number): number {
  const mantissas = [1, 2, 2.5, 5];
  for (let k = 0; k < 9; k++) {
    const scale = 10 ** k;
    for (const m of mantissas) {
      const step = m * scale;
      if (4 * step >= max) return step;
    }
  }
  return 5 * 10 ** 8;
}

/**
 * Choose range rings that cover `maxDistanceM` with nice round labels.
 * Produces 3–4 rings at multiples of a 1/2/5×10^k step; the outermost
 * ring is always ≥ the requested distance.
 */
export function radarRange(maxDistanceM: number): RadarRange {
  const target =
    Number.isFinite(maxDistanceM) && maxDistanceM > 0
      ? maxDistanceM
      : DEFAULT_RANGE_M;
  const step = niceStep(target);
  const count = Math.max(3, Math.ceil(target / step));
  const rings: number[] = [];
  for (let i = 1; i <= count; i++) rings.push(i * step);
  return { maxM: rings[rings.length - 1], rings };
}

/**
 * Square-root radial scale: distance `d` of full-scale `maxM` maps to
 * `radiusPx * sqrt(d / maxM)`, clamped to `radiusPx`. Spreads the
 * nearest (most relevant) blips over most of the radar's area.
 */
export function scaleRadius(
  distanceM: number,
  maxM: number,
  radiusPx: number,
): number {
  if (maxM <= 0) return 0;
  const r = radiusPx * Math.sqrt(Math.max(0, distanceM) / maxM);
  return Math.min(r, radiusPx);
}

/**
 * Project a bearing/distance pair to an offset from the radar center.
 * `headingDeg` rotates the display (heading-up mode); pass 0 for
 * north-up. +x is right, +y is down (canvas convention); bearing 0 with
 * heading 0 points straight up.
 */
export function blipOffset(
  bearingDeg: number,
  distanceM: number,
  headingDeg: number,
  maxM: number,
  radiusPx: number,
): { x: number; y: number } {
  const r = scaleRadius(distanceM, maxM, radiusPx);
  const a = ((bearingDeg - headingDeg) * Math.PI) / 180;
  return { x: r * Math.sin(a), y: -r * Math.cos(a) };
}

/** A projected blip carrying its source item. */
export interface RadarBlip<T> {
  x: number;
  y: number;
  item: T;
}

/**
 * Nearest blip within `tolerancePx` of (x, y), or null.
 * Ties resolve to the earlier blip (closer article, given sorted input).
 */
export function hitTest<T>(
  blips: ReadonlyArray<RadarBlip<T>>,
  x: number,
  y: number,
  tolerancePx: number,
): T | null {
  let best: T | null = null;
  let bestDist = tolerancePx;
  for (const b of blips) {
    const d = Math.hypot(b.x - x, b.y - y);
    if (d < bestDist) {
      bestDist = d;
      best = b.item;
    }
  }
  return best;
}

/**
 * Brightness boost for the rotating sweep's trail: 1 when the sweep is
 * exactly on `screenAngleDeg`, fading linearly to 0 over `trailDeg`
 * behind it. Angles ahead of the sweep get 0.
 */
export function sweepTrailBoost(
  screenAngleDeg: number,
  sweepDeg: number,
  trailDeg = 120,
): number {
  const lag = (((sweepDeg - screenAngleDeg) % 360) + 360) % 360;
  return lag <= trailDeg ? 1 - lag / trailDeg : 0;
}
