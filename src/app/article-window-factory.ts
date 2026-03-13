import type { NearbyArticle, UserPosition } from "./types";
import type { NearestQuery } from "./query";
import type { TileEntry } from "../tiles";
import type { Lang } from "../lang";
import type { ArticleWindow } from "./article-window";
import { createArticleWindow } from "./article-window";
import { createTileRadiusProvider } from "./tile-radius";

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
  getTileEntry: (
    tileMap: Map<string, TileEntry>,
    id: string,
  ) => TileEntry | undefined;
  findNearestTiled: (
    tiles: ReadonlyMap<string, NearestQuery>,
    lat: number,
    lon: number,
    count: number,
  ) => NearbyArticle[];
  tilesAtRing: (
    row: number,
    col: number,
    ring: number,
    tileMap: Map<string, TileEntry>,
  ) => string[];
  tileFor: (lat: number, lon: number) => { row: number; col: number };
  onWindowChange?: () => void;
}

export interface ArticleWindowFactoryResult {
  articleWindow: ArticleWindow;
  providerTiles: ReadonlyMap<string, NearestQuery>;
}

export function createArticleWindowFactory(
  deps: ArticleWindowFactoryDeps,
): ArticleWindowFactoryResult {
  const {
    position,
    tileMap,
    lang,
    signal,
    getStateMachineTiles,
    loadTile,
    getTileEntry,
    findNearestTiled,
    tilesAtRing,
    tileFor,
  } = deps;

  const { row, col } = tileFor(position.lat, position.lon);

  // Provider-owned tile storage (separate from state machine)
  const providerTiles = new Map<string, NearestQuery>();

  const radiusProvider = createTileRadiusProvider({
    queryAllTiles: () => {
      // Merge state machine tiles with provider-loaded tiles
      const allTiles = new Map<string, NearestQuery>();
      for (const [id, query] of getStateMachineTiles()) {
        allTiles.set(id, query);
      }
      for (const [id, query] of providerTiles) {
        allTiles.set(id, query);
      }
      return Promise.resolve(
        findNearestTiled(allTiles, position.lat, position.lon, 99999),
      );
    },
    loadRing: async (ring) => {
      const ids = tilesAtRing(row, col, ring, tileMap);
      if (ids.length === 0) return false;

      for (const id of ids) {
        if (signal.aborted) return false;
        if (providerTiles.has(id)) continue;
        // Also skip tiles already in state machine
        const smTiles = getStateMachineTiles();
        if (smTiles.has(id)) continue;
        const entry = getTileEntry(tileMap, id);
        if (!entry) continue;
        try {
          const tileQuery = await loadTile("", lang, entry, signal);
          providerTiles.set(id, tileQuery);
        } catch {
          // Tile load failure is non-fatal
        }
      }
      return true;
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
