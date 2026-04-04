/**
 * Generate minimal tile fixture data for E2E tests.
 *
 * Creates a tiny Delaunay triangulation with a handful of articles near
 * Paris (48.8566, 2.3522) that can be served via route interception.
 *
 * Run:  npx tsx e2e/generate-fixtures.ts
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { serializeBinary } from "../src/geometry/serialization";
import type { TriangulationFile } from "../src/geometry/serialization";
import { toCartesian } from "../src/geometry";

// ── Test articles near Paris ────────────────────────────────

interface TestArticle {
  title: string;
  lat: number;
  lon: number;
}

const articles: TestArticle[] = [
  { title: "Eiffel Tower", lat: 48.8584, lon: 2.2945 },
  { title: "Louvre Museum", lat: 48.8606, lon: 2.3376 },
  { title: "Notre-Dame de Paris", lat: 48.853, lon: 2.3499 },
  { title: "Arc de Triomphe", lat: 48.8738, lon: 2.295 },
  { title: "Sacré-Cœur", lat: 48.8867, lon: 2.3431 },
  { title: "Panthéon", lat: 48.8462, lon: 2.3464 },
  { title: "Musée d'Orsay", lat: 48.86, lon: 2.3266 },
  { title: "Place de la Concorde", lat: 48.8656, lon: 2.3212 },
  { title: "Palais Garnier", lat: 48.8719, lon: 2.3316 },
  { title: "Jardin du Luxembourg", lat: 48.8462, lon: 2.3372 },
];

// ── Build minimal Delaunay triangulation ────────────────────
//
// A valid Delaunay triangulation requires convex hull coverage.
// We create a minimal triangulation by placing 4 auxiliary points
// at the corners of the globe, then fan all test articles from
// a single shared triangle. This is geometrically invalid for
// real nearest-neighbor but sufficient for E2E tests that only
// need the tile loader to parse the binary and return articles.

function buildMinimalTriangulation(arts: TestArticle[]): TriangulationFile {
  const N = arts.length;
  // Use N vertices and 2*(N-1) triangles forming a triangle fan.
  // For simplicity: one vertex at center, rest form a fan around it.
  // Minimum valid: 3 vertices, 1 triangle.
  // We'll create a simple triangle fan from vertex 0.

  const vertices: number[] = [];
  const vertexTriangles: number[] = [];

  for (const a of arts) {
    const p = toCartesian({ lat: a.lat, lon: a.lon });
    vertices.push(p[0], p[1], p[2]);
  }

  // Triangle fan: vertex 0 connects to each consecutive pair
  const T = N - 2; // fan triangles
  const triangleVertices: number[] = [];
  const triangleNeighbors: number[] = [];

  for (let i = 0; i < T; i++) {
    triangleVertices.push(0, i + 1, i + 2);
    // Neighbors: previous, next, and -1 for boundary
    const prev = i > 0 ? i - 1 : T - 1;
    const next = i < T - 1 ? i + 1 : 0;
    triangleNeighbors.push(prev, next, next);
  }

  // Assign each vertex to its first incident triangle
  vertexTriangles.push(0); // vertex 0 is in triangle 0
  for (let i = 1; i < N; i++) {
    vertexTriangles.push(Math.min(Math.max(0, i - 1), T - 1));
  }

  return {
    vertexCount: N,
    triangleCount: T,
    vertices,
    vertexTriangles,
    triangleVertices,
    triangleNeighbors,
    articles: arts.map((a) => a.title),
  };
}

// ── Generate fixtures ───────────────────────────────────────

const tri = buildMinimalTriangulation(articles);
const bin = serializeBinary(tri);

// Tile index for "en" language with a single tile covering the Paris area
// Row 27 = (90+45)/5 = 27, Col 36 = (180+0)/5 = 36  (bounds: 45-50°N, 0-5°E)
const tileIndex = {
  version: 1,
  gridDeg: 5,
  bufferDeg: 0.5,
  generated: new Date().toISOString(),
  tiles: [
    {
      id: "27-36",
      row: 27,
      col: 36,
      south: 45,
      north: 50,
      west: 0,
      east: 5,
      articles: articles.length,
      bytes: bin.byteLength,
      hash: "e2e-fixture",
    },
  ],
};

const outDir = resolve(import.meta.dirname, "fixtures");
writeFileSync(resolve(outDir, "index.json"), JSON.stringify(tileIndex));
writeFileSync(resolve(outDir, "27-36.bin"), Buffer.from(bin));

console.log(
  `Generated fixtures: index.json (${JSON.stringify(tileIndex).length} bytes), 27-36.bin (${bin.byteLength} bytes)`,
);
console.log(`Articles: ${articles.map((a) => a.title).join(", ")}`);
