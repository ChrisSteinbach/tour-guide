import {
  toCartesian,
  convexHull,
  buildTriangulation,
  sphericalDistance,
  createQueryContext,
  findNearestVertices,
  flattenTriangulation,
  toJson,
  fromJson,
  serializeBinary,
  deserializeBinary,
  BinaryFormatError,
} from "./index.js";
import type { Point3D, SphericalDelaunay } from "./index.js";

// ---------- Fixtures ----------

const WORLD_CITIES = [
  { lat: 48.8566, lon: 2.3522 }, // Eiffel Tower
  { lat: 40.7128, lon: -74.006 }, // Statue of Liberty
  { lat: 35.6762, lon: 139.6503 }, // Tokyo Tower
  { lat: -33.8688, lon: 151.2093 }, // Sydney Opera House
  { lat: 51.5074, lon: -0.1278 }, // Big Ben
  { lat: -22.9068, lon: -43.1729 }, // Christ the Redeemer
  { lat: 55.7558, lon: 37.6173 }, // Kremlin
  { lat: 1.3521, lon: 103.8198 }, // Merlion
  { lat: -1.2921, lon: 36.8219 }, // Nairobi National Park
  { lat: 64.1466, lon: -21.9426 }, // Hallgrímskirkja
];

function buildFixture(): { tri: SphericalDelaunay; points: Point3D[] } {
  const points = WORLD_CITIES.map(toCartesian);
  const hull = convexHull(points);
  const tri = buildTriangulation(hull);
  return { tri, points };
}

/** Linear scan for ground-truth nearest vertex. */
function bruteForceNearest(tri: SphericalDelaunay, query: Point3D): number {
  let bestIdx = 0;
  let bestDist = sphericalDistance(tri.vertices[0].point, query);
  for (let i = 1; i < tri.vertices.length; i++) {
    const d = sphericalDistance(tri.vertices[i].point, query);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// ---------- toJson ----------

describe("toJson", () => {
  it("produces correct array lengths", () => {
    const { tri } = buildFixture();
    const data = toJson(tri);

    expect(data.vertexCount).toBe(tri.vertices.length);
    expect(data.triangleCount).toBe(tri.triangles.length);
    expect(data.vertices.length).toBe(tri.vertices.length * 3);
    expect(data.vertexTriangles.length).toBe(tri.vertices.length);
    expect(data.triangleVertices.length).toBe(tri.triangles.length * 3);
    expect(data.triangleNeighbors.length).toBe(tri.triangles.length * 3);
  });

  it("truncates floats to at most 8 decimal places", () => {
    const { tri } = buildFixture();
    const data = toJson(tri);

    for (const v of data.vertices) {
      const s = v.toString();
      const dotIdx = s.indexOf(".");
      if (dotIdx !== -1) {
        expect(s.length - dotIdx - 1).toBeLessThanOrEqual(8);
      }
    }
  });
});

// ---------- fromJson ----------

describe("fromJson", () => {
  it("reconstructs vertex points", () => {
    const { tri } = buildFixture();
    const data = toJson(tri);
    const restored = fromJson(data);

    expect(restored.vertices.length).toBe(tri.vertices.length);
    for (let i = 0; i < tri.vertices.length; i++) {
      const orig = tri.vertices[i].point;
      const rest = restored.vertices[i].point;
      // 8-decimal truncation introduces up to ~1e-3 radian error (~6m)
      expect(sphericalDistance(orig, rest)).toBeLessThan(1e-3);
    }
  });

  it("reconstructs vertex triangles", () => {
    const { tri } = buildFixture();
    const data = toJson(tri);
    const restored = fromJson(data);

    for (let i = 0; i < tri.vertices.length; i++) {
      expect(restored.vertices[i].triangle).toBe(tri.vertices[i].triangle);
    }
  });

  it("reconstructs triangle vertices and neighbors", () => {
    const { tri } = buildFixture();
    const data = toJson(tri);
    const restored = fromJson(data);

    expect(restored.triangles.length).toBe(tri.triangles.length);
    for (let i = 0; i < tri.triangles.length; i++) {
      expect(restored.triangles[i].vertices).toEqual(tri.triangles[i].vertices);
      expect(restored.triangles[i].neighbor).toEqual(tri.triangles[i].neighbor);
    }
  });

  it("assigns identity originalIndices", () => {
    const { tri } = buildFixture();
    const data = toJson(tri);
    const restored = fromJson(data);

    expect(restored.originalIndices).toEqual(
      Array.from({ length: tri.vertices.length }, (_, i) => i),
    );
  });
});

// ---------- round-trip ----------

describe("round-trip", () => {
  it("preserves vertex positions within 1e-3 radians", () => {
    const { tri } = buildFixture();
    const data = toJson(tri);
    const restored = fromJson(data);

    for (let i = 0; i < tri.vertices.length; i++) {
      expect(
        sphericalDistance(tri.vertices[i].point, restored.vertices[i].point),
      ).toBeLessThan(1e-3);
    }
  });

  it("preserves triangle topology exactly", () => {
    const { tri } = buildFixture();
    const data = toJson(tri);
    const restored = fromJson(data);

    for (let i = 0; i < tri.triangles.length; i++) {
      expect(restored.triangles[i].vertices).toEqual(tri.triangles[i].vertices);
      expect(restored.triangles[i].neighbor).toEqual(tri.triangles[i].neighbor);
    }
  });

  it("nearest-vertex queries on deserialized data match brute-force for 50 random queries", () => {
    const { tri } = buildFixture();
    const data = toJson(tri);
    const restored = fromJson(data);
    const ctx = createQueryContext(flattenTriangulation(restored));

    // Deterministic pseudo-random via simple LCG
    let seed = 42;
    function rand(): number {
      seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
      return seed / 0x7fffffff;
    }

    for (let i = 0; i < 50; i++) {
      const lat = rand() * 180 - 90;
      const lon = rand() * 360 - 180;
      const query = toCartesian({ lat, lon });
      const walkResult = findNearestVertices(ctx, query).nearestVertex;
      const bruteResult = bruteForceNearest(restored, query);
      expect(walkResult).toBe(bruteResult);
    }
  });

  it("survives JSON.parse round-trip", () => {
    const { tri } = buildFixture();
    const data = toJson(tri);
    const json = JSON.stringify(data);
    const parsed = JSON.parse(json);
    const restored = fromJson(parsed);

    expect(restored.vertices.length).toBe(tri.vertices.length);
    expect(restored.triangles.length).toBe(tri.triangles.length);

    // Verify nearest-vertex queries still work after full JSON round-trip
    const query = toCartesian({ lat: 48.5, lon: 2.0 });
    const ctx = createQueryContext(flattenTriangulation(restored));
    const result = findNearestVertices(ctx, query).nearestVertex;
    const brute = bruteForceNearest(restored, query);
    expect(result).toBe(brute);
  });
});

// ---------- binary serialization ----------

describe("binary serialization", () => {
  it("header contains magic bytes and version", () => {
    const { tri } = buildFixture();
    const buf = serializeBinary(tri);

    const magic = new Uint8Array(buf, 0, 4);
    expect(Array.from(magic)).toEqual([0x53, 0x44, 0x4c, 0x54]); // "SDLT"
    const view = new DataView(buf);
    expect(view.getUint32(4, true)).toBe(1); // FORMAT_VERSION
  });

  it("header counts match input", () => {
    const { tri } = buildFixture();
    const buf = serializeBinary(tri);

    const view = new DataView(buf);
    expect(view.getUint32(8, true)).toBe(tri.vertices.length);
    expect(view.getUint32(12, true)).toBe(tri.triangles.length);
  });

  it("round-trips vertex positions within Float32 tolerance", () => {
    const { tri } = buildFixture();
    const buf = serializeBinary(tri);
    const { fd } = deserializeBinary(buf);

    expect(fd.vertexPoints.length).toBe(tri.vertices.length * 3);
    for (let i = 0; i < tri.vertices.length; i++) {
      const p = tri.vertices[i].point;
      expect(fd.vertexPoints[i * 3]).toBeCloseTo(p[0], 6);
      expect(fd.vertexPoints[i * 3 + 1]).toBeCloseTo(p[1], 6);
      expect(fd.vertexPoints[i * 3 + 2]).toBeCloseTo(p[2], 6);
    }
  });

  it("round-trips integer topology exactly", () => {
    const { tri } = buildFixture();
    const data = toJson(tri);
    const buf = serializeBinary(tri);
    const { fd } = deserializeBinary(buf);

    expect(Array.from(fd.vertexTriangles)).toEqual(data.vertexTriangles);
    expect(Array.from(fd.triangleVertices)).toEqual(data.triangleVertices);
    expect(Array.from(fd.triangleNeighbors)).toEqual(data.triangleNeighbors);
  });

  it("produces Float64Array vertex points (upcast from Float32)", () => {
    const { tri } = buildFixture();
    const buf = serializeBinary(tri);
    const { fd } = deserializeBinary(buf);

    expect(fd.vertexPoints).toBeInstanceOf(Float64Array);
  });

  it("binary is smaller than JSON", () => {
    const { tri } = buildFixture();
    const data = toJson(tri);
    const buf = serializeBinary(tri);

    const jsonSize = JSON.stringify(data).length;
    expect(buf.byteLength).toBeLessThan(jsonSize);
  });

  describe("payload", () => {
    it("defaults to an empty payload with payloadOffset 0 when omitted", () => {
      const { tri } = buildFixture();
      const buf = serializeBinary(tri);

      const view = new DataView(buf);
      expect(view.getUint32(16, true)).toBe(0); // payloadOffset
      expect(view.getUint32(20, true)).toBe(0); // payloadLength

      const { payload } = deserializeBinary(buf);
      expect(payload).toBeInstanceOf(Uint8Array);
      expect(payload.length).toBe(0);
    });

    it("round-trips verbatim, including a non-4-aligned length and boundary byte values", () => {
      const { tri } = buildFixture();
      // 7 bytes: not a multiple of 4, exercises padding; includes 0 and 255
      const payload = new Uint8Array([0, 1, 2, 255, 254, 3, 0]);
      const buf = serializeBinary(tri, payload);

      const { payload: restored } = deserializeBinary(buf);
      expect(Array.from(restored)).toEqual(Array.from(payload));
    });

    it("survives alongside geometry in the same buffer", () => {
      const { tri } = buildFixture();
      const payload = new Uint8Array([9, 8, 7, 6, 5]);
      const buf = serializeBinary(tri, payload);

      const { fd, payload: restoredPayload } = deserializeBinary(buf);
      expect(fd.vertexPoints.length).toBe(tri.vertices.length * 3);
      expect(fd.triangleVertices.length).toBe(tri.triangles.length * 3);
      for (let i = 0; i < tri.vertices.length; i++) {
        const p = tri.vertices[i].point;
        expect(fd.vertexPoints[i * 3]).toBeCloseTo(p[0], 6);
        expect(fd.vertexPoints[i * 3 + 1]).toBeCloseTo(p[1], 6);
        expect(fd.vertexPoints[i * 3 + 2]).toBeCloseTo(p[2], 6);
      }
      expect(Array.from(restoredPayload)).toEqual(Array.from(payload));
    });
  });

  describe("errors", () => {
    it("rejects buffer too small for header", () => {
      expect(() => deserializeBinary(new ArrayBuffer(16))).toThrow(/too small/);
      expect(() => deserializeBinary(new ArrayBuffer(16))).toThrow(
        BinaryFormatError,
      );
    });

    it("rejects wrong magic bytes", () => {
      const badBuf = new ArrayBuffer(24);
      const view = new DataView(badBuf);
      view.setUint32(0, 0x00000000, true); // not "SDLT"
      view.setUint32(4, 1, true);
      expect(() => deserializeBinary(badBuf)).toThrow(/SDLT/);
      expect(() => deserializeBinary(badBuf)).toThrow(BinaryFormatError);
    });

    it("rejects unsupported format version", () => {
      const badBuf = new ArrayBuffer(24);
      new Uint8Array(badBuf, 0, 4).set([0x53, 0x44, 0x4c, 0x54]);
      const view = new DataView(badBuf);
      view.setUint32(4, 99, true); // version=99
      expect(() => deserializeBinary(badBuf)).toThrow(/version/i);
      expect(() => deserializeBinary(badBuf)).toThrow(BinaryFormatError);
    });

    it("rejects V/T counts that exceed buffer capacity", () => {
      const badBuf = new ArrayBuffer(24);
      new Uint8Array(badBuf, 0, 4).set([0x53, 0x44, 0x4c, 0x54]);
      const view = new DataView(badBuf);
      view.setUint32(4, 1, true); // version=1
      view.setUint32(8, 0xffffffff, true); // V=huge
      view.setUint32(12, 0, true); // T=0
      expect(() => deserializeBinary(badBuf)).toThrow(/too small for V=/i);
      expect(() => deserializeBinary(badBuf)).toThrow(BinaryFormatError);
    });

    it("rejects garbage T count that exceeds buffer", () => {
      const badBuf = new ArrayBuffer(24);
      new Uint8Array(badBuf, 0, 4).set([0x53, 0x44, 0x4c, 0x54]);
      const view = new DataView(badBuf);
      view.setUint32(4, 1, true); // version=1
      view.setUint32(8, 0, true); // V=0
      view.setUint32(12, 0xffffffff, true); // T=huge
      expect(() => deserializeBinary(badBuf)).toThrow(/too small for V=/i);
      expect(() => deserializeBinary(badBuf)).toThrow(BinaryFormatError);
    });

    it("rejects payload offset that overlaps numeric data", () => {
      // V=0, T=0 so numeric data ends right at HEADER_SIZE (24); claim the
      // payload starts inside the header instead, which must be rejected.
      const badBuf = new ArrayBuffer(32);
      new Uint8Array(badBuf, 0, 4).set([0x53, 0x44, 0x4c, 0x54]);
      const view = new DataView(badBuf);
      view.setUint32(4, 1, true); // version=1
      view.setUint32(8, 0, true); // V=0
      view.setUint32(12, 0, true); // T=0
      view.setUint32(16, 4, true); // payloadOffset=4 — overlaps header
      view.setUint32(20, 4, true); // payloadLength=4
      expect(() => deserializeBinary(badBuf)).toThrow(/overlaps/i);
      expect(() => deserializeBinary(badBuf)).toThrow(BinaryFormatError);
    });

    it("rejects payload extending beyond the buffer", () => {
      const badBuf = new ArrayBuffer(24);
      new Uint8Array(badBuf, 0, 4).set([0x53, 0x44, 0x4c, 0x54]);
      const view = new DataView(badBuf);
      view.setUint32(4, 1, true); // version=1
      view.setUint32(8, 0, true); // V=0
      view.setUint32(12, 0, true); // T=0
      view.setUint32(16, 24, true); // payloadOffset=24
      view.setUint32(20, 100, true); // payloadLength=100 — extends beyond
      expect(() => deserializeBinary(badBuf)).toThrow(/extends beyond/i);
      expect(() => deserializeBinary(badBuf)).toThrow(BinaryFormatError);
    });
  });
});
