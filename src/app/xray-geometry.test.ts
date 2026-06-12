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
  tileBufferRing,
  tileCoreBounds,
  tileHueIndex,
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
