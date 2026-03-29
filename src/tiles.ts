// Shared tile types and functions used by both pipeline and app

export const GRID_DEG = 5;
export const BUFFER_DEG = 0.5;
export const EDGE_PROXIMITY_DEG = 1;

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
}

export interface TileIndex {
  version: number;
  gridDeg: number;
  bufferDeg: number;
  generated: string;
  hash?: string;
  tiles: TileEntry[];
}

const ROWS = 180 / GRID_DEG; // 36
const COLS = 360 / GRID_DEG; // 72

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
