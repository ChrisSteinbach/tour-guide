// Construct an ArticleWindow wired to a TileRadiusProvider that pulls from
// a TileSource. The factory's job is purely orchestration: given a tile
// source for some position, build the radius provider and the article
// window on top of it. All tile-loading concerns (which IDs exist, which
// are cached, how to fetch the missing ones) live in the TileSource.

import type { UserPosition } from "./types";
import type { ArticleWindow } from "./article-window";
import { createArticleWindow } from "./article-window";
import { createTileRadiusProvider } from "./tile-radius";
import { findNearestTiled } from "./tile-loader";
import type { TileSource } from "./tile-source";

export interface ArticleWindowFactoryDeps {
  position: UserPosition;
  signal: AbortSignal;
  source: TileSource;
  onWindowChange?: () => void;
}

export function createArticleWindowFactory(
  deps: ArticleWindowFactoryDeps,
): ArticleWindow {
  const { position, signal, source, onWindowChange } = deps;
  const { row, col } = source.center;

  const radiusProvider = createTileRadiusProvider({
    queryAllTiles: () =>
      Promise.resolve(
        findNearestTiled(source.loaded(), position.lat, position.lon, 99999),
      ),
    loadRing: async (ring) => {
      const ids = source.idsAtRing(ring);
      if (ids.length === 0) return false;

      let anyLoaded = false;
      for (const id of ids) {
        if (signal.aborted) return anyLoaded;
        if (source.isLoaded(id)) {
          anyLoaded = true;
          continue;
        }
        if (!source.hasEntry(id)) continue;
        try {
          await source.load(id, signal);
          if (signal.aborted) return anyLoaded;
          anyLoaded = true;
        } catch {
          // Tile load failure is non-fatal — the ring expansion continues
          // and the next caller can retry on a fresh fetchRange.
        }
      }
      return anyLoaded;
    },
    centerRow: row,
    centerCol: col,
  });

  return createArticleWindow(radiusProvider, {
    windowSize: 1000,
    onWindowChange,
  });
}
