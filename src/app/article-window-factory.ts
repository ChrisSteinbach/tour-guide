import type { UserPosition } from "./types";
import type { NearestQuery } from "./query";
import type { TileEntry } from "../tiles";
import type { Lang } from "../lang";
import type { ArticleWindow } from "./article-window";
import { createArticleWindow } from "./article-window";
import { createTileRadiusProvider, tilesAtRing } from "./tile-radius";
import { findNearestTiled, getTileEntry } from "./tile-loader";
import { tileFor } from "../tiles";

/**
 * The runtime opts that compose-app passes through from the lifecycle, plus
 * the single impure dep (`loadTile`) that needs to be injected for tests so
 * they can avoid hitting the network. The pure tile-grid helpers (tilesAtRing,
 * tileFor, findNearestTiled, getTileEntry) used to be injected too, but the
 * test setup grew so unwieldy that the injections obscured the actual
 * behavior under test. They are now imported directly — tests run sociably
 * against the real geometry.
 */
export interface ArticleWindowFactoryDeps {
  position: UserPosition;
  tileMap: Map<string, TileEntry>;
  lang: Lang;
  signal: AbortSignal;
  getStateMachineTiles: () => ReadonlyMap<string, NearestQuery>;
  loadTile: (
    basePath: string,
    lang: Lang,
    entry: TileEntry,
    signal: AbortSignal,
  ) => Promise<NearestQuery>;
  onWindowChange?: () => void;
}

export interface ArticleWindowFactoryResult {
  articleWindow: ArticleWindow;
  providerTiles: ReadonlyMap<string, NearestQuery>;
}

export function createArticleWindowFactory(
  deps: ArticleWindowFactoryDeps,
): ArticleWindowFactoryResult {
  const { position, tileMap, lang, signal, getStateMachineTiles, loadTile } =
    deps;

  const { row, col } = tileFor(position.lat, position.lon);

  const providerTiles = new Map<string, NearestQuery>();

  const radiusProvider = createTileRadiusProvider({
    queryTiles: (tileIds) => {
      const tiles = new Map<string, NearestQuery>();
      const smTiles = getStateMachineTiles();
      for (const id of tileIds) {
        const q = providerTiles.get(id) ?? smTiles.get(id);
        if (q) tiles.set(id, q);
      }
      return Promise.resolve(
        findNearestTiled(tiles, position.lat, position.lon, 99999),
      );
    },
    loadRing: async (ring) => {
      const ids = tilesAtRing(row, col, ring, tileMap);
      if (ids.length === 0) return [];

      const newlyLoaded: string[] = [];
      for (const id of ids) {
        if (signal.aborted) return newlyLoaded;
        if (providerTiles.has(id)) continue;
        const smTiles = getStateMachineTiles();
        if (smTiles.has(id)) {
          newlyLoaded.push(id);
          continue;
        }
        const entry = getTileEntry(tileMap, id);
        if (!entry) continue;
        try {
          const tileQuery = await loadTile("", lang, entry, signal);
          if (signal.aborted) return newlyLoaded;
          providerTiles.set(id, tileQuery);
          newlyLoaded.push(id);
        } catch {
          // Tile load failure is non-fatal
        }
      }
      return newlyLoaded;
    },
    centerRow: row,
    centerCol: col,
  });

  const articleWindow = createArticleWindow(radiusProvider, {
    windowSize: 1000,
    onWindowChange: deps.onWindowChange,
  });

  return { articleWindow, providerTiles };
}
