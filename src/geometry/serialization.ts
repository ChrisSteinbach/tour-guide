// Serialization/deserialization for SphericalDelaunay triangulations
// Converts the object graph to flat arrays for compact JSON storage

import type { SphericalDelaunay, DelaunayVertex, DelaunayTriangle } from "./delaunay";
import type { Point3D } from "./index";

// ---------- Types ----------

export interface ArticleMeta {
  title: string;
  desc: string;
}

export interface TriangulationFile {
  vertexCount: number;
  triangleCount: number;
  vertices: number[]; // flat [x0,y0,z0, ...] — 3 per vertex
  vertexTriangles: number[]; // 1 per vertex (incident triangle index)
  triangleVertices: number[]; // flat [v0,v1,v2, ...] — 3 per triangle
  triangleNeighbors: number[]; // flat [n0,n1,n2, ...] — 3 per triangle
  articles: [string, string][]; // [title, desc] per vertex
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

  const vertices: number[] = new Array(vertexCount * 3);
  const vertexTriangles: number[] = new Array(vertexCount);

  for (let i = 0; i < vertexCount; i++) {
    const v = tri.vertices[i];
    vertices[i * 3] = truncate8(v.point[0]);
    vertices[i * 3 + 1] = truncate8(v.point[1]);
    vertices[i * 3 + 2] = truncate8(v.point[2]);
    vertexTriangles[i] = v.triangle;
  }

  const triangleVertices: number[] = new Array(triangleCount * 3);
  const triangleNeighbors: number[] = new Array(triangleCount * 3);

  for (let i = 0; i < triangleCount; i++) {
    const t = tri.triangles[i];
    triangleVertices[i * 3] = t.vertices[0];
    triangleVertices[i * 3 + 1] = t.vertices[1];
    triangleVertices[i * 3 + 2] = t.vertices[2];
    triangleNeighbors[i * 3] = t.neighbor[0];
    triangleNeighbors[i * 3 + 1] = t.neighbor[1];
    triangleNeighbors[i * 3 + 2] = t.neighbor[2];
  }

  const articleTuples: [string, string][] = articles.map((a) => [
    a.title,
    a.desc,
  ]);

  return {
    vertexCount,
    triangleCount,
    vertices,
    vertexTriangles,
    triangleVertices,
    triangleNeighbors,
    articles: articleTuples,
  };
}

// ---------- Deserialize ----------

/**
 * Reconstruct a SphericalDelaunay from a serialized TriangulationFile.
 *
 * Circumcenter and circumradius are set to dummy values — they are not used
 * by locateTriangle() or findNearest(), and recomputing them would require
 * importing sphericalCircumcenter here. If needed, they can be recomputed
 * from the vertex positions.
 */
export function deserialize(data: TriangulationFile): {
  tri: SphericalDelaunay;
  articles: ArticleMeta[];
} {
  const { vertexCount, triangleCount } = data;

  // Reconstruct vertices
  const vertices: DelaunayVertex[] = new Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const point: Point3D = [
      data.vertices[i * 3],
      data.vertices[i * 3 + 1],
      data.vertices[i * 3 + 2],
    ];
    vertices[i] = { point, triangle: data.vertexTriangles[i] };
  }

  // Reconstruct triangles
  const dummyCenter: Point3D = [0, 0, 0];
  const triangles: DelaunayTriangle[] = new Array(triangleCount);
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
      // Not used by point-location or nearest-neighbor; set to dummy values
      circumcenter: dummyCenter,
      circumradius: 0,
    };
  }

  const articles: ArticleMeta[] = data.articles.map(([title, desc]) => ({
    title,
    desc,
  }));

  return { tri: { vertices, triangles }, articles };
}
