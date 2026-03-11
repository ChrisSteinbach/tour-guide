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

  function destroy(): void {
    if (handle) {
      handle.destroy();
      handle = null;
    }
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
        if (!mapEl || !deps.container.contains(mapEl)) return;
        handle = createBrowseMap(
          mapEl,
          position,
          articles,
          deps.onSelectArticle,
        );
      })
      .catch(() => {
        // Map is a nice-to-have; browsing works without it
        mapEl?.remove();
      });
  }

  return { update, resize, destroy };
}
