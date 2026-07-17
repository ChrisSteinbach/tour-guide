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
import type { ArticleMeta } from "../article-payload";

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
  private articles: ArticleMeta[];

  constructor(fd: FlatDelaunay, articles: ArticleMeta[]) {
    this.ctx = createQueryContext(fd);
    this.articles = articles;
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
        filter:
          minWeight !== undefined
            ? (vertex) => (this.articles[vertex].weight ?? 0) >= minWeight
            : undefined,
        trace: opts?.trace,
      },
    );

    // lastTriangle is the walk-start optimization for the next query —
    // always derived from the unfiltered nearest vertex.
    return {
      results: hits.map((hit) => this.buildResult(hit)),
      lastTriangle: this.ctx.fd.vertexTriangles[nearestVertex],
    };
  }

  private buildResult(hit: VertexHit): QueryResult {
    const { lat, lon } = vertexLatLon(this.ctx.fd, hit.vertex);
    return {
      title: this.articles[hit.vertex].title,
      lat,
      lon,
      distanceM: hit.distance * EARTH_RADIUS_M,
      weight: this.articles[hit.vertex].weight ?? 0,
    };
  }

  /** The underlying triangulation arrays. Callers must not mutate them. */
  get delaunay(): FlatDelaunay {
    return this.ctx.fd;
  }

  /** Title of the article at a vertex index. */
  articleTitle(vertex: number): string {
    return this.articles[vertex].title;
  }

  /** Weight class of the article at a vertex index; 0 when absent. */
  articleWeight(vertex: number): number {
    return this.articles[vertex].weight ?? 0;
  }
}
