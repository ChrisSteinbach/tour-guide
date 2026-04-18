// Map panel lifecycle — extracted from main.ts.
// Owns the drawer, the desktop media query, and the browse/picker
// map lifecycles, plus the event listeners that keep them in sync.
// All I/O boundaries are injected via MapPanelLifecycleDeps.

import { createMapDrawer, type MapDrawer } from "./map-drawer";
import {
  createBrowseMapLifecycle,
  type BrowseMapLifecycle,
} from "./browse-map-lifecycle";
import {
  createMapPickerLifecycle,
  type MapPickerLifecycle,
} from "./map-picker-lifecycle";
import type { AppState, Event } from "./state-machine";

export interface MapPanelLifecycleDeps {
  getState: () => AppState;
  dispatch: (event: Event) => void;
  app: HTMLElement;
  getScrollContainer: () => HTMLElement;
  itemHeight: number;
  appName: string;
  /** Called when the desktop media query changes while browsing. */
  renderBrowsingList: () => void;
}

export interface MapPanelLifecycle {
  drawer: MapDrawer;
  drawerPanel: HTMLElement;
  desktopQuery: MediaQueryList;
  browseMap: BrowseMapLifecycle;
  mapPicker: MapPickerLifecycle;
  onHoverArticle: (title: string | null) => void;
  /**
   * Remove event listeners attached at construction time and tear down the
   * drawer, browse map, and map picker sub-lifecycles constructed here.
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

  const browseMap = createBrowseMapLifecycle({
    container: drawer.element,
    onSelectArticle: (article) => {
      // On mobile the drawer covers the detail view. Dismiss it as the
      // detail opens; the handle/gesture can still reopen the map.
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
    importBrowseMap: () => import("./browse-map"),
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
    browseMap.highlight(title);

  const onDesktopQueryChange = (): void => {
    if (deps.getState().phase.phase === "browsing") {
      if (desktopQuery.matches) {
        drawer.open();
      } else {
        drawer.close();
      }
      deps.renderBrowsingList();
    }
  };

  const onDrawerTransitionEnd = (e: TransitionEvent): void => {
    if (e.propertyName === "transform" && drawer.isOpen()) browseMap.resize();
  };

  desktopQuery.addEventListener("change", onDesktopQueryChange);
  drawerPanel.addEventListener("transitionend", onDrawerTransitionEnd);

  drawerPanel.setAttribute("hidden", "");

  function destroy(): void {
    desktopQuery.removeEventListener("change", onDesktopQueryChange);
    drawerPanel.removeEventListener("transitionend", onDrawerTransitionEnd);
    mapPicker.destroy();
    browseMap.destroy();
    drawer.destroy();
  }

  return {
    drawer,
    drawerPanel,
    desktopQuery,
    browseMap,
    mapPicker,
    onHoverArticle,
    destroy,
  };
}
