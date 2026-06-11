// Spatial panel: multiplexes the drawer between the radar view and the
// browse map behind the same update/highlight/resize/destroy interface
// the browse map lifecycle exposed. Renderer, effect adapter, and
// infinite-scroll wiring talk to this panel without knowing which view
// is active; the panel stores the latest data and replays it when the
// user switches tabs.

import {
  createLazyViewLifecycle,
  type CreateSpatialView,
  type LazyViewLifecycle,
} from "./lazy-view-lifecycle";
import { createRadarIcon, createFoldedMapIcon } from "./icons";
import type { BrowseMapHandle } from "./browse-map";
import type { NearbyArticle, UserPosition } from "./types";

export type SpatialViewKind = "radar" | "map";

/** localStorage key for the user's preferred spatial view. */
export const SPATIAL_VIEW_STORAGE_KEY = "tour-guide-spatial-view";

export interface SpatialPanelLifecycle {
  update(position: UserPosition, articles: NearbyArticle[]): void;
  highlight(title: string | null): void;
  resize(): void;
  destroy(): void;
}

export interface SpatialPanelDeps {
  /** The element to build the panel inside (the drawer's content area). */
  container: HTMLElement;
  onSelectArticle: (article: NearbyArticle) => void;
  importBrowseMap: () => Promise<{
    createBrowseMap: (
      el: HTMLElement,
      position: { lat: number; lon: number },
      articles: NearbyArticle[],
      onSelect: (article: NearbyArticle) => void,
    ) => BrowseMapHandle;
  }>;
  importRadarView: () => Promise<{ createRadarView: CreateSpatialView }>;
  storage: Pick<Storage, "getItem" | "setItem">;
}

function readStoredKind(storage: Pick<Storage, "getItem">): SpatialViewKind {
  try {
    const stored = storage.getItem(SPATIAL_VIEW_STORAGE_KEY);
    if (stored === "map" || stored === "radar") return stored;
  } catch {
    // Storage unavailable (private browsing) — fall through to default.
  }
  return "radar";
}

export function createSpatialPanelLifecycle(
  deps: SpatialPanelDeps,
): SpatialPanelLifecycle {
  let built = false;
  let activeKind: SpatialViewKind = readStoredKind(deps.storage);
  let lastPosition: UserPosition | null = null;
  let lastArticles: NearbyArticle[] = [];
  let lastHighlight: string | null = null;

  let panelEl: HTMLElement | null = null;
  let slots: Record<SpatialViewKind, HTMLElement> | null = null;
  let tabs: Record<SpatialViewKind, HTMLButtonElement> | null = null;
  let views: Record<SpatialViewKind, LazyViewLifecycle> | null = null;

  function activeView(): LazyViewLifecycle | null {
    return views ? views[activeKind] : null;
  }

  function applyActiveKind(): void {
    if (!slots || !tabs) return;
    for (const kind of ["radar", "map"] as const) {
      slots[kind].hidden = kind !== activeKind;
      tabs[kind].setAttribute("aria-pressed", String(kind === activeKind));
    }
  }

  function switchTo(kind: SpatialViewKind): void {
    if (kind === activeKind) return;
    activeKind = kind;
    try {
      deps.storage.setItem(SPATIAL_VIEW_STORAGE_KEY, kind);
    } catch {
      // Preference just won't persist; switching still works.
    }
    applyActiveKind();
    const view = activeView();
    if (view && lastPosition) {
      view.update(lastPosition, lastArticles);
      view.highlight(lastHighlight);
      view.resize();
    }
  }

  function makeTab(
    kind: SpatialViewKind,
    label: string,
    icon: SVGSVGElement,
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `spatial-tab spatial-tab-${kind}`;
    btn.dataset.kind = kind;
    btn.append(icon, label);
    btn.addEventListener("click", () => switchTo(kind));
    return btn;
  }

  function ensureBuilt(): void {
    if (built) return;
    built = true;

    panelEl = document.createElement("div");
    panelEl.className = "spatial-panel";

    const radarSlot = document.createElement("div");
    radarSlot.className = "spatial-slot spatial-slot-radar";
    const mapSlot = document.createElement("div");
    mapSlot.className = "spatial-slot spatial-slot-map";
    slots = { radar: radarSlot, map: mapSlot };

    const tabBar = document.createElement("div");
    tabBar.className = "spatial-tabs";
    tabBar.setAttribute("role", "group");
    tabBar.setAttribute("aria-label", "Spatial view");
    tabs = {
      radar: makeTab("radar", "Radar", createRadarIcon()),
      map: makeTab("map", "Map", createFoldedMapIcon()),
    };
    tabBar.append(tabs.radar, tabs.map);

    panelEl.append(radarSlot, mapSlot, tabBar);
    deps.container.appendChild(panelEl);

    views = {
      radar: createLazyViewLifecycle({
        container: radarSlot,
        className: "radar-view",
        onSelectArticle: deps.onSelectArticle,
        importView: () =>
          deps
            .importRadarView()
            .then((m) => ({ createView: m.createRadarView })),
      }),
      map: createLazyViewLifecycle({
        container: mapSlot,
        className: "browse-map",
        onSelectArticle: deps.onSelectArticle,
        importView: () =>
          deps
            .importBrowseMap()
            .then((m) => ({ createView: m.createBrowseMap })),
      }),
    };

    applyActiveKind();
  }

  return {
    update(position, articles) {
      lastPosition = position;
      lastArticles = articles;
      ensureBuilt();
      activeView()?.update(position, articles);
    },
    highlight(title) {
      lastHighlight = title;
      activeView()?.highlight(title);
    },
    resize() {
      activeView()?.resize();
    },
    destroy() {
      views?.radar.destroy();
      views?.map.destroy();
      views = null;
      panelEl?.remove();
      panelEl = null;
      slots = null;
      tabs = null;
      built = false;
      lastPosition = null;
      lastArticles = [];
      lastHighlight = null;
    },
  };
}
