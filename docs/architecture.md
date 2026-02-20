# Architecture Overview

WikiRadar is a Wikipedia-powered tour guide PWA. It uses spherical Delaunay triangulation to find nearby geotagged Wikipedia articles in O(√N) time. The system has three phases: **extract** (Wikipedia dumps → article coordinates), **pipeline** (coordinates → binary triangulation), and **app** (binary → nearest-neighbor queries → UI).

## End-to-End Data Flow

```
Wikipedia SQL Dumps (geo_tags, page, page_props)
  ↓  extract-dump.ts: download, parse, join, deduplicate
data/articles-{lang}.json  (NDJSON: title, lat, lon, desc)
  ↓  build.ts: toCartesian → convexHull → buildTriangulation → serializeBinary
data/triangulation-{lang}.bin  (Float32/Uint32 typed arrays + UTF-8 article titles)
  ↓  pipeline.yml: gzip → GitHub Release "data-latest"
  ↓  deploy.yml: download → decompress → bundle into dist/app/
GitHub Pages CDN
  ↓  query.ts: fetch → deserializeBinary → IDB cache
FlatDelaunay (typed arrays in memory)
  ↓  NearestQuery.findNearest(): triangle walk → greedy vertex walk → BFS k-nearest
k nearest articles with distances
  ↓  render.ts → detail.ts → wiki-api.ts
User-facing PWA
```

## Phase 1: Extraction

**Entry point:** `src/pipeline/extract-dump.ts` — `npm run extract -- --lang=en`

Downloads two SQL dump files from `dumps.wikimedia.org` per language:

- `page.sql.gz` — article titles and IDs (~2 GB for English)
- `geo_tags.sql.gz` — geographic coordinates linked to page IDs (~600 MB)

The extraction runs in four steps:

1. **Download** (`dump-download.ts`) — Streams dumps with progress callbacks. Files are cached in `data/dumps/` across runs.
2. **Build page map** (`extract-dump.ts: buildPageMap`) — Parses the `page` dump into a `Map<page_id, title>`. Filters to namespace 0 (articles), excludes redirects.
3. **Join & stream** (`extract-dump.ts: streamGeoArticles`) — Streams `geo_tags`, joins each row with the page map, filters to `globe=earth`, `primary=1`, valid coordinates (not Null Island), and optional bounding box. Deduplicates by title.
4. **Write NDJSON** — One JSON object per line: `{"title":"Eiffel Tower","lat":48.8584,"lon":2.2945}`

The SQL dump parser (`dump-parser.ts`) handles gzip decompression, MySQL `CREATE TABLE` schema discovery, and `INSERT INTO ... VALUES` parsing with full MySQL escape sequence support. It streams rows one at a time to keep memory usage bounded.

Descriptions are batch-fetched from the Wikidata API using Q-IDs found in the `page_props` table, adding a `desc` field to articles that have one.

**Output:** `data/articles-{lang}.json` — ~1.2M articles for English.

## Phase 2: Pipeline (Triangulation Build)

**Entry point:** `src/pipeline/build.ts` — `npm run pipeline -- --lang=en`

Reads extracted NDJSON and produces a compact binary file for the app:

1. **Read articles** — Parses NDJSON, applies optional `--limit` and `--bounds` filters.
2. **Convert to Cartesian** — `toCartesian({lat, lon})` projects each point onto a unit sphere as `[x, y, z]`.
3. **Convex hull** — `convexHull(points)` builds the 3D convex hull incrementally. On a unit sphere, hull faces are exactly the spherical Delaunay triangles.
4. **Extract Delaunay** — `buildTriangulation(hull)` enriches hull faces with circumcenters and vertex-to-triangle mappings, drops interior points, and compacts indices.
5. **Serialize** — `serializeBinary(data)` writes a compact binary format.

**Output:** `data/triangulation-{lang}.bin`

### Binary Format

```
Header (24 bytes, little-endian):
  [0..3]   vertexCount      uint32
  [4..7]   triangleCount    uint32
  [8..11]  articlesOffset   uint32
  [12..15] articlesLength   uint32
  [16..23] reserved         zeros

Numeric sections (typed array views):
  vertexPoints       Float32[V × 3]    xyz per vertex
  vertexTriangles    Uint32[V]         one incident triangle per vertex
  triangleVertices   Uint32[T × 3]     three vertex indices per triangle
  triangleNeighbors  Uint32[T × 3]     three neighbor face indices per triangle

Articles section (at articlesOffset):
  UTF-8 JSON string array of titles, zero-padded to 4-byte alignment
```

Float32 vertices give sub-meter precision on Earth. Uint32 indices and typed array views enable zero-copy deserialization in the browser. Article titles are stored separately to avoid bloating the numeric data.

## Phase 3: App (PWA Frontend)

**Root:** `src/app/` — `npm run dev`

### Startup

1. Register service worker (auto-update mode)
2. Load triangulation for stored language (default: English)
3. Show welcome screen with language selector and "Find nearby" / "Use demo data" buttons
4. On start: begin GPS watch, render article list

### Data Loading (`query.ts`)

`loadQuery()` implements a two-tier caching strategy:

1. **IDB cache hit** — Returns instantly (~1ms for 1M articles). Stores deserialized typed arrays via structured clone.
2. **Cache miss** — Fetches binary from server with streaming progress, calls `deserializeBinary()` (Float32→Float64 upcast for math precision, Uint32 views are zero-copy), caches result in IDB keyed by `triangulation-v3-{lang}`.

Background freshness checks compare the server's `Last-Modified` header against the cached value. If newer data exists, a dismissible banner prompts the user to update.

### Nearest-Neighbor Query (`query.ts: NearestQuery`)

The `NearestQuery` class wraps the flat Delaunay data and provides `findNearest(lat, lon, k)`:

1. **Triangle walk** (`flatLocate`) — Starting from `lastTriangle` (warm start), walk adjacent triangles by testing which edge the query point lies outside of. Each step crosses to the neighbor sharing that edge. Converges in O(√N) steps.
2. **Seed vertex** — The closest vertex of the containing triangle.
3. **Greedy vertex walk** — Check all Delaunay neighbors of the current best; move to any closer one. Repeat until no improvement.
4. **BFS expansion** (k > 1) — Expand from the nearest vertex through Delaunay edges, collecting max(2k, k+6) candidates. Sort by distance, return top k.

Distance uses chord length (`2 * asin(||v - q|| / 2)`) rather than `acos(dot(v, q))` to avoid catastrophic cancellation with Float32-precision coordinates.

### Rendering (`render.ts`, `detail.ts`)

**List view:**

- Article cards with distance badges
- Language selector dropdown and pause/resume button in header
- "Show more" button loads next tier (10 → 20 → 50 → 100)
- Smart re-render: if the article list is unchanged, only patches distance badges in-place (preserves dropdown/focus state)
- Re-query threshold: 15m minimum movement before recalculating

**Detail view:**

- Fetches article summary from Wikipedia REST API (`wiki-api.ts`)
- Displays thumbnail, description, extract, and links to Wikipedia and Google Maps directions
- In-memory cache for API responses

### PWA & Service Worker (`vite.config.ts`)

- Static assets (JS, CSS, HTML, SVG) are precached by Workbox
- `.bin` data files use `NetworkOnly` — deliberately excluded from SW cache so that freshness checks always hit the server (the app manages its own IDB cache)
- Wikipedia REST API responses use `StaleWhileRevalidate` (max 200 entries, 1-week expiry)
- HTTPS dev server (required for geolocation API) with `0.0.0.0` binding for phone testing

## CI/CD

### Data Pipeline (`pipeline.yml`)

Runs monthly (1st of month, 03:00 UTC) or on manual trigger. Languages processed in parallel:

1. **Extract** — Downloads Wikipedia dumps (cached between runs), joins tables, outputs NDJSON
2. **Build** — Runs pipeline to produce `.bin` files
3. **Compress** — gzip both `.json` and `.bin` outputs
4. **Publish** — Uploads `triangulation-*.bin.gz` to a `data-latest` GitHub Release

Smart merge: downloads the existing release first, so rebuilding one language preserves the others.

### Deployment (`deploy.yml`)

Runs on every push to `main`:

1. Downloads `triangulation-*.bin.gz` from `data-latest` release
2. Decompresses `.bin` files
3. Builds the app (`npm run build`)
4. Copies `.bin` files into `dist/app/`
5. Deploys to GitHub Pages

Data and app code are decoupled — data updates don't require app rebuilds, and app deploys pull the latest data from the release.

## Geometry Library

All modules live under `src/geometry/` and are shared by the pipeline and app.

### Coordinate System

Points are represented as `Point3D = [x, y, z]` on a unit sphere. `toCartesian({lat, lon})` converts geographic coordinates:

```
x = cos(lat) × cos(lon)
y = cos(lat) × sin(lon)
z = sin(lat)
```

### Convex Hull (`convex-hull.ts`)

Incremental 3D convex hull algorithm. For unit-sphere points, hull faces are exactly the spherical Delaunay triangles.

**Core predicate:** `orient3D(a, b, c, d)` — signed volume of tetrahedron. Positive means `d` is visible from face `(a, b, c)`.

**Degeneracy handling:** Points receive ~1e-6 random perturbation (reprojected onto the sphere) to prevent numerical ambiguity from coplanar/cospherical configurations.

**Per-insertion steps:**

1. Find a visible face via greedy walk from previous insertion point
2. BFS to discover all connected visible faces
3. Collect horizon edges (boundary between visible and non-visible)
4. Delete visible faces, create new faces connecting horizon to new point
5. Relink adjacency via half-edge map (edge `a→b` encoded as `a × N + b`)

**Spatial index:** `FaceGrid` (up to 128³ cells, scaling with ∛N) provides O(1) fallback when the greedy walk fails.

### Delaunay Triangulation (`delaunay.ts`)

`buildTriangulation(hull)` enriches hull output:

- Computes circumcenter and circumradius for each triangle
- Builds vertex-to-triangle mapping (entry point for walks)
- Drops interior points (those not on the hull), remaps indices
- Returns `SphericalDelaunay` with `originalIndices` mapping back to input

### Point Location (`point-location.ts`)

- `locateTriangle(query, hint)` — Triangle walk: O(√N) steps
- `findNearest(query)` — Locate triangle → closest vertex → greedy walk through Delaunay neighbors
- `vertexNeighbors(v)` — Walks the triangle fan around a vertex

### Serialization (`serialization.ts`)

Two formats sharing the same logical structure:

|          | JSON (`TriangulationFile`)    | Binary         |
| -------- | ----------------------------- | -------------- |
| Vertices | `number[]` (8 decimal places) | `Float32Array` |
| Indices  | `number[]`                    | `Uint32Array`  |
| Articles | `string[]`                    | UTF-8 JSON     |
| Use case | Debugging (`--json` flag)     | Production     |

`deserializeBinary()` upcasts Float32 vertices to Float64 for math operations. Uint32 sections use zero-copy typed array views directly into the ArrayBuffer.

## Key Files

```
src/pipeline/
  extract-dump.ts      Extraction entry point (SQL dumps → NDJSON)
  build.ts             Pipeline entry point (NDJSON → binary)
  dump-download.ts     Streaming download with progress
  dump-parser.ts       MySQL dump parser (gzip + SQL)
  checkpoint.ts        Resumable extraction state

src/geometry/
  index.ts             Coord conversion, distance, circumcenter
  convex-hull.ts       Incremental 3D convex hull
  delaunay.ts          Spherical Delaunay from convex hull
  point-location.ts    Triangle walk, greedy nearest-neighbor
  serialization.ts     Typed arrays ↔ binary format

src/app/
  main.ts              Bootstrap, GPS watch, language switching
  query.ts             Binary loading, IDB cache, NearestQuery class
  render.ts            Article list with distance badges
  detail.ts            Article detail via Wikipedia REST API
  location.ts          Geolocation API wrapper
  status.ts            Loading, progress, error screens
  wiki-api.ts          Wikipedia REST API client
  format.ts            Distance formatting
  types.ts             Shared types
  style.css            UI styling
  index.html           PWA root

src/lang.ts            Supported languages (en, sv, ja)

.github/workflows/
  pipeline.yml         Monthly data extraction + build
  deploy.yml           App deployment to GitHub Pages
```

## See Also

- [Nearest-Neighbor Theory](nearest-neighbor.md) — Voronoi/Delaunay theory, spherical adaptation, 3D convex hull approach, triangle walks
- [CLAUDE.md](../CLAUDE.md) — Command reference and development workflow
