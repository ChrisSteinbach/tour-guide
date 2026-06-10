// Generic lazy view lifecycle: handles dynamic import, deferred
// creation, update coalescing, and teardown for a drawer-hosted
// spatial view (browse map, radar). Extracted from the original
// browse-map lifecycle so both views share the subtle async logic.

import type { NearbyArticle, UserPosition } from "./types";

/** Handle shape shared by drawer-hosted spatial views (map, radar). */
export interface SpatialViewHandle {
  update(position: UserPosition, articles: NearbyArticle[]): void;
  highlight(title: string | null): void;
  resize(): void;
  destroy(): void;
}

/** Factory signature every spatial view module exposes. */
export type CreateSpatialView = (
  el: HTMLElement,
  position: UserPosition,
  articles: NearbyArticle[],
  onSelect: (article: NearbyArticle) => void,
) => SpatialViewHandle;

export interface LazyViewLifecycleDeps {
  /** The element to render the view into (e.g. a drawer slot). */
  container: HTMLElement;
  /** Class of the element created for the view; also the revival probe. */
  className: string;
  onSelectArticle: (article: NearbyArticle) => void;
  importView: () => Promise<{ createView: CreateSpatialView }>;
}

export interface LazyViewLifecycle {
  update(position: UserPosition, articles: NearbyArticle[]): void;
  highlight(title: string | null): void;
  resize(): void;
  destroy(): void;
}

export function createLazyViewLifecycle(
  deps: LazyViewLifecycleDeps,
): LazyViewLifecycle {
  let handle: SpatialViewHandle | null = null;
  let creating = false;
  let pendingPosition: UserPosition | null = null;
  let pendingArticles: NearbyArticle[] | null = null;
  let pendingHighlight: string | null | undefined = undefined;

  const selector = `.${deps.className}`;

  function destroy(): void {
    if (handle) {
      handle.destroy();
      handle = null;
    }
    creating = false;
    pendingPosition = null;
    pendingArticles = null;
    pendingHighlight = undefined;
    const el = deps.container.querySelector(selector);
    el?.remove();
  }

  function resize(): void {
    handle?.resize();
  }

  function update(position: UserPosition, articles: NearbyArticle[]): void {
    // If the view handle exists and its container is still in the DOM, just update.
    if (handle) {
      const existing = deps.container.querySelector(selector);
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

    // First render: create the view container
    let viewEl = deps.container.querySelector<HTMLElement>(selector);
    if (!viewEl) {
      viewEl = document.createElement("div");
      viewEl.className = deps.className;
      deps.container.appendChild(viewEl);
    }

    void deps
      .importView()
      .then(({ createView }) => {
        if (!viewEl || !deps.container.contains(viewEl)) {
          creating = false;
          return;
        }
        // Defer view creation to a rAF so the browser has laid out the
        // drawer container before the view reads its dimensions. The
        // dynamic import resolves as a microtask — before layout — so
        // creating the view immediately can leave it with a zero-size
        // container (especially Firefox hidden→visible).
        requestAnimationFrame(() => {
          if (!viewEl || !deps.container.contains(viewEl)) {
            creating = false;
            pendingPosition = null;
            pendingArticles = null;
            pendingHighlight = undefined;
            return;
          }
          const finalPosition = pendingPosition ?? position;
          const finalArticles = pendingArticles ?? articles;
          pendingPosition = null;
          pendingArticles = null;
          handle = createView(
            viewEl,
            finalPosition,
            finalArticles,
            deps.onSelectArticle,
          );
          creating = false;
          if (pendingHighlight !== undefined) {
            handle.highlight(pendingHighlight);
            pendingHighlight = undefined;
          }
          handle.resize();
        });
      })
      .catch(() => {
        // The view is a nice-to-have; browsing works without it
        creating = false;
        pendingPosition = null;
        pendingArticles = null;
        pendingHighlight = undefined;
        viewEl?.remove();
      });
  }

  function highlight(title: string | null): void {
    if (handle) {
      handle.highlight(title);
    } else if (creating) {
      pendingHighlight = title;
    }
  }

  return { update, highlight, resize, destroy };
}
