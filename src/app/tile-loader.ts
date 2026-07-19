// Tile loading orchestration — fetches tile index and individual tiles on demand

import { deserializeBinary } from "spherical-delaunay";
import { decodeArticlePayload, zipTitlesWeights } from "../article-payload";
import {
  tileFor,
  tileId,
  GRID_DEG,
  BUFFER_DEG,
  TILE_FORMAT_VERSION,
  ROWS,
  EDGE_PROXIMITY_DEG,
  wrapCol,
} from "../tiles";
import type { TileEntry, TileIndex } from "../tiles";
import { tilesAtRing, MAX_RING } from "./tile-radius";
import { NearestQuery } from "./query";
import type { FindNearestOptions, QueryResult } from "./query";
import { idbOpen, idbGetAny, idbPutAny, idbDelete } from "./idb";
import type { Lang } from "../lang";
import { recordTileLoad } from "./tile-log";

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
          .deleteKey(db, `tile-v2-${lang}-${id}`)
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
  opts?: FindNearestOptions,
): QueryResult[] {
  if (tiles.size === 0) return [];

  const seen = new Set<string>();
  const results: QueryResult[] = [];

  for (const tileQuery of tiles.values()) {
    const { results: tileResults } = tileQuery.findNearest(
      lat,
      lon,
      k,
      undefined,
      opts,
    );
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
  /** Titles per vertex — an array of co-located-article titles per vertex. */
  titles: string[][];
  /**
   * Weight class per article (0-255), flattened in vertex-major order to match
   * `titles` when zipped back together (each vertex's articles contiguous).
   */
  weights: Uint8Array;
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
 * Whether a tile index was built with the grid parameters and format version
 * this build computes tile IDs for. tile-loader recomputes tile IDs from its
 * own imported GRID_DEG (see tilesForPosition / loadTile), so an index built
 * with a different grid would make those IDs 404 or — worse — silently map to
 * tile files covering a different region, returning confident but wrong
 * nearest-neighbor results. Rejecting a mismatched index turns that latent
 * corruption into a clean data-unavailable state.
 */
export function isCompatibleIndex(index: TileIndex): boolean {
  return (
    index.version === TILE_FORMAT_VERSION &&
    index.gridDeg === GRID_DEG &&
    index.bufferDeg === BUFFER_DEG
  );
}

/**
 * Fetch tile index. Returns null on 404 or when the index is incompatible
 * with this build's grid/format (see isCompatibleIndex).
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

    if (!isCompatibleIndex(index)) {
      console.warn(
        `Tile index for "${lang}" is incompatible ` +
          `(version ${index.version}, grid ${index.gridDeg}°, buffer ${index.bufferDeg}° ` +
          `vs expected ${TILE_FORMAT_VERSION}/${GRID_DEG}/${BUFFER_DEG}); treating as unavailable.`,
      );
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
          Array.isArray(cached.tiles) &&
          isCompatibleIndex(cached)
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

// ---------- Tile fetch with retry-with-backoff ----------

/** Delay (ms) before each retry attempt. length + 1 = max fetch attempts. */
export const TILE_FETCH_RETRY_DELAYS_MS = [500, 1500];

/**
 * Wait `ms` milliseconds, or reject promptly if `signal` fires "abort"
 * during the wait. Always cleans up both the timer and the abort listener.
 */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // signal.reason is typed `any`: it's whatever the aborting caller
      // passed to controller.abort(reason), not necessarily an Error.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(
        signal?.reason ??
          new DOMException("The operation was aborted.", "AbortError"),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });
}

type TileFetchAttempt =
  | { ok: true; buf: ArrayBuffer }
  | { ok: false; retryable: boolean; error: Error };

/**
 * One fetch attempt. A rejection from fetch() or response.arrayBuffer()
 * (network error, abort, ...) is always retryable. Non-ok responses are
 * retryable only for 5xx/429 — other statuses (404, 403, ...) are
 * permanent failures.
 */
async function attemptTileFetch(
  url: string,
  id: string,
  signal?: AbortSignal,
): Promise<TileFetchAttempt> {
  try {
    const response = await fetch(url, signal ? { signal } : undefined);
    if (!response.ok) {
      const error = new Error(
        `Failed to fetch tile ${id}: HTTP ${response.status}`,
      );
      return {
        ok: false,
        retryable: response.status >= 500 || response.status === 429,
        error,
      };
    }
    const buf = await response.arrayBuffer();
    return { ok: true, buf };
  } catch (err) {
    return {
      ok: false,
      retryable: true,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/**
 * Fetch a tile .bin with retry-with-backoff for transient failures
 * (network errors, HTTP 5xx/429). Non-retryable HTTP statuses throw
 * immediately with no retry. An abort mid-fetch or mid-backoff propagates
 * immediately without further retries or delays.
 *
 * Records the outcome exactly once, at final settle, via recordTileLoad —
 * except when the signal is aborted, since an abort is cancellation, not a
 * failure, and must not pollute failure stats.
 */
async function fetchTileBuffer(
  baseUrl: string,
  lang: Lang,
  id: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const url = `${baseUrl}tiles/${lang}/${id}.bin`;
  const start = performance.now();
  const maxAttempts = TILE_FETCH_RETRY_DELAYS_MS.length + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await attemptTileFetch(url, id, signal);

    if (result.ok) {
      recordTileLoad({
        at: Date.now(),
        lang,
        id,
        source: "network",
        ok: true,
        ms: performance.now() - start,
        bytes: result.buf.byteLength,
        attempts: attempt,
      });
      return result.buf;
    }

    const aborted = signal?.aborted ?? false;
    const isLastAttempt = attempt === maxAttempts;

    if (!result.retryable || aborted || isLastAttempt) {
      if (!aborted) {
        recordTileLoad({
          at: Date.now(),
          lang,
          id,
          source: "network",
          ok: false,
          ms: performance.now() - start,
          attempts: attempt,
          error: result.error.message,
        });
      }
      throw result.error;
    }

    const delayMs = TILE_FETCH_RETRY_DELAYS_MS[attempt - 1];
    console.warn(
      `[tile] ${lang}/${id} fetch attempt ${attempt} failed (${result.error.message}); retrying in ${delayMs} ms`,
    );
    await abortableDelay(delayMs, signal);
  }

  // Unreachable: the loop above always returns or throws by the last attempt.
  throw new Error(`Failed to fetch tile ${id}: exhausted retries`);
}

/**
 * Fetch a single tile .bin, deserialize, and return a NearestQuery.
 * Caches in IDB keyed by `tile-v2-{lang}-{id}` with hash.
 * On cache hit with matching hash, returns from IDB.
 */
export async function loadTile(
  baseUrl: string,
  lang: Lang,
  entry: TileEntry,
  signal?: AbortSignal,
  deps: TileLoaderDeps = defaultDeps,
): Promise<NearestQuery> {
  const loadStart = performance.now();
  const cacheKey = `tile-v2-${lang}-${entry.id}`;
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
        cached.weights instanceof Uint8Array &&
        Array.isArray(cached.titles) &&
        cached.titles.every(
          (g) => Array.isArray(g) && g.every((t) => typeof t === "string"),
        ) &&
        cached.titles.reduce((n, g) => n + g.length, 0) ===
          cached.weights.length
      ) {
        const query = new NearestQuery(
          {
            vertexPoints: cached.vertexPoints,
            vertexTriangles: cached.vertexTriangles,
            triangleVertices: cached.triangleVertices,
            triangleNeighbors: cached.triangleNeighbors,
          },
          zipTitlesWeights(cached.titles, cached.weights),
        );
        // Touch LRU only after NearestQuery construction succeeds
        touchLru(db, lang, entry.id, deps).catch(() => undefined);
        recordTileLoad({
          at: Date.now(),
          lang,
          id: entry.id,
          source: "cache",
          ok: true,
          ms: performance.now() - loadStart,
        });
        return query;
      }
    } catch (cacheErr) {
      console.warn("IDB tile cache unreadable:", cacheErr);
    }
  }

  // Fetch from network, with retry-with-backoff for transient failures
  const buf = await fetchTileBuffer(baseUrl, lang, entry.id, signal);

  // The bytes arrived (fetchTileBuffer already recorded a successful network
  // load), but a corrupt or old-format tile makes deserialize/decode throw.
  // Record the failure so the session tile-log and console reflect why this
  // tile is missing — otherwise the fetch shows as ok and the tile silently
  // vanishes. Re-throw so the effect executor turns it into tileLoadFailed.
  let deserialized: ReturnType<typeof deserializeBinary>;
  let decoded: ReturnType<typeof decodeArticlePayload>;
  try {
    deserialized = deserializeBinary(buf);
    decoded = decodeArticlePayload(deserialized.payload);
  } catch (err) {
    recordTileLoad({
      at: Date.now(),
      lang,
      id: entry.id,
      source: "network",
      ok: false,
      ms: performance.now() - loadStart,
      error: `deserialize failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    throw err;
  }
  const { fd } = deserialized;
  const { groups } = decoded;

  // Cache in IDB
  if (db) {
    const cacheData: CachedTileData = {
      vertexPoints: fd.vertexPoints,
      vertexTriangles: fd.vertexTriangles,
      triangleVertices: fd.triangleVertices,
      triangleNeighbors: fd.triangleNeighbors,
      titles: groups.map((g) => g.map((a) => a.title)),
      weights: Uint8Array.from(
        groups.flatMap((g) => g.map((a) => a.weight ?? 0)),
      ),
      hash: entry.hash,
    };
    deps
      .putAny(db, cacheKey, cacheData)
      .catch((e) => console.warn("IDB tile cache write failed:", e));
    touchLru(db, lang, entry.id, deps).catch(() => undefined);
  }

  return new NearestQuery(fd, groups);
}
