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
import { NearestQuery, EARTH_RADIUS_M } from "./query";
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

const DEG2RAD = Math.PI / 180;

/**
 * Safety margin (metres) shaved off every tile lower bound before it is used to
 * prune. The boxes bound each article's TRUE coordinate, but tile vertices are
 * stored Float32-quantized (see binary-format.md), so an article's stored
 * position can sit ~1 m outside its box. Subtracting a small margin keeps the
 * prune exact against that quantization and is negligible against the
 * kilometre-scale gaps that actually trigger pruning.
 */
const LOWER_BOUND_MARGIN_M = 10;

/**
 * Minimal angular longitude gap (degrees, 0..180) from `lon` to the interval
 * [west, east]. west/east may fall outside ±180 for antimeridian tiles, so we
 * test `lon` shifted by ±360 as well; returns 0 when `lon` lies within the span.
 */
function lonGapDeg(lon: number, west: number, east: number): number {
  let gap = Infinity;
  for (const shifted of [lon, lon + 360, lon - 360]) {
    if (shifted >= west && shifted <= east) return 0;
    gap = Math.min(gap, Math.abs(shifted - west), Math.abs(shifted - east));
  }
  return gap;
}

/**
 * A lower bound (metres) on the great-circle distance from (lat, lon) to the
 * nearest possible article in the tile with the given id — i.e. to the tile's
 * buffered coverage box (grid cell expanded by BUFFER_DEG, the exact region the
 * pipeline assigns a tile's articles from; see build.ts). It never overestimates,
 * so skipping a tile whose bound exceeds the current k-th best distance is exact.
 *
 * Two independent, individually-valid bounds, larger wins:
 *  - latitude gap: a geodesic's latitude changes no faster than its arc length,
 *    so the distance is at least R·Δlat;
 *  - longitude gap: when the query is east/west of the box, the geodesic to any
 *    box point crosses the near meridian, so the distance is at least the
 *    distance to that meridian great circle, R·asin(|cosφ·sinΔlon|).
 */
export function tileBoxLowerBoundMeters(
  id: string,
  lat: number,
  lon: number,
): number {
  const dash = id.indexOf("-");
  const row = Number(id.slice(0, dash));
  const col = Number(id.slice(dash + 1));

  const cellSouth = row * GRID_DEG - 90;
  const cellWest = col * GRID_DEG - 180;
  const south = Math.max(-90, cellSouth - BUFFER_DEG);
  const north = Math.min(90, cellSouth + GRID_DEG + BUFFER_DEG);
  const west = cellWest - BUFFER_DEG;
  const east = cellWest + GRID_DEG + BUFFER_DEG;

  const dLatDeg = lat < south ? south - lat : lat > north ? lat - north : 0;
  const dLonDeg = lonGapDeg(lon, west, east);
  if (dLatDeg === 0 && dLonDeg === 0) return 0; // query is inside the box

  const latAngle = dLatDeg * DEG2RAD;
  const lonAngle = Math.asin(
    Math.abs(Math.cos(lat * DEG2RAD) * Math.sin(dLonDeg * DEG2RAD)),
  );
  const angle = Math.max(latAngle, lonAngle);
  return Math.max(0, angle * EARTH_RADIUS_M - LOWER_BOUND_MARGIN_M);
}

/**
 * Tracks the k-th smallest number offered, as a bounded max-heap holding the k
 * smallest values seen. `kth()` (the heap's max) is the current k-th best and is
 * only meaningful once `full()`. O(log k) per offer.
 */
class KthBestTracker {
  private readonly heap: number[] = [];
  constructor(private readonly k: number) {}

  full(): boolean {
    return this.heap.length >= this.k;
  }

  /** The k-th smallest value offered so far. Only valid once full(). */
  kth(): number {
    return this.heap[0];
  }

  offer(value: number): void {
    if (this.k <= 0) return;
    const heap = this.heap;
    if (heap.length < this.k) {
      heap.push(value);
      this.siftUp(heap.length - 1);
    } else if (value < heap[0]) {
      heap[0] = value;
      this.siftDown(0);
    }
  }

  private siftUp(start: number): void {
    const heap = this.heap;
    let i = start;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent] >= heap[i]) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  }

  private siftDown(start: number): void {
    const heap = this.heap;
    const n = heap.length;
    let i = start;
    for (;;) {
      let largest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && heap[l] > heap[largest]) largest = l;
      if (r < n && heap[r] > heap[largest]) largest = r;
      if (largest === i) break;
      [heap[largest], heap[i]] = [heap[i], heap[largest]];
      i = largest;
    }
  }
}

/** One tile's outcome from a pruned multi-tile query. */
export interface TileVisit {
  id: string;
  query: NearestQuery;
  /** Lower bound (metres) on the distance from the query to this tile's box. */
  lowerBoundM: number;
  /** False when the tile was pruned (provably unable to beat the k-th best). */
  searched: boolean;
  /** This tile's own results, or [] when skipped. */
  results: QueryResult[];
}

/**
 * Visit loaded tiles nearest-box-first and decide, per tile, whether a
 * k-nearest query needs to search it. A tile is skipped once we already hold k
 * (deduped) results and its lower bound exceeds the current k-th best distance;
 * because tiles are visited in non-decreasing lower-bound order and the k-th
 * best only tightens, every later tile is skipped too. The caller supplies
 * `search` — the real per-tile query — so findNearestTiled and the X-ray overlay
 * prune in lockstep. Exact: the searched tiles' merged results contain the true
 * global top-k, so a skipped tile never changes the answer.
 */
export function queryTilesPruned(
  tiles: ReadonlyMap<string, NearestQuery>,
  lat: number,
  lon: number,
  k: number,
  search: (id: string, query: NearestQuery) => QueryResult[],
): TileVisit[] {
  const ordered = Array.from(tiles, ([id, query]) => ({
    id,
    query,
    lowerBoundM: tileBoxLowerBoundMeters(id, lat, lon),
  })).sort((a, b) => a.lowerBoundM - b.lowerBoundM);

  const visits: TileVisit[] = [];
  const kth = new KthBestTracker(k);
  const seen = new Set<string>();
  let pruning = false;

  for (const { id, query, lowerBoundM } of ordered) {
    if (!pruning && kth.full() && lowerBoundM > kth.kth()) {
      pruning = true;
    }
    if (pruning) {
      visits.push({ id, query, lowerBoundM, searched: false, results: [] });
      continue;
    }
    const results = search(id, query);
    for (const r of results) {
      if (seen.has(r.title)) continue;
      seen.add(r.title);
      kth.offer(r.distanceM);
    }
    visits.push({ id, query, lowerBoundM, searched: true, results });
  }
  return visits;
}

/**
 * Query loaded tiles for the k nearest articles, de-duplicated by title. Tiles
 * whose buffered coverage box cannot beat the current k-th best distance are
 * pruned (see queryTilesPruned) — an exact optimization, results are identical
 * to querying every tile.
 */
export function findNearestTiled(
  tiles: ReadonlyMap<string, NearestQuery>,
  lat: number,
  lon: number,
  k = 1,
  opts?: FindNearestOptions,
): QueryResult[] {
  if (tiles.size === 0) return [];

  const visits = queryTilesPruned(
    tiles,
    lat,
    lon,
    k,
    (_id, query) => query.findNearest(lat, lon, k, undefined, opts).results,
  );

  const seen = new Set<string>();
  const results: QueryResult[] = [];
  for (const visit of visits) {
    for (const r of visit.results) {
      if (seen.has(r.title)) continue;
      seen.add(r.title);
      results.push(r);
    }
  }

  results.sort((a, b) => a.distanceM - b.distanceM);
  return results.slice(0, k);
}

/**
 * Every article the loaded tiles hold within `radiusM`, de-duplicated by title
 * and unordered.
 *
 * The counterpart to findNearestTiled for the browse list, which wants a
 * radius rather than a count: its exhaustive tier ends at the tile coverage
 * radius, so "everything inside that radius" is the question, and the answer
 * runs to tens of thousands of articles in a dense city (see
 * NearestQuery.withinRadius for why a range scan beats a k-nearest walk at
 * that size).
 *
 * Pruning is exact and needs no k-th-best tracking: a tile whose box already
 * lies beyond the radius cannot hold anything inside it.
 */
export function findWithinRadiusTiled(
  tiles: ReadonlyMap<string, NearestQuery>,
  lat: number,
  lon: number,
  radiusM: number,
  minWeight?: number,
): QueryResult[] {
  const seen = new Set<string>();
  const results: QueryResult[] = [];

  for (const [id, query] of tiles) {
    if (tileBoxLowerBoundMeters(id, lat, lon) > radiusM) continue;
    for (const r of query.withinRadius(lat, lon, radiusM, minWeight)) {
      if (seen.has(r.title)) continue;
      seen.add(r.title);
      results.push(r);
    }
  }

  return results;
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
