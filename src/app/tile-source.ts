// A position-anchored facade over the three things needed to feed the
// TileRadiusProvider: a tile index (which IDs exist where), a state-machine
// pool of already-loaded tiles, and an impure tile loader. Owning all three
// behind one interface lets ArticleWindowFactory take a single collaborator
// instead of threading tileMap + getStateMachineTiles + loadTile separately,
// and gives tests one thing to fake (loadTile) instead of three.

import type { UserPosition } from "./types";
import type { NearestQuery } from "./query";
import type { TileEntry } from "../tiles";
import { tileFor } from "../tiles";
import { tilesAtRing } from "./tile-radius";
import { getTileEntry } from "./tile-loader";

export interface TileSource {
  /** Center tile (row, col) for the position this source serves. */
  readonly center: { row: number; col: number };

  /** Tile IDs at Chebyshev distance `ring` from the center, filtered to
   *  those that exist in the tile index. */
  idsAtRing(ring: number): string[];

  /** Whether the tile index has metadata for this ID. */
  hasEntry(id: string): boolean;

  /** Whether the tile is already available — either previously loaded by
   *  this source or held by the state machine pool. Cheap; no I/O. */
  isLoaded(id: string): boolean;

  /** Load a tile from disk/network and cache it locally. No-op if already
   *  loaded by this source or the state machine, if the tile is not in the
   *  index, or if `signal` aborts before/after the underlying fetch.
   *  Propagates the underlying loader's rejection on fetch failure. */
  load(id: string, signal: AbortSignal): Promise<void>;

  /** All currently-loaded tiles as a merged view (state machine pool plus
   *  this source's local cache). Local cache takes precedence on collision.
   *  Used by TileRadiusProvider's queryTiles closure to feed findNearestTiled. */
  loaded(): ReadonlyMap<string, NearestQuery>;
}

export interface CreateTileSourceOpts {
  position: UserPosition;
  tileMap: Map<string, TileEntry>;
  /** Read-through view of tiles already loaded by the state machine.
   *  Called on each access because the state machine continues loading
   *  tiles in the background. */
  getStateMachineTiles: () => ReadonlyMap<string, NearestQuery>;
  /** Impure: fetch a tile's data. Tests stub this to avoid the network.
   *  Language and base path are captured by the closure at construction
   *  time, so the source itself stays language-agnostic. */
  loadTile: (entry: TileEntry, signal: AbortSignal) => Promise<NearestQuery>;
}

export function createTileSource(opts: CreateTileSourceOpts): TileSource {
  const { tileMap, getStateMachineTiles, loadTile } = opts;
  const center = tileFor(opts.position.lat, opts.position.lon);
  const local = new Map<string, NearestQuery>();

  return {
    center,

    idsAtRing(ring) {
      return tilesAtRing(center.row, center.col, ring, tileMap);
    },

    hasEntry(id) {
      return getTileEntry(tileMap, id) !== undefined;
    },

    isLoaded(id) {
      return local.has(id) || getStateMachineTiles().has(id);
    },

    async load(id, signal) {
      if (local.has(id)) return;
      if (getStateMachineTiles().has(id)) return;
      const entry = getTileEntry(tileMap, id);
      if (!entry) return;
      const q = await loadTile(entry, signal);
      // Re-check after the await: an abort that fires while loadTile is
      // in flight must not be allowed to seed the cache with a tile the
      // caller has already abandoned.
      if (signal.aborted) return;
      local.set(id, q);
    },

    loaded() {
      const sm = getStateMachineTiles();
      if (local.size === 0) return sm;
      if (sm.size === 0) return local;
      // Local cache takes precedence on collision (matches the prior
      // factory's `providerTiles.get(id) ?? smTiles.get(id)` ordering).
      const merged = new Map<string, NearestQuery>(sm);
      for (const [id, q] of local) merged.set(id, q);
      return merged;
    },
  };
}
