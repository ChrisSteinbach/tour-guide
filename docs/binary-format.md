# Binary Serialization Format

The `.bin` files produced by the build pipeline (`npm run pipeline`) encode a spherical Delaunay triangulation and its associated article metadata in a single compact binary blob. This document specifies the byte-level layout so that anyone reading or modifying `src/geometry/serialization.ts` or `src/app/query.ts` knows exactly what to expect.

Notation: **V** = vertex count, **T** = triangle count. All multi-byte integers and floats are **little-endian**. All Float32/Uint32 sections are **4-byte aligned**; the Vertex Weights section is Uint8 and alignment-free.

## Overview

```mermaid
block-beta
    columns 1
    header["Header — 24 bytes (byte 0)"]
    points["Vertex Points — V × 3 × 4 bytes, Float32 (byte 24)"]
    vtri["Vertex Triangles — V × 4 bytes, Uint32"]
    trivert["Triangle Vertices — T × 3 × 4 bytes, Uint32"]
    trineigh["Triangle Neighbors — T × 3 × 4 bytes, Uint32"]
    weights["Vertex Weights — V × 1 byte, Uint8"]
    articles["Articles (+padding) — articlesLength bytes, UTF-8 JSON (byte = articlesOffset)"]
```

## Header (24 bytes)

| Offset | Size | Type   | Field          | Description                                      |
| ------ | ---- | ------ | -------------- | ------------------------------------------------ |
| 0      | 4    | bytes  | magic          | Magic bytes `0x57 0x4B 0x52 0x44` (ASCII "WKRD") |
| 4      | 4    | Uint32 | version        | Format version (currently `2`)                   |
| 8      | 4    | Uint32 | vertexCount    | Number of vertices (V)                           |
| 12     | 4    | Uint32 | triangleCount  | Number of triangles (T)                          |
| 16     | 4    | Uint32 | articlesOffset | Byte offset where the articles JSON begins       |
| 20     | 4    | Uint32 | articlesLength | Byte length of the articles JSON (unpadded)      |

The deserializer validates magic bytes and version before reading any data. Unrecognized magic bytes or unsupported versions cause an immediate `BinaryFormatError`, preventing silent misinterpretation of incompatible formats. The version check is strict: version-1 tiles (which lack the Vertex Weights section) are rejected. This is safe because the deployment workflow regenerates all tiles whenever the format changes.

## Numeric Sections

All five sections are packed contiguously starting at byte 24, in the order listed below. The first four use 4-byte elements, so alignment is naturally maintained. The fifth (Vertex Weights) uses 1-byte elements and is deliberately placed last — Uint8 needs no alignment, and the articles JSON that follows is read as raw bytes, so no padding is required anywhere.

### Vertex Points — `Float32[V * 3]`

Flat array of 3D unit-sphere Cartesian coordinates: `[x0, y0, z0, x1, y1, z1, ...]`. Each vertex occupies 3 consecutive Float32 values.

Float32 gives ~7 decimal digits of precision, which on a unit sphere corresponds to sub-meter accuracy — sufficient for geographic nearest-neighbor queries. On deserialization, the app upcasts these to Float64 for runtime math (see `deserializeBinary` in serialization.ts).

### Vertex Triangles — `Uint32[V]`

One triangle index per vertex. `vertexTriangles[i]` is the index of any triangle incident to vertex `i`. Used as the starting point for enumerating a vertex's neighbors by walking around its triangle fan.

### Triangle Vertices — `Uint32[T * 3]`

Flat array of vertex indices forming each triangle: `[v0, v1, v2, v3, v4, v5, ...]`. Triangle `t` has vertices at indices `[t*3, t*3+1, t*3+2]`. Vertices are ordered counter-clockwise when viewed from outside the sphere (consistent with the convex-hull orientation used during construction).

### Triangle Neighbors — `Uint32[T * 3]`

Flat array of adjacent triangle indices: `[n0, n1, n2, n3, n4, n5, ...]`. For triangle `t`, `triangleNeighbors[t*3 + e]` is the triangle sharing the edge from `triangleVertices[t*3 + e]` to `triangleVertices[t*3 + (e+1) % 3]`.

This adjacency structure enables O(√N) triangle-walk point location — starting from any triangle, the algorithm walks toward the query point by crossing edges until it reaches the containing triangle.

### Vertex Weights — `Uint8[V]`

One weight class per vertex, in the same order as the vertex arrays. Begins at byte `24 + V*3*4 + V*4 + T*3*4 + T*3*4`.

The weight encodes the article's popularity **percentile** among all articles in the same language build, derived from Wikimedia monthly pageviews (see [data-extraction.md](data-extraction.md#pageviews)): `class = round(255 * belowCount / N)`, where `belowCount` is the number of articles in the build with strictly fewer views and `N` is the total article count (see `assignWeightClasses` in `src/pipeline/popularity.ts`). Articles with equal view counts share a class; `0` views (no recorded views, or the article wasn't matched during the pageviews join) always maps to class `0`.

Because the scale is a percentile rather than a raw count, it self-calibrates per language: class `204` means "top 20% most-viewed" whether the build is English (over a million articles) or a small wiki dominated by bot-generated stubs. This lets the app apply one fixed threshold (`HIGHLIGHT_MIN_WEIGHT` in `src/app/config.ts`) across every language without per-language tuning. `--bounds`/`--limit` dev builds compute percentiles relative to the subset, not the full language.

## Articles Section

Begins at byte `articlesOffset` (which equals `24 + V*3*4 + V*4 + T*3*4 + T*3*4 + V`, i.e. immediately after the Vertex Weights section).

Contains a UTF-8-encoded JSON array with exactly **V** entries, one per vertex, in the same order as the vertex arrays. So `articles[i]` is the title for vertex `i`.

Each entry is a plain `string` (article title). The deserializer also accepts `[string, string]` tuples (title + description) but the serializer does not currently produce them.

The JSON byte length is stored in the header's `articlesLength` field. The section is zero-padded to a 4-byte boundary (the padding bytes are not included in `articlesLength`).

## Size Calculation

```
totalSize = 24                           // header
          + V * 3 * 4                    // vertex points
          + V * 4                        // vertex triangles
          + T * 3 * 4                    // triangle vertices
          + T * 3 * 4                    // triangle neighbors
          + V                            // vertex weights
          + ceil(articlesLength / 4) * 4 // articles JSON (padded)
```

For reference, encoding all English articles (over a million; see [data-extraction.md](data-extraction.md) for current counts) in a single file would produce ~120 MB. In practice, the tiled system produces ~800 smaller files totaling ~138 MB (see [tiling.md](tiling.md)).

## Producing and Consuming

**Writer:** `serializeBinary()` in `src/geometry/serialization.ts` — takes a `TriangulationFile` (JSON-friendly intermediate format) and returns an `ArrayBuffer`.

**Reader:** `deserializeBinary()` in `src/geometry/serialization.ts` — takes an `ArrayBuffer` and returns a `FlatDelaunay` (typed-array views), an `ArticleMeta[]` array (each entry's `weight` populated from the Vertex Weights section), and the per-vertex `weights` as a `Uint8Array`. Uint32 and Uint8 sections are zero-copy views into the original buffer. Float32 vertex data is copied into a Float64Array for runtime precision.

**Pipeline:** `src/pipeline/build.ts` calls `serialize()` then `serializeBinary()` and writes the result with `fs.writeFileSync`.

**App:** `src/app/tile-loader.ts` fetches `.bin` tile files over HTTP, calls `deserializeBinary()`, and caches the typed arrays in IndexedDB. `src/app/query.ts` wraps the deserialized data in a `NearestQuery` instance for geographic lookups.
