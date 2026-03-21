// Effect executor — extracted from main.ts for testability.
// All I/O boundaries are injected via EffectDeps; the factory
// encapsulates operational state (stopWatcher, loadController).

import type { NearbyArticle, UserPosition } from "./types";
import type { LocationCallbacks, StopFn } from "./location";
import type { ArticleSummary } from "./wiki-api";
import type { NearestQuery } from "./query";
import type { TileEntry, TileIndex } from "../tiles";
import type { Lang } from "../lang";
import type { AppState, Effect, Event, QueryState } from "./state-machine";
import type { SummaryLoader } from "./summary-loader";

export const LANG_STORAGE_KEY = "tour-guide-lang";
export const STARTED_STORAGE_KEY = "tour-guide-started";
/** How long a stored "started" timestamp remains valid (1 hour). */
export const STARTED_TTL_MS = 60 * 60 * 1000;

export interface RenderDeps {
  render: () => void;
  renderBrowsingList: () => void;
  renderBrowsingHeader: () => void;
  updateDistances: (articles: NearbyArticle[]) => void;
  renderDetailLoading: (article: NearbyArticle) => void;
  renderDetailReady: (article: NearbyArticle, summary: ArticleSummary) => void;
  renderDetailError: (
    article: NearbyArticle,
    message: string,
    onRetry: () => void,
    lang: Lang,
  ) => void;
  renderAppUpdateBanner: () => void;
  showMapPicker: () => void;
  scrollToTop: () => void;
  restoreScrollTop: (firstVisibleIndex: number) => void;
}

export interface DataDeps {
  loadTileIndex: (lang: Lang, signal: AbortSignal) => Promise<TileIndex | null>;
  loadTile: (
    lang: Lang,
    entry: TileEntry,
    signal: AbortSignal,
  ) => Promise<NearestQuery>;
  tilesForPosition: (
    index: Map<string, TileEntry>,
    lat: number,
    lon: number,
  ) => { primary: string; adjacent: string[] };
  getTileEntry: (
    tileMap: Map<string, TileEntry>,
    id: string,
  ) => TileEntry | undefined;
}

export interface StorageDeps {
  setItem: (key: string, value: string) => void;
}

export interface EffectDeps {
  getState: () => AppState;
  dispatch: (event: Event) => void;
  watchLocation: (callbacks: LocationCallbacks) => StopFn;
  pushState: (data: unknown, title: string) => void;
  fetchArticleSummary: (title: string, lang: Lang) => Promise<ArticleSummary>;
  getNearby: (
    query: QueryState,
    pos: UserPosition,
    count: number,
  ) => NearbyArticle[];
  /** For infinite scroll: reset ArticleWindow and load articles via TileRadiusProvider. */
  ensureArticleRange?: (pos: UserPosition, count: number) => void;
  summaryLoader: SummaryLoader;
  ui: RenderDeps;
  data: DataDeps;
  storage: StorageDeps;
}

export function createEffectExecutor(
  deps: EffectDeps,
): (effect: Effect) => void {
  // Operational handles (not part of state machine)
  let stopWatcher: StopFn | null = null;
  let loadController = new AbortController();

  function fetchAndRenderSummary(article: NearbyArticle): void {
    deps.ui.renderDetailLoading(article);
    deps
      .fetchArticleSummary(article.title, deps.getState().currentLang)
      .then((summary) => {
        const state = deps.getState();
        if (state.phase.phase !== "detail" || state.phase.article !== article)
          return;
        deps.ui.renderDetailReady(article, summary);
      })
      .catch((err: unknown) => {
        const state = deps.getState();
        if (state.phase.phase !== "detail" || state.phase.article !== article)
          return;
        const message = err instanceof Error ? err.message : "Unknown error";
        deps.ui.renderDetailError(
          article,
          message,
          () => fetchAndRenderSummary(article),
          state.currentLang,
        );
      });
  }

  function loadLanguageData(lang: Lang, signal: AbortSignal): void {
    const gen = deps.getState().loadGeneration;
    deps.data
      .loadTileIndex(lang, signal)
      .then((index) => {
        if (gen !== deps.getState().loadGeneration) return;
        deps.dispatch({ type: "tileIndexLoaded", index, lang, gen });
      })
      .catch(() => {
        if (signal.aborted) return;
        if (gen !== deps.getState().loadGeneration) return;
        deps.dispatch({
          type: "tileIndexLoaded",
          index: null,
          lang,
          gen,
        });
      });
  }

  async function loadTilesForPosition(
    lang: Lang,
    gen: number,
    signal: AbortSignal,
  ): Promise<void> {
    const state = deps.getState();
    if (gen !== state.loadGeneration) return;
    if (state.query.mode !== "tiled" || !state.position) return;

    const { tileMap } = state.query;
    const { primary, adjacent } = deps.data.tilesForPosition(
      tileMap,
      state.position.lat,
      state.position.lon,
    );

    const allTiles = [primary, ...adjacent];
    let anyStarted = false;
    for (const id of allTiles) {
      if (signal.aborted) return;
      const currentState = deps.getState();
      if (
        (currentState.query.mode === "tiled" &&
          currentState.query.tiles.has(id)) ||
        currentState.loadingTiles.has(id)
      )
        continue;
      const entry = deps.data.getTileEntry(tileMap, id);
      if (!entry) continue;

      anyStarted = true;
      const isPrimary = id === primary;
      deps.dispatch({ type: "tileLoadStarted", id });

      const loadOne = deps.data
        .loadTile(lang, entry, signal)
        .then((tileQuery) => {
          if (gen !== deps.getState().loadGeneration) return;
          deps.dispatch({ type: "tileLoaded", id, tileQuery, gen });
        })
        .catch(() => {
          if (signal.aborted) return;
          if (gen !== deps.getState().loadGeneration) return;
          deps.dispatch({ type: "tileLoadFailed", id, gen });
        });

      if (isPrimary) {
        await loadOne;
      }
    }

    if (!anyStarted && !signal.aborted) {
      const finalState = deps.getState();
      if (finalState.loadingTiles.size === 0) {
        deps.dispatch({ type: "noTilesNearby" });
      }
    }
  }

  return function executeEffect(effect: Effect): void {
    switch (effect.type) {
      case "render":
        deps.ui.render();
        break;
      case "renderBrowsingList":
        deps.ui.renderBrowsingList();
        break;
      case "renderBrowsingHeader":
        deps.ui.renderBrowsingHeader();
        break;
      case "updateDistances": {
        const state = deps.getState();
        if (state.phase.phase === "browsing")
          deps.ui.updateDistances(state.phase.articles);
        break;
      }
      case "startGps":
        stopWatcher?.();
        stopWatcher = deps.watchLocation({
          onPosition: (pos) => deps.dispatch({ type: "position", pos }),
          onError: (error) => deps.dispatch({ type: "gpsError", error }),
        });
        break;
      case "stopGps":
        if (stopWatcher) {
          stopWatcher();
          stopWatcher = null;
        }
        break;
      case "storeLang":
        deps.storage.setItem(LANG_STORAGE_KEY, effect.lang);
        break;
      case "storeStarted":
        deps.storage.setItem(STARTED_STORAGE_KEY, String(Date.now()));
        break;
      case "loadData":
        loadController.abort();
        loadController = new AbortController();
        loadLanguageData(effect.lang, loadController.signal);
        break;
      case "loadTiles":
        void loadTilesForPosition(
          effect.lang,
          deps.getState().loadGeneration,
          loadController.signal,
        );
        break;
      case "pushHistory":
        deps.pushState({ view: "detail" }, "");
        break;
      case "fetchSummary":
        fetchAndRenderSummary(effect.article);
        break;
      case "showMapPicker":
        deps.ui.showMapPicker();
        break;
      case "showAppUpdateBanner":
        deps.ui.renderAppUpdateBanner();
        break;
      case "requery": {
        const state = deps.getState();
        const articles = deps.getNearby(state.query, effect.pos, effect.count);
        if (
          state.phase.phase === "browsing" &&
          state.phase.scrollMode === "infinite" &&
          deps.ensureArticleRange
        ) {
          deps.ensureArticleRange(effect.pos, effect.count);
        }
        deps.dispatch({
          type: "queryResult",
          articles,
          queryPos: effect.pos,
          count: effect.count,
        });
        break;
      }
      case "fetchListSummaries": {
        const state = deps.getState();
        if (state.phase.phase === "browsing") {
          deps.summaryLoader.load(
            state.phase.articles.map((a) => a.title),
            state.currentLang,
          );
        }
        break;
      }
      case "scrollToTop":
        deps.ui.scrollToTop();
        break;
      case "restoreScrollTop":
        deps.ui.restoreScrollTop(effect.firstVisibleIndex);
        break;
    }
  };
}
