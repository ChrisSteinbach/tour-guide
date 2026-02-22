// Tile loading orchestration — fetches tile index and individual tiles on demand

import { deserializeBinary } from "../geometry";
import { tileFor, tileId, GRID_DEG, EDGE_PROXIMITY_DEG } from "../tiles";
import type { TileEntry, TileIndex } from "../tiles";
import { NearestQuery } from "./query";
import type { QueryResult } from "./query";
import { idbOpen, idbGetAny, idbPutAny, idbDelete } from "./idb";
import type { Lang } from "../lang";

// ---------- LRU eviction ----------

export const MAX_CACHED_TILES = 50;

/**
 * Update an LRU list: move tileId to most-recent position,
 * return IDs to evict if over the cap.
 */
export function updateLru(
  lru: string[],
  tileId: string,
  maxEntries = MAX_CACHED_TILES,
): { updated: string[]; evict: string[] } {
  const filtered = lru.filter((id) => id !== tileId);
  filtered.push(tileId);

  const evict: string[] = [];
  while (filtered.length > maxEntries) {
    evict.push(filtered.shift()!);
  }

  return { updated: filtered, evict };
}

/** Update LRU tracking in IDB and evict tiles over the cap. */
async function touchLru(
  db: IDBDatabase,
  lang: Lang,
  tile: string,
): Promise<void> {
  const lruKey = `tile-lru-v1-${lang}`;
  const lru = (await idbGetAny<string[]>(db, lruKey)) ?? [];
  const { updated, evict } = updateLru(lru, tile);

  for (const id of evict) {
    idbDelete(db, `tile-v1-${lang}-${id}`);
    console.log(`[tiles] Evicted tile ${id} from cache`);
  }

  idbPutAny(db, lruKey, updated);
}

// ---------- TiledQuery ----------

export class TiledQuery {
  private tiles = new Map<string, NearestQuery>();
  private index: TileIndex;

  constructor(index: TileIndex) {
    this.index = index;
  }

  /** Query all loaded tiles, de-duplicate by title, sort by distance, take top-k. */
  findNearest(lat: number, lon: number, k = 1): QueryResult[] {
    if (this.tiles.size === 0) return [];

    const seen = new Set<string>();
    const results: QueryResult[] = [];

    for (const tileQuery of this.tiles.values()) {
      // Ask each tile for k results — we'll merge and dedup
      const tileResults = tileQuery.findNearest(lat, lon, k);
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

  /**
   * Returns primary and adjacent tile IDs for a position.
   * Adjacent tiles are those where the position is within EDGE_PROXIMITY_DEG of a boundary.
   */
  tilesForPosition(
    lat: number,
    lon: number,
  ): { primary: string; adjacent: string[] } {
    const { row, col } = tileFor(lat, lon);
    const primary = tileId(row, col);

    const adjacent: string[] = [];

    // Compute position within the tile
    const tileSouth = row * GRID_DEG - 90;
    const tileWest = col * GRID_DEG - 180;
    const distFromSouth = lat - tileSouth;
    const distFromNorth = tileSouth + GRID_DEG - lat;
    const distFromWest = lon - tileWest;
    const distFromEast = tileWest + GRID_DEG - lon;

    const nearSouth = distFromSouth < EDGE_PROXIMITY_DEG;
    const nearNorth = distFromNorth < EDGE_PROXIMITY_DEG;
    const nearWest = distFromWest < EDGE_PROXIMITY_DEG;
    const nearEast = distFromEast < EDGE_PROXIMITY_DEG;

    const maxRow = Math.floor(180 / GRID_DEG) - 1; // 35
    const maxCol = Math.floor(360 / GRID_DEG) - 1; // 71

    // Cardinal neighbors
    if (nearSouth && row > 0) {
      adjacent.push(tileId(row - 1, col));
    }
    if (nearNorth && row < maxRow) {
      adjacent.push(tileId(row + 1, col));
    }
    if (nearWest) {
      const wCol = col > 0 ? col - 1 : maxCol; // wrap longitude
      adjacent.push(tileId(row, wCol));
    }
    if (nearEast) {
      const eCol = col < maxCol ? col + 1 : 0; // wrap longitude
      adjacent.push(tileId(row, eCol));
    }

    // Corner neighbors
    if (nearSouth && nearWest && row > 0) {
      const wCol = col > 0 ? col - 1 : maxCol;
      adjacent.push(tileId(row - 1, wCol));
    }
    if (nearSouth && nearEast && row > 0) {
      const eCol = col < maxCol ? col + 1 : 0;
      adjacent.push(tileId(row - 1, eCol));
    }
    if (nearNorth && nearWest && row < maxRow) {
      const wCol = col > 0 ? col - 1 : maxCol;
      adjacent.push(tileId(row + 1, wCol));
    }
    if (nearNorth && nearEast && row < maxRow) {
      const eCol = col < maxCol ? col + 1 : 0;
      adjacent.push(tileId(row + 1, eCol));
    }

    // Filter to tiles that exist in the index
    const existing = adjacent.filter((id) => this.tileExists(id));

    return { primary, adjacent: existing };
  }

  hasTile(id: string): boolean {
    return this.tiles.has(id);
  }

  addTile(id: string, query: NearestQuery): void {
    this.tiles.set(id, query);
  }

  tileExists(id: string): boolean {
    return this.index.tiles.some((t) => t.id === id);
  }

  getTileEntry(id: string): TileEntry | undefined {
    return this.index.tiles.find((t) => t.id === id);
  }

  get size(): number {
    return this.index.tiles.length;
  }

  get loadedTileCount(): number {
    return this.tiles.size;
  }
}

// ---------- Tile index loader ----------

interface CachedTileData {
  vertexPoints: Float64Array;
  vertexTriangles: Uint32Array;
  triangleVertices: Uint32Array;
  triangleNeighbors: Uint32Array;
  articles: string[];
  hash: string;
}

/**
 * Fetch tile index. Returns null on 404 (triggers monolithic fallback).
 * Caches in IDB, falls back to cached index on network error.
 */
export async function loadTileIndex(
  baseUrl: string,
  lang: Lang,
): Promise<TileIndex | null> {
  const url = `${baseUrl}tiles/${lang}/index.json`;
  const cacheKey = `tile-index-v1-${lang}`;

  const db = typeof indexedDB !== "undefined" ? await idbOpen() : null;

  try {
    const response = await fetch(url, { cache: "no-store" });
    if (response.status === 404) {
      console.log("[tiles] No tile index found — falling back to monolithic");
      return null;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const index = (await response.json()) as TileIndex;
    console.log(`[tiles] Index loaded: ${index.tiles.length} tiles (${lang})`);

    // Cache for offline use
    if (db) {
      idbPutAny(db, cacheKey, JSON.stringify(index));
    }

    return index;
  } catch (err) {
    // Network error — try IDB cache
    if (db) {
      const cached = await idbGetAny<string>(db, cacheKey);
      if (cached) {
        console.log("[tiles] Using cached tile index (offline)");
        return JSON.parse(cached) as TileIndex;
      }
    }
    console.warn("[tiles] Failed to load tile index:", err);
    return null;
  }
}

/**
 * Fetch a single tile .bin, deserialize, and return a NearestQuery.
 * Caches in IDB keyed by `tile-v1-{lang}-{id}` with hash.
 * On cache hit with matching hash, returns from IDB.
 */
export async function loadTile(
  baseUrl: string,
  lang: Lang,
  entry: TileEntry,
): Promise<NearestQuery> {
  const cacheKey = `tile-v1-${lang}-${entry.id}`;
  const db = typeof indexedDB !== "undefined" ? await idbOpen() : null;

  // Check IDB cache
  if (db) {
    const cached = await idbGetAny<CachedTileData>(db, cacheKey);
    if (cached && cached.hash === entry.hash) {
      console.log(`[tiles] Cache hit for tile ${entry.id}`);
      // Touch LRU (no eviction expected on a hit, but keeps order current)
      await touchLru(db, lang, entry.id);
      return new NearestQuery(
        {
          vertexPoints: cached.vertexPoints,
          vertexTriangles: cached.vertexTriangles,
          triangleVertices: cached.triangleVertices,
          triangleNeighbors: cached.triangleNeighbors,
        },
        cached.articles.map((title) => ({ title })),
      );
    }
  }

  // Fetch from network
  const url = `${baseUrl}tiles/${lang}/${entry.id}.bin`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch tile ${entry.id}: HTTP ${response.status}`,
    );
  }

  const buf = await response.arrayBuffer();
  const { fd, articles } = deserializeBinary(buf);

  console.log(
    `[tiles] Loaded tile ${entry.id}: ${articles.length} articles, ${(buf.byteLength / 1024).toFixed(0)} KB`,
  );

  // Cache in IDB
  if (db) {
    const cacheData: CachedTileData = {
      vertexPoints: fd.vertexPoints,
      vertexTriangles: fd.vertexTriangles,
      triangleVertices: fd.triangleVertices,
      triangleNeighbors: fd.triangleNeighbors,
      articles: articles.map((a) => a.title),
      hash: entry.hash,
    };
    idbPutAny(db, cacheKey, cacheData);
    await touchLru(db, lang, entry.id);
  }

  return new NearestQuery(fd, articles);
}

/** Delete old monolithic IDB cache on first tiled load. */
export async function cleanMonolithicCache(lang: Lang): Promise<void> {
  try {
    const db = typeof indexedDB !== "undefined" ? await idbOpen() : null;
    if (db) {
      idbDelete(db, `triangulation-v3-${lang}`);
      console.log(`[tiles] Cleaned up monolithic cache for ${lang}`);
    }
  } catch {
    // ignore
  }
}
