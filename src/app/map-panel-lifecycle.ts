// Map panel lifecycle — extracted from main.ts.
// Owns the drawer, the desktop media query, the spatial panel
// (radar/map views inside the drawer), and the map picker lifecycle,
// plus the event listeners that keep them in sync.
// All I/O boundaries are injected via MapPanelLifecycleDeps.

import { createMapDrawer, type MapDrawer } from "./map-drawer";
import {
  createSpatialPanelLifecycle,
  type SpatialPanelLifecycle,
} from "./spatial-panel-lifecycle";
import {
  createMapPickerLifecycle,
  type MapPickerLifecycle,
} from "./map-picker-lifecycle";
import { filterMinWeight } from "./config";
import type { AppState, Event } from "./state-machine";

export interface MapPanelLifecycleDeps {
  getState: () => AppState;
  dispatch: (event: Event) => void;
  app: HTMLElement;
  getScrollContainer: () => HTMLElement;
  itemHeight: number;
  appName: string;
  /** Persists the radar/map tab preference. */
  storage: Pick<Storage, "getItem" | "setItem">;
  /** Called when the desktop media query changes while browsing. */
  renderBrowsingList: () => void;
}

export interface MapPanelLifecycle {
  drawer: MapDrawer;
  drawerPanel: HTMLElement;
  desktopQuery: MediaQueryList;
  spatialPanel: SpatialPanelLifecycle;
  mapPicker: MapPickerLifecycle;
  onHoverArticle: (title: string | null) => void;
  /**
   * Remove event listeners attached at construction time and tear down the
   * drawer, spatial panel, and map picker sub-lifecycles constructed here.
   * Safe to call more than once.
   */
  destroy: () => void;
}

export function createMapPanelLifecycle(
  deps: MapPanelLifecycleDeps,
): MapPanelLifecycle {
  const desktopQuery = window.matchMedia("(min-width: 1024px)");

  const drawer = createMapDrawer(document.body);
  const drawerPanel = drawer.panel;

  const spatialPanel = createSpatialPanelLifecycle({
    container: drawer.element,
    onSelectArticle: (article) => {
      // On mobile the drawer covers the detail view. Dismiss it as the
      // detail opens; the handle/gesture can still reopen the panel.
      if (!desktopQuery.matches && drawer.isOpen()) {
        drawer.close();
      }
      deps.dispatch({
        type: "selectArticle",
        article,
        firstVisibleIndex: Math.floor(
          deps.getScrollContainer().scrollTop / deps.itemHeight,
        ),
      });
    },
    importBrowseMap: () =>
      Promise.all([import("./browse-map"), import("./xray-overlay")]).then(
        ([m, x]) => ({
          createBrowseMap: (el, pos, articles, onSelect) =>
            m.createBrowseMap(el, pos, articles, onSelect, {
              attachXRay: (map) =>
                x.createXRayOverlay(map, {
                  getLoadedTiles: () => {
                    const q = deps.getState().query;
                    return q.mode === "tiled" ? q.tiles : null;
                  },
                  getTileEntries: () => {
                    const q = deps.getState().query;
                    return q.mode === "tiled" ? q.tileMap : null;
                  },
                  getQueryContext: () => {
                    const s = deps.getState();
                    return s.position
                      ? {
                          position: s.position,
                          k: s.viewportFillCount,
                          minWeight: filterMinWeight(s.filter),
                        }
                      : null;
                  },
                  initialOpen: new URLSearchParams(window.location.search).has(
                    "xray",
                  ),
                  storage: deps.storage,
                }),
            }),
        }),
      ),
    importRadarView: () => import("./radar-view"),
    storage: deps.storage,
  });

  const mapPicker = createMapPickerLifecycle({
    container: deps.app,
    appName: deps.appName,
    getPosition: () => deps.getState().position,
    onPick: (lat, lon) =>
      deps.dispatch({ type: "pickPosition", position: { lat, lon } }),
    importMapPicker: () => import("./map-picker"),
  });

  const onHoverArticle = (title: string | null): void =>
    spatialPanel.highlight(title);

  const onDesktopQueryChange = (): void => {
    const phase = deps.getState().phase.phase;
    // The drawer persists across browsing↔detail, so keep its open state
    // in sync with the viewport in both phases — crossing into mobile
    // with the drawer open would otherwise leave it covering the detail
    // view (mobile has no side-by-side layout).
    if (phase !== "browsing" && phase !== "detail") return;
    if (desktopQuery.matches) {
      drawer.open();
    } else {
      drawer.close();
    }
    if (phase === "browsing") {
      deps.renderBrowsingList();
    }
  };

  const onDrawerTransitionEnd = (e: TransitionEvent): void => {
    if (e.propertyName === "transform" && drawer.isOpen())
      spatialPanel.resize();
  };

  desktopQuery.addEventListener("change", onDesktopQueryChange);
  drawerPanel.addEventListener("transitionend", onDrawerTransitionEnd);

  drawerPanel.setAttribute("hidden", "");

  function destroy(): void {
    desktopQuery.removeEventListener("change", onDesktopQueryChange);
    drawerPanel.removeEventListener("transitionend", onDrawerTransitionEnd);
    mapPicker.destroy();
    spatialPanel.destroy();
    drawer.destroy();
  }

  return {
    drawer,
    drawerPanel,
    desktopQuery,
    spatialPanel,
    mapPicker,
    onHoverArticle,
    destroy,
  };
}
