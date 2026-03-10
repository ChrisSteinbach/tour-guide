// Browse map lifecycle manager: handles lazy-loading, creation,
// update, and teardown of the desktop split-view browse map.
// All I/O boundaries are injected.

import type { BrowseMapHandle } from "./browse-map";
import type { NearbyArticle } from "./types";

export interface BrowseMapLifecycleDeps {
  container: HTMLElement;
  isDesktop: () => boolean;
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
    deps.container.classList.remove("split-view");
  }

  function update(
    position: { lat: number; lon: number },
    articles: NearbyArticle[],
  ): void {
    if (!deps.isDesktop()) {
      destroy();
      return;
    }

    // If the map handle exists but its container was removed (e.g. detail view
    // cleared #app), discard the stale handle so we recreate it.
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
      deps.container.classList.add("split-view");
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

  return { update, destroy };
}
