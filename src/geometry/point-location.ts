// Triangle walk point location on a spherical Delaunay triangulation
// Given a query point, walks through adjacent triangles to find the containing
// triangle, then finds the nearest vertex via greedy walk on the Delaunay graph.

import type { Point3D } from "./index";
import type { SphericalDelaunay } from "./delaunay";
import { sideOfGreatCircle, sphericalDistance } from "./index";

/**
 * Walk through the triangulation to find the triangle containing `query`.
 *
 * At each step, checks which side of each edge the query lies on. If the query
 * is outside an edge, crosses to the neighbor sharing that edge. Terminates
 * when the query is inside (all edge tests non-negative).
 *
 * Returns the index into `tri.triangles`.
 */
export function locateTriangle(
  tri: SphericalDelaunay,
  query: Point3D,
  startTriangle?: number,
): number {
  const { vertices, triangles } = tri;
  let current = startTriangle ?? vertices[0].triangle;
  const maxSteps = Math.max(triangles.length, 100);

  for (let step = 0; step < maxSteps; step++) {
    const t = triangles[current];
    let crossed = false;

    for (let e = 0; e < 3; e++) {
      const a = vertices[t.vertices[e]].point;
      const b = vertices[t.vertices[(e + 1) % 3]].point;
      if (sideOfGreatCircle(a, b, query) < 0) {
        current = t.neighbor[e];
        crossed = true;
        break;
      }
    }

    if (!crossed) return current;
  }

  // Safety fallback: should not happen on a valid triangulation
  return current;
}

/**
 * Collect all vertex indices adjacent to `vIdx` in the Delaunay graph
 * by walking the triangle fan around the vertex.
 */
function vertexNeighbors(tri: SphericalDelaunay, vIdx: number): number[] {
  const startTri = tri.vertices[vIdx].triangle;
  const neighbors: number[] = [];
  let currentTri = startTri;

  do {
    const t = tri.triangles[currentTri];
    let k = 0;
    for (let i = 0; i < 3; i++) {
      if (t.vertices[i] === vIdx) {
        k = i;
        break;
      }
    }
    // The vertex after vIdx in this triangle is a neighbor
    neighbors.push(t.vertices[(k + 1) % 3]);
    // Cross edge k (from vIdx to next vertex) to the adjacent triangle
    currentTri = t.neighbor[k];
  } while (currentTri !== startTri);

  return neighbors;
}

/**
 * Find the nearest vertex to `query` in the triangulation.
 *
 * First locates the containing triangle via triangle walk, then performs a
 * greedy walk on the Delaunay graph: starting from the closest vertex of the
 * containing triangle, it checks all adjacent vertices and moves to any closer
 * one, repeating until no improvement is found.
 *
 * Returns the vertex index into `tri.vertices`.
 */
export function findNearest(
  tri: SphericalDelaunay,
  query: Point3D,
  startTriangle?: number,
): number {
  const { vertices, triangles } = tri;
  const tIdx = locateTriangle(tri, query, startTriangle);
  const t = triangles[tIdx];

  // Seed: closest vertex of the containing triangle
  let bestVertex = t.vertices[0];
  let bestDist = sphericalDistance(vertices[t.vertices[0]].point, query);
  for (let i = 1; i < 3; i++) {
    const d = sphericalDistance(vertices[t.vertices[i]].point, query);
    if (d < bestDist) {
      bestDist = d;
      bestVertex = t.vertices[i];
    }
  }

  // Greedy walk: check neighbors of current best, move if closer
  let improved = true;
  while (improved) {
    improved = false;
    for (const nIdx of vertexNeighbors(tri, bestVertex)) {
      const d = sphericalDistance(vertices[nIdx].point, query);
      if (d < bestDist) {
        bestDist = d;
        bestVertex = nIdx;
        improved = true;
        break;
      }
    }
  }

  return bestVertex;
}
