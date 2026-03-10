// Infinite scroll lifecycle manager: orchestrates virtualList,
// enrichScheduler, map sync, and scroll connection as a single
// init/update/destroy lifecycle. All I/O boundaries are injected.

import {
  createVirtualList,
  connectScroll,
  windowScrollState,
  containerScrollState,
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

  /** Whether desktop split-view is active. */
  isDesktop: () => boolean;

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
  init(totalCount: number): void;
  /** Update with new data. Refreshes header and virtual list. */
  update(totalCount: number): void;
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
  let currentTotalCount = 0;
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

  function init(totalCount: number): void {
    destroy();
    deps.destroyBrowseMap();
    deps.container.textContent = "";
    deps.container.appendChild(deps.renderHeader());

    const listContainer = document.createElement("div");
    listContainer.className = "virtual-scroll-container";
    deps.container.appendChild(listContainer);

    const isDesktop = deps.isDesktop();
    if (isDesktop) {
      deps.initBrowseMap();
    }

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

    const getScrollState = isDesktop
      ? containerScrollState(listContainer, listContainer)
      : windowScrollState(listContainer);

    currentTotalCount = totalCount;

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
          currentTotalCount > 0 &&
          range.end >= currentTotalCount - nearEndThreshold
        ) {
          deps.onNearEnd();
        }
      },
    });

    virtualList.update(totalCount, deps.renderItem);

    disconnectScroll = isDesktop
      ? connectScroll(virtualList, listContainer)
      : connectScroll(virtualList);
  }

  function updateHeader(): void {
    const oldHeader = deps.container.querySelector("header.app-header");
    const newHeader = deps.renderHeader();
    if (oldHeader) {
      oldHeader.replaceWith(newHeader);
    }
  }

  function update(totalCount: number): void {
    if (!virtualList) return;
    currentTotalCount = totalCount;

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
