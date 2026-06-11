// Browse map lifecycle: lazy-loading, creation, update, and teardown
// of the browse map rendered inside the drawer. A thin adapter over
// the generic lazy view lifecycle; all I/O boundaries are injected.

import {
  createLazyViewLifecycle,
  type LazyViewLifecycle,
} from "./lazy-view-lifecycle";
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

export type BrowseMapLifecycle = LazyViewLifecycle;

export function createBrowseMapLifecycle(
  deps: BrowseMapLifecycleDeps,
): BrowseMapLifecycle {
  return createLazyViewLifecycle({
    container: deps.container,
    className: "browse-map",
    onSelectArticle: deps.onSelectArticle,
    importView: () =>
      deps.importBrowseMap().then((m) => ({ createView: m.createBrowseMap })),
  });
}
