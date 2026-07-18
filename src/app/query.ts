// Client-side nearest-neighbor query adapter.
// Wraps the geometry library's flat-array queries with article metadata:
// titles, weight classes, and distances in meters.

import type {
  FlatDelaunay,
  QueryContext,
  VertexHit,
  WalkTrace,
} from "spherical-delaunay";
import {
  createQueryContext,
  findNearestVertices,
  toCartesian,
  vertexLatLon,
} from "spherical-delaunay";
import type { VertexArticles } from "../article-payload";

const EARTH_RADIUS_M = 6_371_000;

// ---------- Types ----------

export interface QueryResult {
  title: string;
  lat: number;
  lon: number;
  distanceM: number;
  /** Article weight class (0-255); 0 when the article has none. */
  weight: number;
}

export interface FindNearestOptions {
  /**
   * Only articles with weight >= minWeight count as results. Non-matching
   * articles are still traversed during expansion — they are part of the
   * triangulation graph, and the nearest matches may sit behind them.
   */
  minWeight?: number;
  /**
   * When provided, the query fills this trace as it runs. Must never change
   * results — the untraced and traced paths return byte-identical output.
   */
  trace?: WalkTrace;
}

// ---------- NearestQuery ----------

export class NearestQuery {
  readonly size: number;
  readonly defaultTriangle: number;
  private ctx: QueryContext;
  // One group of articles per vertex: several distinct articles can share
  // bit-identical coordinates and so collapse to a single vertex. Each group is
  // ordered most-notable first (weight desc), so `group[0]` is the vertex's
  // representative.
  private groups: VertexArticles[];

  constructor(fd: FlatDelaunay, groups: VertexArticles[]) {
    this.ctx = createQueryContext(fd);
    this.groups = groups;
    this.size = fd.vertexTriangles.length;
    this.defaultTriangle = this.ctx.anchorTriangle;
  }

  findNearest(
    lat: number,
    lon: number,
    k = 1,
    startTriangle?: number,
    opts?: FindNearestOptions,
  ): { results: QueryResult[]; lastTriangle: number } {
    const minWeight = opts?.minWeight;
    const { hits, nearestVertex } = findNearestVertices(
      this.ctx,
      toCartesian({ lat, lon }),
      k,
      {
        startTriangle,
        // A vertex qualifies when its most-notable article does (groups are
        // weight-ordered, so `group[0]` is the max); expansion below then keeps
        // only the co-located articles that individually clear the floor.
        filter:
          minWeight !== undefined
            ? (vertex) => (this.groups[vertex][0]?.weight ?? 0) >= minWeight
            : undefined,
        trace: opts?.trace,
      },
    );

    // lastTriangle is the walk-start optimization for the next query —
    // always derived from the unfiltered nearest vertex.
    return {
      results: hits.flatMap((hit) => this.buildResults(hit, minWeight)),
      lastTriangle: this.ctx.fd.vertexTriangles[nearestVertex],
    };
  }

  /**
   * Expand one vertex hit into a result per co-located article (all sharing the
   * vertex's coordinate and distance), skipping articles below `minWeight` when
   * a floor is set. Order follows the group's weight-desc ordering.
   */
  private buildResults(hit: VertexHit, minWeight?: number): QueryResult[] {
    const { lat, lon } = vertexLatLon(this.ctx.fd, hit.vertex);
    const distanceM = hit.distance * EARTH_RADIUS_M;
    const results: QueryResult[] = [];
    for (const article of this.groups[hit.vertex]) {
      const weight = article.weight ?? 0;
      if (minWeight !== undefined && weight < minWeight) continue;
      results.push({ title: article.title, lat, lon, distanceM, weight });
    }
    return results;
  }

  /** The underlying triangulation arrays. Callers must not mutate them. */
  get delaunay(): FlatDelaunay {
    return this.ctx.fd;
  }

  /** Representative (most-notable) article title at a vertex index. */
  articleTitle(vertex: number): string {
    return this.groups[vertex][0].title;
  }

  /** Representative article's weight class at a vertex index; 0 when absent. */
  articleWeight(vertex: number): number {
    return this.groups[vertex][0]?.weight ?? 0;
  }
}
