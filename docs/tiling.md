# Geographic Tiling Strategy

The app uses geographic tiling to break the full dataset into small chunks so it can show results within seconds of getting the user's position. The app fetches a small tile index and then loads only the nearby tiles on demand.

## 1. Tile Scheme

### Fixed 5° lat/lon grid

Partition the sphere into a regular grid of 5° latitude by 5° longitude cells. Each cell that contains at least one article becomes a tile. Empty cells (open ocean, uninhabited desert) produce no tile.

Grid dimensions: 72 columns (longitude) x 36 rows (latitude) = 2,592 cells. After filtering empties, English Wikipedia yields roughly **700-900 tiles**.

Tile IDs use zero-padded row and column indices: `"14-38"` for row 14, column 38 (corresponding to 20°S–15°S, 10°E–15°E). More precisely:

```
row = min(floor((lat + 90) / 5), 35)   // 0..35,  row 0 = 90°S–85°S
col = min(floor((lon + 180) / 5), 71)  // 0..71,  col 0 = 180°W–175°W
```

This makes tile lookup from a lat/lon position a single division — no library, no lookup table.

### Why not geohash

Geohash precision levels jump 32x between levels (32 → 1,024 → 32,768 cells). There is no level that naturally maps to the ~700-1,500 tile sweet spot without either producing too few tiles (level 2 = 1,024 total, ~300 populated) or too many (level 3 = 32,768 total, ~1,500 populated but extremely uneven sizes). Geohash cells also have alternating aspect ratios and require base-32 arithmetic for adjacency lookups.

### Why not S2 cells

S2 cells provide near-uniform area coverage and are theoretically optimal. However, a simple 5° lat/lon grid is sufficient for this use case — tile lookup is a single division, the code is trivial, and the non-uniform area at high latitudes is not a practical concern: virtually no Wikipedia articles exist above 70° where the distortion becomes significant, and the buffer zone (section 2) handles any boundary effects.

### Back-of-envelope math

English Wikipedia has over a million geotagged articles (see [data-extraction.md](data-extraction.md) for current counts). With ~800 populated tiles:

| Metric                                     | Value                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Average articles per tile                  | ~1,250 (before buffer overlap; ~1,500 with buffer — see section 2)                                               |
| Bytes per article (numeric)                | ~64 (12 vertex + 4 vertexTri + 24 triVerts + 24 triNeighbors; assumes T ≈ 2V, slightly higher in buffered tiles) |
| Bytes per article (title)                  | ~25 (JSON string in array)                                                                                       |
| **Total per article**                      | **~89 bytes**                                                                                                    |
| Average tile (~1,500 articles with buffer) | ~130 KB raw, **~65 KB gzipped**                                                                                  |
| Dense tile (20,000 articles, e.g. London)  | ~1.8 MB raw, **~900 KB gzipped**                                                                                 |
| Sparse tile (100 articles)                 | ~9 KB raw, **~4 KB gzipped**                                                                                     |
| Tile index manifest                        | ~90 KB raw, **~20 KB gzipped**                                                                                   |

Estimated loading times (index + one tile, including 2x RTT). These are rough order-of-magnitude estimates assuming idealized throughput; actual performance varies significantly by carrier, congestion, signal strength, and device:

| Scenario                 | 4G (~10 Mbps) | 3G (~1 Mbps) |
| ------------------------ | ------------- | ------------ |
| Average tile             | ~0.3s         | ~1.4s        |
| Dense tile (London, NYC) | ~0.9s         | ~8s          |
| Sparse tile (rural)      | ~0.2s         | ~0.6s        |

The 3G dense-tile case exceeds 5 seconds, but dense areas (central London, Manhattan) have near-universal 4G/5G/wifi coverage. The realistic worst case — a user on 3G in a moderately dense area (~3,000 articles, ~300 KB gzipped) — loads in ~3 seconds.

**Estimated result: first useful result in <5 seconds for most realistic mobile scenarios.**

## 2. Per-Tile Triangulation

### Independent Delaunay per tile

Each tile gets its own self-contained spherical Delaunay triangulation. The pipeline builds one convex hull per tile, producing an independent binary file with its own vertex indices, triangle topology, and article list. No cross-tile references exist in the data.

This means the binary format (docs/binary-format.md) is reused unchanged — a tile file is structurally identical to a single monolithic file, just smaller.

### Buffer zone

A tile's triangulation must include articles slightly beyond its boundary. Without this, nearest-neighbor queries for users near a tile edge would miss candidates in the adjacent tile. The triangle walk (`flatLocate`) would also produce degenerate triangulations at the boundary if the point set is artificially clipped to a rectangle.

**Buffer width: 0.5°** (~55 km at the equator, scaling with cos(lat)). Each tile includes all articles within 0.5° of its 5° bounding box, giving an effective data area of 6° x 6°.

Why 0.5° is sufficient:

- In **dense areas** (cities), nearest articles are <1 km away. The buffer is massive overkill.
- In **moderate areas**, nearest articles are typically <10 km away. 55 km buffer covers them.
- In **sparse areas** (rural), nearest articles can be 50-200 km away. The 55 km buffer may not capture all cross-tile candidates, but the app loads adjacent tiles when the user is near an edge (section 4), providing full coverage.

Buffer articles are included in the triangulation and the article list. They are **not flagged** — the tile is fully self-contained. Duplicates across adjacent tiles are expected and harmless (the app de-duplicates by title when merging results).

The 0.5° buffer increases per-tile article counts by roughly 10-20%, bringing the average tile from ~130 KB to ~150 KB (~75 KB gzipped). Total data across all tiles is approximately 1.15x the monolith size.

### Pipeline

The pipeline (`src/pipeline/build.ts`) always produces tiled output:

```bash
npm run pipeline -- --lang=en
```

Pseudocode for the tiled pipeline:

```
1. Read all articles from NDJSON
2. For each populated 5° cell:
   a. Collect articles inside the cell + 0.5° buffer
   b. If fewer than 4 articles (convex hull minimum), skip the tile
   c. Build convex hull → Delaunay triangulation → serialize to binary
   d. Write tile file: data/tiles/{lang}/{row}-{col}.bin
3. Write tile index: data/tiles/{lang}/index.json
```

The existing `--bounds` flag already supports geographic subsetting of the article input. The tiled pipeline extends this to iterate over all cells.

## 3. Tile Index Format

A JSON manifest that the app fetches first. It lists every tile with enough metadata to decide what to load.

```json
{
  "version": 1,
  "gridDeg": 5,
  "bufferDeg": 0.5,
  "generated": "2026-02-01T03:00:00Z",
  "tiles": [
    {
      "id": "14-38",
      "row": 14,
      "col": 38,
      "south": -20,
      "north": -15,
      "west": 10,
      "east": 15,
      "articles": 1234,
      "bytes": 145920,
      "hash": "a1b2c3d4"
    }
  ]
}
```

| Field                           | Purpose                                                                |
| ------------------------------- | ---------------------------------------------------------------------- |
| `version`                       | Format version for future changes                                      |
| `gridDeg`                       | Cell size in degrees (5)                                               |
| `bufferDeg`                     | Buffer zone width (0.5)                                                |
| `generated`                     | ISO 8601 timestamp of pipeline run                                     |
| `hash`                          | Optional content hash of the full index (top-level cache invalidation) |
| `tiles[].id`                    | Tile identifier, used in file path: `tiles/{lang}/{id}.bin`            |
| `tiles[].row/col`               | Grid position for programmatic access                                  |
| `tiles[].south/north/west/east` | Bounding box (excluding buffer) for display/debugging                  |
| `tiles[].articles`              | Article count (excluding buffer duplicates) for UI hints               |
| `tiles[].bytes`                 | Uncompressed file size for progress estimation                         |
| `tiles[].hash`                  | Content hash (first 8 hex chars of SHA-256) for cache invalidation     |

Content hashes drive cache invalidation. When the app already has a tile cached in IDB, it compares the cached hash against the index. Changed hash → refetch tile. Unchanged → skip.

**Manifest size**: ~800 tiles x ~110 bytes JSON ≈ 90 KB raw. Gzipped: **~20 KB**. Well under the 100 KB target.

## 4. Boundary Handling

### Loading strategy

When the user's position is known, the app:

1. **Fetches the tile index** (if not already cached). This is small and cacheable in IDB.
2. **Determines the primary tile** from `min(floor((lat+90)/5), 35)` and `min(floor((lon+180)/5), 71)` via `tilesForPosition()` in `tile-loader.ts`. If no tiles exist at the user's position (primary + adjacent), `loadTilesForPosition()` in `effect-executor.ts` falls back to `nearestExistingTiles()` (which calls `tilesAtRing()` at increasing Chebyshev distances) up to `MAX_RING` until populated tiles are found. This handles positions in open ocean or other unpopulated areas where no local tiles were generated by the pipeline.
3. **Fetches and deserializes the primary tile**. For GPS flow, shows results immediately (existing tiles may already cover the position). For pick-position flow, the user sees a loading spinner while tiles are fetched for the new location (stale tiles are cleared first).
4. **Checks proximity to edges**. If the user is within 1° of any tile boundary, identifies adjacent tiles that should be loaded.
5. **Prefetches adjacent tiles** in the background (up to 8 adjacent tiles when near a corner, typically 1-2).
6. **Merges results** when adjacent tiles finish loading.

### Cross-tile query merging

The simplest correct approach: query each loaded tile's `NearestQuery` independently, concatenate all results, de-duplicate by title, sort by distance, and take the top k.

```typescript
function findNearestTiled(
  tiles: ReadonlyMap<string, NearestQuery>,
  lat: number,
  lon: number,
  k = 1,
): QueryResult[] {
  if (tiles.size === 0) return [];

  const seen = new Set<string>();
  const results: QueryResult[] = [];

  for (const tileQuery of tiles.values()) {
    const { results: tileResults } = tileQuery.findNearest(lat, lon, k);
    for (const r of tileResults) {
      if (!seen.has(r.title)) {
        seen.add(r.title);
        results.push(r);
      }
    }
  }

  results.sort((a, b) => a.distanceM - b.distanceM);
  return results.slice(0, k);
}
```

Each per-tile walk takes O(√N_tile) steps. With N_tile ≈ 1,500 instead of N = 1,200,000, this is ~39 steps vs ~1,095 steps — a 28x speedup per walk. A cross-tile query runs up to 4 walks plus a merge-sort of candidates, but even so, the total stays well under a millisecond.

### Edge proximity detection

"Near an edge" is defined as within 1° of latitude or longitude of the tile boundary. This is wider than the 0.5° buffer to ensure adjacent tiles are loaded before the buffer's coverage runs out. The check is trivial:

```typescript
const tileS = row * 5 - 90;
const tileW = col * 5 - 180;
const nearEdge =
  lat - tileS < 1 ||
  tileS + 5 - lat < 1 ||
  lon - tileW < 1 ||
  tileW + 5 - lon < 1;
```

### App loading sequence

The loading sequence:

fetch tile index (parallel with GPS) → GPS ready → fetch primary tile → query → show results

The tile index fetch is small (~20 KB gzipped) and completes well before GPS warmup (~1-3 seconds). So the effective latency is: **GPS warmup + tile fetch + deserialize**. Since tile fetch is 0.2-0.9s and deserialize is <50ms, the total is dominated by GPS warmup.

For the **demo data** path ("Use demo data" button), the app loads a hardcoded tile for the demo location (Paris / Eiffel Tower → tile row 27, col 36).

### IDB caching

Each tile is cached independently in IndexedDB, keyed by `tile-v1-{lang}-{id}` with the content hash from the manifest. On subsequent visits:

1. App fetches the tile index (always, to check for updates).
2. Compares cached tile hashes against the index.
3. Only re-fetches tiles whose hash changed.
4. Loads the primary tile from IDB in ~1ms.

To keep IDB storage bounded, each tile access updates a per-language LRU list that tracks access order. When the list exceeds 50 tiles, the least-recently-used entries are evicted from the cache. Each language maintains its own independent LRU list (`tile-lru-v1-{lang}`), so tiles for one language never displace tiles for another. Concurrent LRU updates are serialized through a per-key promise queue to avoid races.

## 5. Implementation Notes

### Binary format

The per-tile binary format is **identical** to the format documented in docs/binary-format.md. A typical tile file for 1,500 articles is ~150 KB.

The `deserializeBinary()` function in `src/geometry/serialization.ts` works unchanged on tile files.

### IDB cache keys

Tiled cache keys use three prefixes:

- `tile-index-v1-{lang}` — tile index JSON (one per language)
- `tile-v1-{lang}-{id}` — individual tile data (one entry per tile per language)
- `tile-lru-v1-{lang}` — tile LRU eviction list (tracks access order for cache eviction)

## Summary

Why tiling matters — comparison with a hypothetical monolithic approach:

| Aspect                      | Monolithic (hypothetical) | Tiled (current)                       |
| --------------------------- | ------------------------- | ------------------------------------- |
| First load                  | ~120 MB monolith          | ~20 KB index + ~75 KB tile            |
| Time to first result        | 10-100s on mobile         | **<5s on mobile**                     |
| IDB cache hit               | ~1ms                      | ~1ms (per tile)                       |
| Query speed (1.2M articles) | O(√1.2M) ≈ 1,095 steps    | O(√1,500) ≈ 39 steps                  |
| Binary format               | unchanged                 | unchanged                             |
| Total data size             | ~120 MB                   | ~138 MB (1.15x due to buffer overlap) |
| Pipeline time               | single hull build         | parallel per-tile builds              |
