// Browse map lifecycle manager: handles lazy-loading, creation,
// update, and teardown of the browse map rendered inside the drawer.
// All I/O boundaries are injected.

import type { BrowseMapHandle } from "./browse-map";
import type { NearbyArticle } from "./types";

export interface BrowseMapLifecycleDeps {
  /** The element to render the map into (e.g. the drawer's content area). */
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
}

export interface BrowseMapLifecycle {
  update(
    position: { lat: number; lon: number },
    articles: NearbyArticle[],
  ): void;
  resize(): void;
  destroy(): void;
}

export function createBrowseMapLifecycle(
  deps: BrowseMapLifecycleDeps,
): BrowseMapLifecycle {
  let handle: BrowseMapHandle | null = null;
  let creating = false;
  let pendingPosition: { lat: number; lon: number } | null = null;
  let pendingArticles: NearbyArticle[] | null = null;

  function destroy(): void {
    if (handle) {
      handle.destroy();
      handle = null;
    }
    creating = false;
    pendingPosition = null;
    pendingArticles = null;
    const el = deps.container.querySelector(".browse-map");
    el?.remove();
  }

  function resize(): void {
    handle?.resize();
  }

  function update(
    position: { lat: number; lon: number },
    articles: NearbyArticle[],
  ): void {
    // If the map handle exists and its container is still in the DOM, just update.
    if (handle) {
      const existing = deps.container.querySelector(".browse-map");
      if (existing && deps.container.contains(existing)) {
        handle.update(position, articles);
        return;
      }
      handle = null;
    }

    // Prevent re-entry during async import + rAF pipeline
    if (creating) {
      pendingPosition = position;
      pendingArticles = articles;
      return;
    }
    creating = true;

    // First render: create the map container
    let mapEl = deps.container.querySelector<HTMLElement>(".browse-map");
    if (!mapEl) {
      mapEl = document.createElement("div");
      mapEl.className = "browse-map";
      deps.container.appendChild(mapEl);
    }

    void deps
      .importBrowseMap()
      .then(({ createBrowseMap }) => {
        if (!mapEl || !deps.container.contains(mapEl)) {
          creating = false;
          return;
        }
        // Defer map creation to a rAF so the browser has laid out the
        // drawer container before Leaflet reads its dimensions. The
        // dynamic import resolves as a microtask — before layout — so
        // creating the map immediately can leave Leaflet with a
        // zero-size container (especially Firefox hidden→visible).
        requestAnimationFrame(() => {
          if (!mapEl || !deps.container.contains(mapEl)) {
            creating = false;
            pendingPosition = null;
            pendingArticles = null;
            return;
          }
          const finalPosition = pendingPosition ?? position;
          const finalArticles = pendingArticles ?? articles;
          pendingPosition = null;
          pendingArticles = null;
          handle = createBrowseMap(
            mapEl,
            finalPosition,
            finalArticles,
            deps.onSelectArticle,
          );
          creating = false;
          handle.resize();
        });
      })
      .catch(() => {
        // Map is a nice-to-have; browsing works without it
        creating = false;
        pendingPosition = null;
        pendingArticles = null;
        mapEl?.remove();
      });
  }

  return { update, resize, destroy };
}
