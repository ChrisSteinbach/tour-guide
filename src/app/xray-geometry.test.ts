import {
  buildTriangulation,
  convexHull,
  serialize,
  toCartesian,
} from "../geometry";
import type { FlatDelaunay, Point3D } from "../geometry";
import { toFlatDelaunay } from "./query";
import {
  MAX_MESH_EDGE_RAD,
  meshSegments,
  phaseIndex,
  tileBufferRing,
  tileCoreBounds,
  tileHueIndex,
  WALK_MAX_TOTAL_MS,
  walkTimeline,
} from "./xray-geometry";

// ---------- Fixtures ----------

/** Build a FlatDelaunay from raw unit-sphere points (titles are irrelevant). */
function flatFromPoints(points: Point3D[]): FlatDelaunay {
  const hull = convexHull(points);
  const tri = buildTriangulation(hull);
  const articles = tri.vertices.map((_, i) => ({ title: `V${i}` }));
  return toFlatDelaunay(serialize(tri, articles));
}

/**
 * A 5×5 grid of points spanning ±10° around (0, 0). Adjacent points sit ~5°
 * apart (well under MAX_MESH_EDGE_RAD), while the facets that close the convex
 * hull behind the cap span ≥20° (well over it) — a clean separation for
 * exercising the long-edge filter.
 */
function capGrid(): Point3D[] {
  const points: Point3D[] = [];
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      const lat = -10 + 5 * i;
      const lon = -10 + 5 * j;
      points.push(toCartesian({ lat, lon }));
    }
  }
  return points;
}

/** A cluster straddling the antimeridian, spanning lon 177°…183° (= -177°). */
function antimeridianCluster(): Point3D[] {
  const points: Point3D[] = [];
  for (const lat of [-3, 0, 3]) {
    for (const lon of [177, 180, -177]) {
      points.push(toCartesian({ lat, lon }));
    }
  }
  return points;
}

function edgeCount(fd: FlatDelaunay): number {
  const triangleCount = fd.triangleVertices.length / 3;
  return (3 * triangleCount) / 2;
}

// ---------- meshSegments ----------

describe("meshSegments", () => {
  it("emits each shared edge exactly once when nothing is filtered", () => {
    const fd = flatFromPoints(capGrid());
    const segments = meshSegments(fd, { unwrapLon: 0, maxEdgeRad: 100 });

    // Closed triangulation: every edge bounds exactly two triangles, so the
    // deduped edge count is 3T/2.
    expect(segments.length).toBe(edgeCount(fd));
  });

  it("filters out the long back-closure facets with the default threshold", () => {
    const fd = flatFromPoints(capGrid());
    const E = edgeCount(fd);

    const filtered = meshSegments(fd, { unwrapLon: 0 });

    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(E);
    // Every surviving edge is a genuine short mesh edge.
    expect(MAX_MESH_EDGE_RAD).toBeCloseTo(0.18, 5);
  });

  it("unwraps antimeridian segments to a contiguous run around 180°", () => {
    const fd = flatFromPoints(antimeridianCluster());

    const segments = meshSegments(fd, { unwrapLon: 180 });

    expect(segments.length).toBeGreaterThan(0);
    for (const [a, b] of segments) {
      // No endpoint snaps back to -177°; the run stays around 180°.
      expect(a[1]).toBeGreaterThan(170);
      expect(a[1]).toBeLessThan(190);
      expect(b[1]).toBeGreaterThan(170);
      expect(b[1]).toBeLessThan(190);
    }
  });

  it("leaves antimeridian segments split when unwrapped around 0°", () => {
    const fd = flatFromPoints(antimeridianCluster());

    const segments = meshSegments(fd, { unwrapLon: 0 });
    const lons = segments.flatMap(([a, b]) => [a[1], b[1]]);

    // Around lon 0 the same cluster spans both ends of the ±180° seam.
    expect(lons.some((l) => l > 90)).toBe(true);
    expect(lons.some((l) => l < -90)).toBe(true);
  });

  it("drops segments with both endpoints outside the clip bounds", () => {
    const fd = flatFromPoints(capGrid());
    const clip = { south: 5, west: 5, north: 12, east: 12 };

    const all = meshSegments(fd, { unwrapLon: 0 });
    const clipped = meshSegments(fd, { unwrapLon: 0, clip });

    expect(clipped.length).toBeGreaterThan(0);
    expect(clipped.length).toBeLessThan(all.length);
    for (const [a, b] of clipped) {
      const inA =
        a[0] >= clip.south &&
        a[0] <= clip.north &&
        a[1] >= clip.west &&
        a[1] <= clip.east;
      const inB =
        b[0] >= clip.south &&
        b[0] <= clip.north &&
        b[1] >= clip.west &&
        b[1] <= clip.east;
      expect(inA || inB).toBe(true);
    }
  });
});

// ---------- tileCoreBounds ----------

describe("tileCoreBounds", () => {
  it("derives the south-west tile from row/col", () => {
    expect(tileCoreBounds(0, 0)).toEqual({
      south: -90,
      west: -180,
      north: -85,
      east: -175,
    });
  });

  it("derives the north-east tile flush against +90°/+180°", () => {
    expect(tileCoreBounds(35, 71)).toEqual({
      south: 85,
      west: 175,
      north: 90,
      east: 180,
    });
  });
});

// ---------- tileBufferRing ----------

describe("tileBufferRing", () => {
  it("clamps the outer ring at the south pole", () => {
    const { outer, inner } = tileBufferRing(0, 18);
    expect(inner.south).toBe(-90);
    expect(outer.south).toBe(-90); // clamped, not -90.5
    expect(outer.north).toBeCloseTo(-84.5, 5);
  });

  it("clamps the outer ring at the north pole", () => {
    const { outer } = tileBufferRing(35, 18);
    expect(outer.north).toBe(90); // clamped, not 90.5
    expect(outer.south).toBeCloseTo(84.5, 5);
  });

  it("lets the outer ring spill past the antimeridian on purpose", () => {
    const west = tileBufferRing(18, 0);
    expect(west.outer.west).toBeCloseTo(-180.5, 5);

    const east = tileBufferRing(18, 71);
    expect(east.outer.east).toBeCloseTo(180.5, 5);
  });

  it("returns the core rectangle as the inner ring", () => {
    const { inner } = tileBufferRing(10, 20);
    expect(inner).toEqual(tileCoreBounds(10, 20));
  });
});

// ---------- tileHueIndex ----------

describe("tileHueIndex", () => {
  it("is stable for the same id", () => {
    expect(tileHueIndex("12-34", 6)).toBe(tileHueIndex("12-34", 6));
  });

  it("always returns a bucket within [0, paletteSize)", () => {
    for (let row = 0; row < 36; row++) {
      for (let col = 0; col < 72; col++) {
        const id = `${String(row).padStart(2, "0")}-${String(col).padStart(2, "0")}`;
        const hue = tileHueIndex(id, 6);
        expect(hue).toBeGreaterThanOrEqual(0);
        expect(hue).toBeLessThan(6);
        expect(Number.isInteger(hue)).toBe(true);
      }
    }
  });

  it("spreads ids across more than one bucket", () => {
    const buckets = new Set<number>();
    for (let col = 0; col < 12; col++) {
      buckets.add(tileHueIndex(`10-${String(col).padStart(2, "0")}`, 6));
    }
    expect(buckets.size).toBeGreaterThan(1);
  });
});

// ---------- Walk replay timeline ----------

describe("walkTimeline", () => {
  it("bounds the total replay length even for an enormous winner trace", () => {
    // A pathological trace (huge locate walk, possibly a cycle → brute-force)
    // must not stretch the replay — every phase clamps to its ceiling.
    const t = walkTimeline({ locate: 5000, descent: 800, bfs: 800 });

    expect(t.totalEnd).toBe(WALK_MAX_TOTAL_MS);
    expect(t.totalEnd).toBeLessThanOrEqual(8000);
  });

  it("stays bounded for a 416-hop winner (the Stockholm regression case)", () => {
    // Only the winner's counts feed the timeline, so a huge off-screen
    // non-winner tile can never own the clock — this is bounded by construction.
    const t = walkTimeline({ locate: 416, descent: 2, bfs: 30 });

    expect(t.totalEnd).toBeLessThanOrEqual(8000);
  });

  it("orders the phase boundaries and reserves a pulse window after BFS", () => {
    const t = walkTimeline({ locate: 50, descent: 5, bfs: 10 });

    expect(t.locateEnd).toBeGreaterThan(0);
    expect(t.descentEnd).toBeGreaterThan(t.locateEnd);
    expect(t.bfsEnd).toBeGreaterThan(t.descentEnd);
    expect(t.totalEnd).toBeGreaterThan(t.bfsEnd);
  });

  it("floors a tiny walk so it does not flash by", () => {
    const t = walkTimeline({ locate: 1, descent: 1, bfs: 1 });

    expect(t.locateEnd).toBe(600); // locate floor
    expect(t.descentEnd).toBe(900); // + descent floor 300
    expect(t.bfsEnd).toBe(1200); // + bfs floor 300
    expect(t.totalEnd).toBe(2100); // + pulse 900
  });

  it("paces the winner locate phase at 12–70 ms per hop for typical counts", () => {
    for (const hops of [30, 60, 150, 300]) {
      const { locateEnd } = walkTimeline({ locate: hops, descent: 1, bfs: 1 });
      const msPerHop = locateEnd / hops;
      expect(msPerHop).toBeGreaterThanOrEqual(12);
      expect(msPerHop).toBeLessThanOrEqual(70);
    }
  });
});

describe("phaseIndex", () => {
  it("draws nothing at or before the phase start", () => {
    expect(phaseIndex(-50, 100, 1000, 10)).toBe(0);
    expect(phaseIndex(100, 100, 1000, 10)).toBe(0);
  });

  it("reaches exactly the full count at and after the phase end", () => {
    expect(phaseIndex(1000, 0, 1000, 10)).toBe(10);
    expect(phaseIndex(9999, 0, 1000, 10)).toBe(10);
  });

  it("interpolates proportionally — halfway through draws half the items", () => {
    expect(phaseIndex(500, 0, 1000, 10)).toBe(5);
  });

  it("advances monotonically across the phase", () => {
    let prev = -1;
    for (let elapsed = 0; elapsed <= 1000; elapsed += 25) {
      const idx = phaseIndex(elapsed, 0, 1000, 10);
      expect(idx).toBeGreaterThanOrEqual(prev);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThanOrEqual(10);
      prev = idx;
    }
  });

  it("advances a huge trace many items per frame so time stays fixed", () => {
    // ~16 ms frame within a 4000 ms phase of 5000 steps → ~20 steps/frame.
    const a = phaseIndex(1000, 0, 4000, 5000);
    const b = phaseIndex(1016, 0, 4000, 5000);

    expect(a).toBe(1250);
    expect(b - a).toBeGreaterThan(10);
  });

  it("returns 0 for an empty phase", () => {
    expect(phaseIndex(500, 0, 1000, 0)).toBe(0);
  });
});
