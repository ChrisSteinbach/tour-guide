// Shared tile types and functions used by both pipeline and app

export const GRID_DEG = 5;
export const BUFFER_DEG = 0.5;
export const EDGE_PROXIMITY_DEG = 1;

/**
 * On-disk tile format version. Bump when a change to the serialized tile
 * format or grid layout makes previously published tiles incompatible with
 * this code. Written into every TileIndex by the pipeline and validated by the
 * app's loadTileIndex, so stale/mismatched data surfaces as data-unavailable
 * instead of silently producing wrong nearest-neighbor results.
 */
export const TILE_FORMAT_VERSION = 1;

export interface TileEntry {
  id: string;
  row: number;
  col: number;
  south: number;
  north: number;
  west: number;
  east: number;
  articles: number;
  bytes: number;
  hash: string;
  /**
   * This cell's mid-field digest, when it has one: its most notable articles,
   * fetchable without the tile's triangulation. Absent when the cell holds no
   * more than `FARFIELD_TOP_K` articles — the far-field tier already carries
   * every one of them, so a digest would be pure duplication.
   */
  digest?: SampledTierMeta;
}

/**
 * Metadata for one sampled-tier artifact: either the far-field tier
 * (`farfield.bin`) or a single cell's mid-field digest (`{id}.digest.bin`).
 * They are the same thing at two scales — the most notable articles of a
 * region, encoded with the codec in `src/farfield.ts` — so they carry the
 * same metadata.
 *
 * Optional wherever it appears: an index written before a tier existed simply
 * has no entry for it, and the app falls back to the reach it had before that
 * tier shipped. That keeps a stale-data deploy degraded rather than broken.
 */
export interface SampledTierMeta {
  /** Number of articles in the artifact. */
  count: number;
  /** Uncompressed size, for progress estimation. */
  bytes: number;
  /** Content hash (first 8 hex chars of SHA-256) for cache invalidation. */
  hash: string;
}

export interface TileIndex {
  version: number;
  gridDeg: number;
  bufferDeg: number;
  generated: string;
  hash?: string;
  tiles: TileEntry[];
  farField?: SampledTierMeta;
}

export const ROWS = 180 / GRID_DEG; // 36
export const COLS = 360 / GRID_DEG; // 72

/** Compute tile row and column for a lat/lon position. */
export function tileFor(
  lat: number,
  lon: number,
): { row: number; col: number } {
  const row = Math.min(Math.floor((lat + 90) / GRID_DEG), ROWS - 1);
  const col = Math.min(Math.floor((lon + 180) / GRID_DEG), COLS - 1);
  return { row, col };
}

/** Wrap column index to [0, COLS) for antimeridian crossing. */
export function wrapCol(col: number): number {
  return ((col % COLS) + COLS) % COLS;
}

/** Format row-col as zero-padded tile ID. */
export function tileId(row: number, col: number): string {
  return `${String(row).padStart(2, "0")}-${String(col).padStart(2, "0")}`;
}
