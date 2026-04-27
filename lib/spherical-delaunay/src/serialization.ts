// Serialization/deserialization for SphericalDelaunay triangulations
// Converts the object graph to flat arrays for compact JSON storage
// Also supports compact binary format for efficient network transfer

import type {
  SphericalDelaunay,
  DelaunayVertex,
  DelaunayTriangle,
} from "./delaunay";
import type { Point3D } from "./index";

// ---------- Types ----------

export interface ArticleMeta {
  title: string;
}

export interface TriangulationFile {
  vertexCount: number;
  triangleCount: number;
  vertices: number[]; // flat [x0,y0,z0, ...] — 3 per vertex
  vertexTriangles: number[]; // 1 per vertex (incident triangle index)
  triangleVertices: number[]; // flat [v0,v1,v2, ...] — 3 per triangle
  triangleNeighbors: number[]; // flat [n0,n1,n2, ...] — 3 per triangle
  articles: string[]; // title per vertex
}

/** Flat typed-array representation of a spherical Delaunay triangulation. */
export interface FlatDelaunay {
  vertexPoints: Float64Array; // [x0,y0,z0, x1,y1,z1, ...] — 3 per vertex
  vertexTriangles: Uint32Array; // incident triangle index per vertex
  triangleVertices: Uint32Array; // [v0,v1,v2, ...] — 3 per triangle
  triangleNeighbors: Uint32Array; // [n0,n1,n2, ...] — 3 per triangle
}

// ---------- Serialize ----------

/** Truncate a float to 8 decimal places (~1mm precision on unit sphere) */
function truncate8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

/**
 * Serialize a SphericalDelaunay triangulation and article metadata to flat arrays.
 *
 * Skips circumcenter/circumradius — they are not used by point-location or
 * nearest-neighbor search, and can be recomputed if ever needed.
 */
export function serialize(
  tri: SphericalDelaunay,
  articles: ArticleMeta[],
): TriangulationFile {
  if (articles.length !== tri.vertices.length) {
    throw new Error(
      `Article count (${articles.length}) does not match vertex count (${tri.vertices.length})`,
    );
  }

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
    articles: articles.map((a) => a.title),
  };
}

// ---------- Deserialize ----------

/**
 * Reconstruct a SphericalDelaunay from a serialized TriangulationFile.
 *
 * Circumcenter/circumradius are omitted — they are not used by
 * locateTriangle() or findNearest().
 */
export function deserialize(data: TriangulationFile): {
  tri: SphericalDelaunay;
  articles: ArticleMeta[];
} {
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

  const articles: ArticleMeta[] = data.articles.map((title) => ({ title }));

  // After deserialization, originalIndices is identity (already compacted)
  const originalIndices = Array.from({ length: vertexCount }, (_, i) => i);
  return { tri: { vertices, triangles, originalIndices }, articles };
}

// ---------- Binary format ----------
//
// Header (24 bytes):
//   [0..3]   magic            "WKRD" (0x57 0x4B 0x52 0x44)
//   [4..7]   version          uint32 (currently 1)
//   [8..11]  vertexCount      uint32
//   [12..15] triangleCount    uint32
//   [16..19] articlesOffset   uint32
//   [20..23] articlesLength   uint32
//
// Numeric data (4-byte aligned, typed array views):
//   vertexPoints      Float32[V * 3]
//   vertexTriangles   Uint32[V]
//   triangleVertices  Uint32[T * 3]
//   triangleNeighbors Uint32[T * 3]
//
// Articles section (at articlesOffset):
//   UTF-8 JSON of string[] (titles)

const HEADER_SIZE = 24;
const MAGIC = new Uint8Array([0x57, 0x4b, 0x52, 0x44]); // "WKRD"
const FORMAT_VERSION = 1;

/** Error thrown when binary tile data is corrupt or unrecognized. */
export class BinaryFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BinaryFormatError";
  }
}

/**
 * Serialize a TriangulationFile to a compact binary ArrayBuffer.
 * Vertices are stored as Float32 (sub-meter precision on unit sphere).
 */
export function serializeBinary(data: TriangulationFile): ArrayBuffer {
  const V = data.vertexCount;
  const T = data.triangleCount;

  // Encode articles as UTF-8 JSON
  const encoder = new TextEncoder();
  const articlesBytes = encoder.encode(JSON.stringify(data.articles));

  // Compute section sizes (all 4-byte aligned)
  const vertexPointsSize = V * 3 * 4; // Float32
  const vertexTrianglesSize = V * 4; // Uint32
  const triangleVerticesSize = T * 3 * 4; // Uint32
  const triangleNeighborsSize = T * 3 * 4; // Uint32
  const numericSize =
    vertexPointsSize +
    vertexTrianglesSize +
    triangleVerticesSize +
    triangleNeighborsSize;

  const articlesOffset = HEADER_SIZE + numericSize;
  // Pad articles to 4-byte alignment
  const articlesPadded = Math.ceil(articlesBytes.byteLength / 4) * 4;
  const totalSize = articlesOffset + articlesPadded;

  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);

  // Write header
  new Uint8Array(buf, 0, 4).set(MAGIC);
  view.setUint32(4, FORMAT_VERSION, true);
  view.setUint32(8, V, true);
  view.setUint32(12, T, true);
  view.setUint32(16, articlesOffset, true);
  view.setUint32(20, articlesBytes.byteLength, true);

  // Write vertex points as Float32
  const vertexPointsArr = new Float32Array(buf, HEADER_SIZE, V * 3);
  for (let i = 0; i < V * 3; i++) {
    vertexPointsArr[i] = data.vertices[i];
  }

  // Write vertex triangles
  const vertexTrianglesArr = new Uint32Array(
    buf,
    HEADER_SIZE + vertexPointsSize,
    V,
  );
  for (let i = 0; i < V; i++) {
    vertexTrianglesArr[i] = data.vertexTriangles[i];
  }

  // Write triangle vertices
  const triangleVerticesArr = new Uint32Array(
    buf,
    HEADER_SIZE + vertexPointsSize + vertexTrianglesSize,
    T * 3,
  );
  for (let i = 0; i < T * 3; i++) {
    triangleVerticesArr[i] = data.triangleVertices[i];
  }

  // Write triangle neighbors
  const triangleNeighborsArr = new Uint32Array(
    buf,
    HEADER_SIZE + vertexPointsSize + vertexTrianglesSize + triangleVerticesSize,
    T * 3,
  );
  for (let i = 0; i < T * 3; i++) {
    triangleNeighborsArr[i] = data.triangleNeighbors[i];
  }

  // Write articles JSON bytes
  new Uint8Array(buf, articlesOffset, articlesBytes.byteLength).set(
    articlesBytes,
  );

  return buf;
}

/**
 * Deserialize a binary ArrayBuffer to FlatDelaunay + articles.
 * Creates zero-copy typed array views for Uint32 data.
 * Upcasts Float32 vertex data to Float64Array for the app's math.
 */
export function deserializeBinary(buf: ArrayBuffer): {
  fd: FlatDelaunay;
  articles: ArticleMeta[];
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
      `Invalid magic bytes: expected "WKRD", got "${String.fromCharCode(magic[0], magic[1], magic[2], magic[3])}"`,
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
  const articlesOffset = view.getUint32(16, true);
  const articlesLength = view.getUint32(20, true);

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
  if (articlesOffset < expectedNumericEnd) {
    throw new BinaryFormatError(
      `Invalid binary: articles offset ${articlesOffset} overlaps numeric data ending at ${expectedNumericEnd}`,
    );
  }
  if (articlesOffset + articlesLength > buf.byteLength) {
    throw new BinaryFormatError(
      `Invalid binary: articles section extends beyond buffer`,
    );
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

  // Parse articles JSON
  let parsed: (string | [string, string])[];
  try {
    const decoder = new TextDecoder();
    const articlesJson = decoder.decode(
      new Uint8Array(buf, articlesOffset, articlesLength),
    );
    parsed = JSON.parse(articlesJson) as (string | [string, string])[];
  } catch {
    throw new BinaryFormatError(
      `Failed to parse articles JSON: corrupt or truncated data`,
    );
  }
  const articles = parsed.map((entry) => ({
    title: Array.isArray(entry) ? entry[0] : entry,
  }));

  return {
    fd: { vertexPoints, vertexTriangles, triangleVertices, triangleNeighbors },
    articles,
  };
}
