// Spherical Delaunay triangulation extracted from 3D convex hull
// Each hull face is a Delaunay triangle; face adjacency is the navigation structure.

import type { Point3D } from "./index";
import type { ConvexHull } from "./convex-hull";
import { sphericalCircumcenter, sphericalDistance } from "./index";

// ---------- Types ----------

export interface DelaunayTriangle {
  /** Indices into vertices array, CCW from outside */
  vertices: [number, number, number];
  /** neighbor[i] shares edge vertices[i] → vertices[(i+1)%3] */
  neighbor: [number, number, number];
  /** Point on unit sphere equidistant to the 3 vertices */
  circumcenter: Point3D;
  /** Angular distance (radians) from circumcenter to vertices */
  circumradius: number;
}

export interface DelaunayVertex {
  /** Position on unit sphere */
  point: Point3D;
  /** Index of one incident triangle (entry point for walks) */
  triangle: number;
}

export interface SphericalDelaunay {
  vertices: DelaunayVertex[];
  triangles: DelaunayTriangle[];
  /**
   * Original input index for each vertex.
   * When all input points are on the hull, this is [0, 1, 2, ...].
   * When some points are interior (e.g. regional data on a spherical cap),
   * interior points are dropped and this maps new → original indices.
   */
  originalIndices: number[];
}

// ---------- Build ----------

/**
 * Extract a spherical Delaunay triangulation from a convex hull.
 *
 * The hull faces are already the Delaunay triangles — this function
 * enriches them with circumcenters, circumradii, and a vertex-to-triangle
 * mapping needed by triangle-walk nearest-neighbor queries.
 */
export function buildTriangulation(hull: ConvexHull): SphericalDelaunay {
  const { points, faces } = hull;

  // Build triangles from hull faces
  const triangles: DelaunayTriangle[] = faces.map((face) => {
    const [ia, ib, ic] = face.vertices;
    const cc = sphericalCircumcenter(points[ia], points[ib], points[ic]);
    const cr = sphericalDistance(cc, points[ia]);

    return {
      vertices: [face.vertices[0], face.vertices[1], face.vertices[2]],
      neighbor: [face.neighbor[0], face.neighbor[1], face.neighbor[2]],
      circumcenter: cc,
      circumradius: cr,
    };
  });

  // Build vertex-to-triangle mapping
  // For each point, find one triangle that references it
  const vertexTriangle = new Int32Array(points.length).fill(-1);
  for (let ti = 0; ti < triangles.length; ti++) {
    for (const vi of triangles[ti].vertices) {
      if (vertexTriangle[vi] === -1) {
        vertexTriangle[vi] = ti;
      }
    }
  }

  // Collect hull vertices (those that appear in at least one triangle)
  // and remap indices so the output is compact with no gaps.
  const originalIndices: number[] = [];
  const oldToNew = new Int32Array(points.length).fill(-1);
  for (let i = 0; i < points.length; i++) {
    if (vertexTriangle[i] >= 0) {
      oldToNew[i] = originalIndices.length;
      originalIndices.push(i);
    }
  }

  const vertices: DelaunayVertex[] = originalIndices.map((oldIdx) => ({
    point: points[oldIdx],
    triangle: vertexTriangle[oldIdx],
  }));

  // Remap triangle vertex indices from old → new
  for (const tri of triangles) {
    tri.vertices = [
      oldToNew[tri.vertices[0]],
      oldToNew[tri.vertices[1]],
      oldToNew[tri.vertices[2]],
    ];
  }

  return { vertices, triangles, originalIndices };
}
