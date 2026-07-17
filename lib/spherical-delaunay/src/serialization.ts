// Serialization/deserialization for SphericalDelaunay triangulations
// Converts the object graph to flat arrays for compact JSON storage
// Also supports a compact binary format for efficient network transfer
//
// The library serializes only geometry. Consumers attach their own metadata
// either by wrapping toJson() output, or by passing an opaque binary payload
// to serializeBinary() — the payload round-trips verbatim and is never
// interpreted by this module.

import type {
  SphericalDelaunay,
  DelaunayVertex,
  DelaunayTriangle,
} from "./delaunay";
import type { Point3D } from "./index";

// ---------- Types ----------

export interface TriangulationFile {
  vertexCount: number;
  triangleCount: number;
  vertices: number[]; // flat [x0,y0,z0, ...] — 3 per vertex
  vertexTriangles: number[]; // 1 per vertex (incident triangle index)
  triangleVertices: number[]; // flat [v0,v1,v2, ...] — 3 per triangle
  triangleNeighbors: number[]; // flat [n0,n1,n2, ...] — 3 per triangle
}

/** Flat typed-array representation of a spherical Delaunay triangulation. */
export interface FlatDelaunay {
  vertexPoints: Float64Array; // [x0,y0,z0, x1,y1,z1, ...] — 3 per vertex
  vertexTriangles: Uint32Array; // incident triangle index per vertex
  triangleVertices: Uint32Array; // [v0,v1,v2, ...] — 3 per triangle
  triangleNeighbors: Uint32Array; // [n0,n1,n2, ...] — 3 per triangle
}

// ---------- JSON ----------

/** Truncate a float to 8 decimal places (~1mm precision on unit sphere) */
function truncate8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

/**
 * Convert a SphericalDelaunay triangulation to flat arrays suitable for JSON.
 *
 * Skips circumcenter/circumradius — they are not used by nearest-neighbor
 * search, and can be recomputed if ever needed.
 */
export function toJson(tri: SphericalDelaunay): TriangulationFile {
  const vertexCount = tri.vertices.length;
  const triangleCount = tri.triangles.length;

  const vertices = new Array<number>(vertexCount * 3);
  const vertexTriangles = new Array<number>(vertexCount);

  for (let i = 0; i < vertexCount; i++) {
    const v = tri.vertices[i];
    vertices[i * 3] = truncate8(v.point[0]);
    vertices[i * 3 + 1] = truncate8(v.point[1]);
    vertices[i * 3 + 2] = truncate8(v.point[2]);
    vertexTriangles[i] = v.triangle;
  }

  const triangleVertices = new Array<number>(triangleCount * 3);
  const triangleNeighbors = new Array<number>(triangleCount * 3);

  for (let i = 0; i < triangleCount; i++) {
    const t = tri.triangles[i];
    triangleVertices[i * 3] = t.vertices[0];
    triangleVertices[i * 3 + 1] = t.vertices[1];
    triangleVertices[i * 3 + 2] = t.vertices[2];
    triangleNeighbors[i * 3] = t.neighbor[0];
    triangleNeighbors[i * 3 + 1] = t.neighbor[1];
    triangleNeighbors[i * 3 + 2] = t.neighbor[2];
  }

  return {
    vertexCount,
    triangleCount,
    vertices,
    vertexTriangles,
    triangleVertices,
    triangleNeighbors,
  };
}

/**
 * Reconstruct a SphericalDelaunay from a TriangulationFile produced by toJson().
 *
 * Circumcenter/circumradius are omitted — they are not used by the
 * nearest-neighbor queries.
 */
export function fromJson(data: TriangulationFile): SphericalDelaunay {
  const { vertexCount, triangleCount } = data;

  // Reconstruct vertices
  const vertices = new Array<DelaunayVertex>(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const point: Point3D = [
      data.vertices[i * 3],
      data.vertices[i * 3 + 1],
      data.vertices[i * 3 + 2],
    ];
    vertices[i] = { point, triangle: data.vertexTriangles[i] };
  }

  // Reconstruct triangles
  const triangles = new Array<DelaunayTriangle>(triangleCount);
  for (let i = 0; i < triangleCount; i++) {
    triangles[i] = {
      vertices: [
        data.triangleVertices[i * 3],
        data.triangleVertices[i * 3 + 1],
        data.triangleVertices[i * 3 + 2],
      ],
      neighbor: [
        data.triangleNeighbors[i * 3],
        data.triangleNeighbors[i * 3 + 1],
        data.triangleNeighbors[i * 3 + 2],
      ],
    };
  }

  // After deserialization, originalIndices is identity (already compacted)
  const originalIndices = Array.from({ length: vertexCount }, (_, i) => i);
  return { vertices, triangles, originalIndices };
}

// ---------- Flat typed-array conversion ----------

/** Convert a TriangulationFile's flat number arrays to typed arrays. */
export function toFlatDelaunay(data: TriangulationFile): FlatDelaunay {
  return {
    vertexPoints: Float64Array.from(data.vertices),
    vertexTriangles: Uint32Array.from(data.vertexTriangles),
    triangleVertices: Uint32Array.from(data.triangleVertices),
    triangleNeighbors: Uint32Array.from(data.triangleNeighbors),
  };
}

/**
 * Convert a SphericalDelaunay object graph to the flat typed-array
 * representation the query functions operate on. For consumers that build
 * a triangulation and query it in-memory, without a serialization
 * round-trip. Circumcenters/circumradii are dropped.
 */
export function flattenTriangulation(tri: SphericalDelaunay): FlatDelaunay {
  const V = tri.vertices.length;
  const T = tri.triangles.length;
  const vertexPoints = new Float64Array(V * 3);
  const vertexTriangles = new Uint32Array(V);
  for (let i = 0; i < V; i++) {
    const v = tri.vertices[i];
    vertexPoints[i * 3] = v.point[0];
    vertexPoints[i * 3 + 1] = v.point[1];
    vertexPoints[i * 3 + 2] = v.point[2];
    vertexTriangles[i] = v.triangle;
  }
  const triangleVertices = new Uint32Array(T * 3);
  const triangleNeighbors = new Uint32Array(T * 3);
  for (let i = 0; i < T; i++) {
    const t = tri.triangles[i];
    triangleVertices[i * 3] = t.vertices[0];
    triangleVertices[i * 3 + 1] = t.vertices[1];
    triangleVertices[i * 3 + 2] = t.vertices[2];
    triangleNeighbors[i * 3] = t.neighbor[0];
    triangleNeighbors[i * 3 + 1] = t.neighbor[1];
    triangleNeighbors[i * 3 + 2] = t.neighbor[2];
  }
  return { vertexPoints, vertexTriangles, triangleVertices, triangleNeighbors };
}

// ---------- Binary format ----------
//
// Header (24 bytes):
//   [0..3]   magic            "SDLT" (0x53 0x44 0x4c 0x54)
//   [4..7]   version          uint32 (currently 1)
//   [8..11]  vertexCount      uint32
//   [12..15] triangleCount    uint32
//   [16..19] payloadOffset    uint32 (0 if no payload)
//   [20..23] payloadLength    uint32
//
// Numeric data (4-byte aligned, typed array views):
//   vertexPoints      Float32[V * 3]
//   vertexTriangles   Uint32[V]
//   triangleVertices  Uint32[T * 3]
//   triangleNeighbors Uint32[T * 3]
//
// Optional payload (at payloadOffset, immediately after triangleNeighbors):
//   opaque bytes, consumer-defined — this module copies them verbatim and
//   never interprets their contents. Total buffer size is padded so the
//   payload ends on a 4-byte boundary.

const HEADER_SIZE = 24;
const MAGIC = new Uint8Array([0x53, 0x44, 0x4c, 0x54]); // "SDLT"
const FORMAT_VERSION = 1;

/** Error thrown when binary tile data is corrupt or unrecognized. */
export class BinaryFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BinaryFormatError";
  }
}

/**
 * Serialize a SphericalDelaunay triangulation to a compact binary ArrayBuffer.
 * Vertices are stored as Float32 (sub-meter precision on unit sphere).
 *
 * `payload`, if provided, is an opaque byte blob the caller controls (e.g.
 * consumer-defined metadata). It is copied verbatim after the geometry and
 * is never interpreted by this module.
 */
export function serializeBinary(
  tri: SphericalDelaunay,
  payload?: Uint8Array,
): ArrayBuffer {
  const V = tri.vertices.length;
  const T = tri.triangles.length;

  // Compute section sizes (all numeric sections are 4-byte aligned)
  const vertexPointsSize = V * 3 * 4; // Float32
  const vertexTrianglesSize = V * 4; // Uint32
  const triangleVerticesSize = T * 3 * 4; // Uint32
  const triangleNeighborsSize = T * 3 * 4; // Uint32
  const numericSize =
    vertexPointsSize +
    vertexTrianglesSize +
    triangleVerticesSize +
    triangleNeighborsSize;

  const payloadLen = payload ? payload.byteLength : 0;
  const payloadOffset = payloadLen > 0 ? HEADER_SIZE + numericSize : 0;
  // Pad payload to 4-byte alignment
  const payloadPadded = Math.ceil(payloadLen / 4) * 4;
  const totalSize = HEADER_SIZE + numericSize + payloadPadded;

  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);

  // Write header
  new Uint8Array(buf, 0, 4).set(MAGIC);
  view.setUint32(4, FORMAT_VERSION, true);
  view.setUint32(8, V, true);
  view.setUint32(12, T, true);
  view.setUint32(16, payloadOffset, true);
  view.setUint32(20, payloadLen, true);

  // Write vertex points as Float32
  const vertexPointsArr = new Float32Array(buf, HEADER_SIZE, V * 3);
  for (let i = 0; i < V; i++) {
    const p = tri.vertices[i].point;
    vertexPointsArr[i * 3] = p[0];
    vertexPointsArr[i * 3 + 1] = p[1];
    vertexPointsArr[i * 3 + 2] = p[2];
  }

  // Write vertex triangles
  const vertexTrianglesArr = new Uint32Array(
    buf,
    HEADER_SIZE + vertexPointsSize,
    V,
  );
  for (let i = 0; i < V; i++) {
    vertexTrianglesArr[i] = tri.vertices[i].triangle;
  }

  // Write triangle vertices and neighbors
  const triangleVerticesArr = new Uint32Array(
    buf,
    HEADER_SIZE + vertexPointsSize + vertexTrianglesSize,
    T * 3,
  );
  const triangleNeighborsArr = new Uint32Array(
    buf,
    HEADER_SIZE + vertexPointsSize + vertexTrianglesSize + triangleVerticesSize,
    T * 3,
  );
  for (let i = 0; i < T; i++) {
    const t = tri.triangles[i];
    triangleVerticesArr[i * 3] = t.vertices[0];
    triangleVerticesArr[i * 3 + 1] = t.vertices[1];
    triangleVerticesArr[i * 3 + 2] = t.vertices[2];
    triangleNeighborsArr[i * 3] = t.neighbor[0];
    triangleNeighborsArr[i * 3 + 1] = t.neighbor[1];
    triangleNeighborsArr[i * 3 + 2] = t.neighbor[2];
  }

  // Write opaque payload bytes verbatim
  if (payload && payloadLen > 0) {
    new Uint8Array(buf, payloadOffset, payloadLen).set(payload);
  }

  return buf;
}

/**
 * Deserialize a binary ArrayBuffer to FlatDelaunay geometry + opaque payload.
 * Creates zero-copy typed array views for Uint32 data.
 * Upcasts Float32 vertex data to Float64Array for the app's math.
 *
 * `payload` is returned as a copy (not a view into `buf`); it is an empty
 * Uint8Array when the buffer carries no payload.
 */
export function deserializeBinary(buf: ArrayBuffer): {
  fd: FlatDelaunay;
  payload: Uint8Array;
} {
  if (buf.byteLength < HEADER_SIZE) {
    throw new BinaryFormatError(
      `Binary triangulation too small: ${buf.byteLength} bytes (need at least ${HEADER_SIZE})`,
    );
  }

  // Validate magic bytes
  const magic = new Uint8Array(buf, 0, 4);
  if (
    magic[0] !== MAGIC[0] ||
    magic[1] !== MAGIC[1] ||
    magic[2] !== MAGIC[2] ||
    magic[3] !== MAGIC[3]
  ) {
    throw new BinaryFormatError(
      `Invalid magic bytes: expected "SDLT", got "${String.fromCharCode(magic[0], magic[1], magic[2], magic[3])}"`,
    );
  }

  const view = new DataView(buf);

  // Validate version
  const version = view.getUint32(4, true);
  if (version !== FORMAT_VERSION) {
    throw new BinaryFormatError(
      `Unsupported format version: ${version} (expected ${FORMAT_VERSION})`,
    );
  }

  const V = view.getUint32(8, true);
  const T = view.getUint32(12, true);
  const payloadOffset = view.getUint32(16, true);
  const payloadLength = view.getUint32(20, true);

  // Bounds-check V/T counts against buffer size
  const vertexPointsSize = V * 3 * 4;
  const vertexTrianglesSize = V * 4;
  const triangleVerticesSize = T * 3 * 4;
  const triangleNeighborsSize = T * 3 * 4;
  const expectedNumericEnd =
    HEADER_SIZE +
    vertexPointsSize +
    vertexTrianglesSize +
    triangleVerticesSize +
    triangleNeighborsSize;

  if (expectedNumericEnd > buf.byteLength) {
    throw new BinaryFormatError(
      `Buffer too small for V=${V}, T=${T}: need ${expectedNumericEnd} bytes, got ${buf.byteLength}`,
    );
  }
  if (payloadLength > 0) {
    if (payloadOffset < expectedNumericEnd) {
      throw new BinaryFormatError(
        `Invalid binary: payload offset ${payloadOffset} overlaps numeric data ending at ${expectedNumericEnd}`,
      );
    }
    if (payloadOffset + payloadLength > buf.byteLength) {
      throw new BinaryFormatError(
        `Invalid binary: payload extends beyond buffer`,
      );
    }
  }

  // Read vertex points: Float32 → Float64
  const f32 = new Float32Array(buf, HEADER_SIZE, V * 3);
  const vertexPoints = new Float64Array(V * 3);
  for (let i = 0; i < V * 3; i++) {
    vertexPoints[i] = f32[i];
  }

  // Zero-copy typed array views for Uint32 data
  let offset = HEADER_SIZE + vertexPointsSize;
  const vertexTriangles = new Uint32Array(buf, offset, V);
  offset += vertexTrianglesSize;
  const triangleVertices = new Uint32Array(buf, offset, T * 3);
  offset += triangleVerticesSize;
  const triangleNeighbors = new Uint32Array(buf, offset, T * 3);

  const payload =
    payloadLength > 0
      ? new Uint8Array(buf.slice(payloadOffset, payloadOffset + payloadLength))
      : new Uint8Array(0);

  return {
    fd: { vertexPoints, vertexTriangles, triangleVertices, triangleNeighbors },
    payload,
  };
}
