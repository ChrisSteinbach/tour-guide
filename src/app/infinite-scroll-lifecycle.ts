// Infinite scroll lifecycle manager: orchestrates virtualList,
// enrichScheduler, map sync, and scroll connection as a single
// init/update/destroy lifecycle. All I/O boundaries are injected.

import {
  createVirtualList,
  connectScroll,
  windowScrollState,
  type VirtualList,
} from "./virtual-scroll";
import {
  createEnrichScheduler,
  type EnrichScheduler,
} from "./enrich-scheduler";
import { createDebouncedMapSync } from "./debounced-map-sync";

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
  /** Cancel in-flight enrichment requests. */
  cancelEnrich: () => void;

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
  /** Called to set up the browse map initially (desktop only). */
  initBrowseMap: () => void;
  /** Destroy the browse map. */
  destroyBrowseMap: () => void;
  /** Called when scroll nears the end of loaded articles. */
  onNearEnd?: () => void;
  /** How many items from the end to trigger onNearEnd (default 50). */
  nearEndThreshold?: number;
}

export interface InfiniteScrollLifecycle {
  /** First-time setup: build DOM, create sub-components. */
  init(totalCount: number, loadedCount?: number): void;
  /** Update with new data. Refreshes header and virtual list. */
  update(totalCount: number, loadedCount?: number): void;
  /** Update only the header (e.g. to restart blink animation) without rebuilding the list. */
  updateHeader(): void;
  /** Tear down all sub-components and listeners. */
  destroy(): void;
  /** Whether the lifecycle has been initialized. */
  isActive(): boolean;
  /** Get the underlying virtual list (for reading visible range). */
  virtualList(): VirtualList | null;
}

export function createInfiniteScrollLifecycle(
  deps: InfiniteScrollDeps,
): InfiniteScrollLifecycle {
  let virtualList: VirtualList | null = null;
  let enrichScheduler: EnrichScheduler | null = null;
  let disconnectScroll: (() => void) | null = null;
  let cancelMapSync: (() => void) | null = null;
  let currentLoadedCount = 0;
  const nearEndThreshold = deps.nearEndThreshold ?? 50;

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
  }

  function init(totalCount: number, loadedCount?: number): void {
    destroy();
    deps.destroyBrowseMap();
    deps.container.textContent = "";
    deps.container.appendChild(deps.renderHeader());

    const listContainer = document.createElement("div");
    listContainer.className = "virtual-scroll-container";
    deps.container.appendChild(listContainer);

    deps.initBrowseMap();

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
      cancel: deps.cancelEnrich,
    });

    const getScrollState = windowScrollState(listContainer);

    currentLoadedCount = loadedCount ?? totalCount;

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
          currentLoadedCount > 0 &&
          range.end >= currentLoadedCount - nearEndThreshold
        ) {
          deps.onNearEnd();
        }
      },
    });

    virtualList.update(totalCount, deps.renderItem);

    disconnectScroll = connectScroll(virtualList);
  }

  function updateHeader(): void {
    const oldHeader = deps.container.querySelector("header.app-header");
    // Skip replacement while the language dropdown is open so background
    // re-renders (tile loads, distance updates) don't dismiss it.
    if (oldHeader && !oldHeader.querySelector(".lang-listbox:not([hidden])")) {
      oldHeader.replaceWith(deps.renderHeader());
    }
  }

  function update(totalCount: number, loadedCount?: number): void {
    if (!virtualList) return;
    if (loadedCount !== undefined) {
      currentLoadedCount = loadedCount;
    }

    updateHeader();

    // Update virtual list
    virtualList.update(totalCount, deps.renderItem);
  }

  return {
    init,
    update,
    updateHeader,
    destroy,
    isActive: () => virtualList !== null,
    virtualList: () => virtualList,
  };
}
