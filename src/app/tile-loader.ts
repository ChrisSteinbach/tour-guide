// Tile loading orchestration — fetches tile index and individual tiles on demand

import { deserializeBinary } from "spherical-delaunay";
import {
  tileFor,
  tileId,
  GRID_DEG,
  ROWS,
  EDGE_PROXIMITY_DEG,
  wrapCol,
} from "../tiles";
import type { TileEntry, TileIndex } from "../tiles";
import { tilesAtRing, MAX_RING } from "./tile-radius";
import { NearestQuery } from "./query";
import type { QueryResult } from "./query";
import { idbOpen, idbGetAny, idbPutAny, idbDelete } from "./idb";
import type { Lang } from "../lang";

const MAX_ROW = ROWS - 1; // 35

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
  const updated = lru.filter((id) => id !== tileId);
  updated.push(tileId);
  const evict = updated.splice(0, Math.max(0, updated.length - maxEntries));
  return { updated, evict };
}

/**
 * Per-key promise chain so concurrent touchLru calls for the same language
 * are serialized (adjacent tiles load concurrently, so this is common).
 */
const lruQueues = new Map<string, Promise<void>>();

/** Update LRU tracking in IDB and evict tiles over the cap. */
function touchLru(
  db: IDBDatabase,
  lang: Lang,
  tile: string,
  deps: TileLoaderDeps,
): Promise<void> {
  const lruKey = `tile-lru-v1-${lang}`;
  // Callers fire-and-forget (.catch(() => undefined)) so LRU bookkeeping
  // never blocks tile delivery. The queue retains the full chain; the leading
  // .catch ensures a failed predecessor resolves (not rejects), so subsequent
  // queued operations always run.
  const next = (lruQueues.get(lruKey) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      let lru: string[];
      try {
        const raw = await deps.getAny<string[]>(db, lruKey);
        lru = Array.isArray(raw) ? raw : [];
      } catch (e) {
        console.warn("IDB LRU list unreadable:", e);
        lru = [];
      }
      const { updated, evict } = updateLru(lru, tile);

      for (const id of evict) {
        deps
          .deleteKey(db, `tile-v1-${lang}-${id}`)
          .catch((e) => console.warn("IDB tile eviction failed:", e));
      }

      try {
        await deps.putAny(db, lruKey, updated);
      } catch (e) {
        console.warn("IDB LRU list write failed:", e);
      }
    });
  lruQueues.set(lruKey, next);
  return next;
}

// ---------- Tile query functions ----------

/** Query all loaded tiles, de-duplicate by title, sort by distance, take top-k. */
export function findNearestTiled(
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

/**
 * Returns primary and adjacent tile IDs for a position.
 * Adjacent tiles are those where the position is within EDGE_PROXIMITY_DEG of a boundary.
 */
export function tilesForPosition(
  index: Map<string, TileEntry>,
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

  // Cardinal neighbors
  if (nearSouth && row > 0) {
    adjacent.push(tileId(row - 1, col));
  }
  if (nearNorth && row < MAX_ROW) {
    adjacent.push(tileId(row + 1, col));
  }
  if (nearWest) {
    adjacent.push(tileId(row, wrapCol(col - 1)));
  }
  if (nearEast) {
    adjacent.push(tileId(row, wrapCol(col + 1)));
  }

  // Corner neighbors
  if (nearSouth && nearWest && row > 0) {
    adjacent.push(tileId(row - 1, wrapCol(col - 1)));
  }
  if (nearSouth && nearEast && row > 0) {
    adjacent.push(tileId(row - 1, wrapCol(col + 1)));
  }
  if (nearNorth && nearWest && row < MAX_ROW) {
    adjacent.push(tileId(row + 1, wrapCol(col - 1)));
  }
  if (nearNorth && nearEast && row < MAX_ROW) {
    adjacent.push(tileId(row + 1, wrapCol(col + 1)));
  }

  // Filter to tiles that exist in the index
  const existing = adjacent.filter((id) => tileExistsInMap(index, id));

  return { primary, adjacent: existing };
}

/**
 * Find the nearest existing tiles when no tiles exist at the given position.
 * Expands outward ring by ring from the position's tile until tiles are found.
 * Returns ALL tiles at the first populated ring (not capped like tilesForPosition)
 * because every tile at that distance contains "nearest" articles for the user.
 */
export function nearestExistingTiles(
  tileMap: Map<string, TileEntry>,
  lat: number,
  lon: number,
): string[] {
  const { row, col } = tileFor(lat, lon);
  for (let ring = 0; ring <= MAX_RING; ring++) {
    const tiles = tilesAtRing(row, col, ring, tileMap);
    if (tiles.length > 0) return tiles;
  }
  return [];
}

/** Build a Map<id, TileEntry> from a TileIndex for O(1) lookup. */
export function buildTileMap(index: TileIndex): Map<string, TileEntry> {
  return new Map(index.tiles.map((t) => [t.id, t]));
}

export function tileExistsInMap(
  tileMap: Map<string, TileEntry>,
  id: string,
): boolean {
  return tileMap.has(id);
}

export function getTileEntry(
  tileMap: Map<string, TileEntry>,
  id: string,
): TileEntry | undefined {
  return tileMap.get(id);
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

export interface TileLoaderDeps {
  openDb: () => Promise<IDBDatabase | null>;
  getAny: <T>(db: IDBDatabase, key: string) => Promise<T | undefined>;
  putAny: (db: IDBDatabase, key: string, value: unknown) => Promise<void>;
  deleteKey: (db: IDBDatabase, key: string) => Promise<void>;
}

export const defaultDeps: TileLoaderDeps = {
  openDb: idbOpen,
  getAny: idbGetAny,
  putAny: idbPutAny,
  deleteKey: idbDelete,
};

/**
 * Fetch tile index. Returns null on 404.
 * Caches in IDB, falls back to cached index on network error.
 */
export async function loadTileIndex(
  baseUrl: string,
  lang: Lang,
  signal?: AbortSignal,
  deps: TileLoaderDeps = defaultDeps,
): Promise<TileIndex | null> {
  const url = `${baseUrl}tiles/${lang}/index.json`;
  const cacheKey = `tile-index-v1-${lang}`;

  const db = await deps.openDb();

  try {
    const response = await fetch(url, { cache: "no-store", signal });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const index = (await response.json()) as TileIndex;

    if (!index || typeof index !== "object" || !Array.isArray(index.tiles)) {
      return null;
    }

    // Cache for offline use
    if (db) {
      deps
        .putAny(db, cacheKey, index)
        .catch((e) => console.warn("IDB tile-index cache write failed:", e));
    }

    return index;
  } catch (err) {
    // Abort — don't fall back to cache, just propagate
    if (signal?.aborted) throw err;
    // Network error — try IDB cache
    if (db) {
      try {
        const cached = await deps.getAny<TileIndex>(db, cacheKey);
        if (
          cached &&
          typeof cached === "object" &&
          Array.isArray(cached.tiles)
        ) {
          return cached;
        }
      } catch (cacheErr) {
        console.warn("IDB tile-index cache unreadable:", cacheErr);
      }
    }
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
  signal?: AbortSignal,
  deps: TileLoaderDeps = defaultDeps,
): Promise<NearestQuery> {
  const cacheKey = `tile-v1-${lang}-${entry.id}`;
  const db = await deps.openDb();

  // Check IDB cache
  if (db) {
    try {
      const cached = await deps.getAny<CachedTileData>(db, cacheKey);
      if (
        cached &&
        cached.hash === entry.hash &&
        cached.vertexPoints instanceof Float64Array &&
        cached.vertexTriangles instanceof Uint32Array &&
        cached.triangleVertices instanceof Uint32Array &&
        cached.triangleNeighbors instanceof Uint32Array &&
        Array.isArray(cached.articles) &&
        cached.articles.every((a) => typeof a === "string")
      ) {
        const query = new NearestQuery(
          {
            vertexPoints: cached.vertexPoints,
            vertexTriangles: cached.vertexTriangles,
            triangleVertices: cached.triangleVertices,
            triangleNeighbors: cached.triangleNeighbors,
          },
          cached.articles.map((title) => ({ title })),
        );
        // Touch LRU only after NearestQuery construction succeeds
        touchLru(db, lang, entry.id, deps).catch(() => undefined);
        return query;
      }
    } catch (cacheErr) {
      console.warn("IDB tile cache unreadable:", cacheErr);
    }
  }

  // Fetch from network
  const url = `${baseUrl}tiles/${lang}/${entry.id}.bin`;
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch tile ${entry.id}: HTTP ${response.status}`,
    );
  }

  const buf = await response.arrayBuffer();
  const { fd, articles } = deserializeBinary(buf);

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
    deps
      .putAny(db, cacheKey, cacheData)
      .catch((e) => console.warn("IDB tile cache write failed:", e));
    touchLru(db, lang, entry.id, deps).catch(() => undefined);
  }

  return new NearestQuery(fd, articles);
}
