// Infinite scroll lifecycle manager: orchestrates virtualList,
// enrichScheduler, map sync, and scroll connection as a single
// init/update/destroy lifecycle. All I/O boundaries are injected.

import {
  createVirtualList,
  connectScroll,
  containerScrollState,
  type VirtualList,
} from "./virtual-scroll";
import {
  createEnrichScheduler,
  type EnrichScheduler,
} from "./enrich-scheduler";
import { createDebouncedMapSync } from "./debounced-map-sync";
import { createScrollWrapper } from "./render";

export interface InfiniteScrollDeps {
  /** App container element to render into. */
  container: HTMLElement;
  /** Height per item in px (used by virtual scroll). */
  itemHeight: number;
  /** Extra items to render above/below viewport. */
  overscan: number;
  /** Debounce period for enrichment after scroll settles. */
  enrichSettleMs: number;
  /** Debounce period for map marker sync after scroll. */
  mapSyncSettleMs: number;

  /** Return the article title at the given index, or null. */
  getTitle: (index: number) => string | null;
  /** Request enrichment for an article by title. */
  enrich: (title: string) => void;

  /** Return visible articles for map sync, or null to skip. */
  getVisibleArticles: (range: {
    start: number;
    end: number;
  }) => unknown[] | null;
  /** Sync map markers with visible articles. */
  syncMapMarkers: (articles: unknown[]) => void;

  /** Render a single list item. */
  renderItem: (index: number) => HTMLElement | null;
  /** Render the header element. */
  renderHeader: () => HTMLElement;
  /** Render content for the zero-article state (e.g. the "no highlights
   *  nearby" hint), or null to show nothing. Rebuilt on every update so it
   *  tracks the current filter. */
  renderEmptyState?: () => HTMLElement | null;
  /** Called to set up the spatial view (radar/map) initially. */
  initSpatialView: () => void;
  /** Destroy the spatial view. */
  destroySpatialView: () => void;
  /** Called when scroll nears the end of loaded articles. */
  onNearEnd?: () => void;
  /** How many items from the end to trigger onNearEnd (default 50). */
  nearEndThreshold?: number;
}

export interface InfiniteScrollLifecycle {
  /**
   * First-time setup: build DOM, create sub-components.
   *
   * @param listHeight Number of items to render in the virtual list —
   *   may be an optimistic (ratcheted) value ahead of the real loaded
   *   count to reserve scroll headroom for in-flight fetches.
   * @param nearEndAnchor Real loaded-article count against which the
   *   near-end gate fires `onNearEnd`. Defaults to `listHeight` when
   *   omitted (no ratchet bypass). Separated from `listHeight` so the
   *   gate tracks actual data, not optimistic headroom.
   */
  init(listHeight: number, nearEndAnchor?: number): void;
  /**
   * Update with new data. Refreshes header and virtual list.
   *
   * @param listHeight See {@link init}. Can exceed `nearEndAnchor` when
   *   `applyOptimisticCount` has ratcheted the scroll height above the
   *   real loaded count.
   * @param nearEndAnchor See {@link init}. When omitted the previous
   *   anchor is preserved — callers that only know the list height
   *   (e.g. header-restart paths) should omit it rather than guessing.
   */
  update(listHeight: number, nearEndAnchor?: number): void;
  /** Update only the header (e.g. to restart blink animation) without rebuilding the list. */
  updateHeader(): void;
  /** Tear down all sub-components and listeners. */
  destroy(): void;
  /** Whether the lifecycle has been initialized. */
  isActive(): boolean;
  /** Get the underlying virtual list (for reading visible range). */
  virtualList(): VirtualList | null;
  /** Get the current scroll container element (the .app-scroll wrapper). */
  scrollElement(): HTMLElement | null;
}

export function createInfiniteScrollLifecycle(
  deps: InfiniteScrollDeps,
): InfiniteScrollLifecycle {
  let virtualList: VirtualList | null = null;
  let enrichScheduler: EnrichScheduler | null = null;
  let disconnectScroll: (() => void) | null = null;
  let cancelMapSync: (() => void) | null = null;
  let scrollEl: HTMLElement | null = null;
  let emptyEl: HTMLElement | null = null;
  let nearEndAnchor = 0;
  const nearEndThreshold = deps.nearEndThreshold ?? 50;

  /** Show/refresh the empty-state element while the list has zero items. */
  function syncEmptyState(listHeight: number): void {
    emptyEl?.remove();
    emptyEl = null;
    if (listHeight > 0 || !deps.renderEmptyState || !scrollEl) return;
    emptyEl = deps.renderEmptyState();
    if (emptyEl) scrollEl.appendChild(emptyEl);
  }

  function destroy(): void {
    if (disconnectScroll) {
      disconnectScroll();
      disconnectScroll = null;
    }
    if (virtualList) {
      virtualList.destroy();
      virtualList = null;
    }
    if (enrichScheduler) {
      enrichScheduler.destroy();
      enrichScheduler = null;
    }
    if (cancelMapSync) {
      cancelMapSync();
      cancelMapSync = null;
    }
    if (emptyEl) {
      emptyEl.remove();
      emptyEl = null;
    }
    scrollEl = null;
  }

  function init(listHeight: number, anchor?: number): void {
    destroy();
    deps.destroySpatialView();
    deps.container.textContent = "";
    deps.container.appendChild(deps.renderHeader());

    const scrollWrapper = createScrollWrapper();
    deps.container.appendChild(scrollWrapper);
    scrollEl = scrollWrapper;

    const listContainer = document.createElement("div");
    listContainer.className = "virtual-scroll-container";
    scrollWrapper.appendChild(listContainer);

    deps.initSpatialView();

    const mapSync = createDebouncedMapSync({
      settleMs: deps.mapSyncSettleMs,
      getVisibleArticles: deps.getVisibleArticles,
      syncMarkers: deps.syncMapMarkers,
    });
    cancelMapSync = () => mapSync.cancel();

    enrichScheduler = createEnrichScheduler({
      settleMs: deps.enrichSettleMs,
      getTitle: deps.getTitle,
      enrich: deps.enrich,
    });

    const getScrollState = containerScrollState(scrollWrapper, listContainer);

    nearEndAnchor = anchor ?? listHeight;

    virtualList = createVirtualList({
      container: listContainer,
      itemHeight: deps.itemHeight,
      overscan: deps.overscan,
      getScrollState,
      onRangeChange: (range) => {
        enrichScheduler!.onRangeChange(range);
        mapSync.sync(range);
        if (
          deps.onNearEnd &&
          nearEndAnchor > 0 &&
          range.end >= nearEndAnchor - nearEndThreshold
        ) {
          deps.onNearEnd();
        }
      },
    });

    virtualList.update(listHeight, deps.renderItem);
    syncEmptyState(listHeight);

    disconnectScroll = connectScroll(virtualList, scrollWrapper);
  }

  function updateHeader(): void {
    const oldHeader = deps.container.querySelector("header.app-header");
    // Skip replacement while the language dropdown is open so background
    // re-renders (tile loads, distance updates) don't dismiss it.
    if (oldHeader && !oldHeader.querySelector(".lang-listbox:not([hidden])")) {
      oldHeader.replaceWith(deps.renderHeader());
    }
  }

  function update(listHeight: number, anchor?: number): void {
    if (!virtualList) return;
    if (anchor !== undefined) {
      nearEndAnchor = anchor;
    }

    updateHeader();

    virtualList.update(listHeight, deps.renderItem);
    syncEmptyState(listHeight);
  }

  return {
    init,
    update,
    updateHeader,
    destroy,
    isActive: () => virtualList !== null,
    virtualList: () => virtualList,
    scrollElement: () => scrollEl,
  };
}
