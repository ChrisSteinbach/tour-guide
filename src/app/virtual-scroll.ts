// Virtual scroll: pure viewport math + thin DOM adapter.
// The core is fully testable without a DOM; the adapter is testable
// with injected scroll state (no real scroll events needed in tests).

/**
 * Maximum container height (px) before switching to compressed mode.
 * 10 M px is safely below Chrome's ~33 M and Firefox's ~17.8 M limits.
 */
export const MAX_SAFE_SCROLL_HEIGHT = 10_000_000;

export interface VisibleRange {
  /** First visible item index (inclusive). */
  start: number;
  /** Last visible item index (exclusive). */
  end: number;
}

export interface ViewportParams {
  scrollTop: number;
  viewportHeight: number;
  itemHeight: number;
  totalCount: number;
  overscan: number;
}

/**
 * Compressed-mode scroll→index mapping.
 *
 * For very large lists whose natural height (totalCount × itemHeight) exceeds
 * MAX_SAFE_SCROLL_HEIGHT, the list switches to "compressed mode": the container
 * height is capped and scroll position is mapped proportionally to a virtual
 * index. Items are positioned at natural spacing (itemHeight apart) anchored to
 * the current scroll position so scrolling remains visually smooth.
 *
 * The browser's scrollable range is MAX_SAFE_SCROLL_HEIGHT − viewportHeight
 * (scrollTop can never reach MAX_SAFE_SCROLL_HEIGHT itself), so we divide by
 * that to hit the last items; and we scale by totalCount − viewportItems so the
 * final frame shows the last full viewport instead of an empty overrun.
 */
function compressedExactIndex(
  scrollTop: number,
  viewportHeight: number,
  itemHeight: number,
  totalCount: number,
): number {
  const viewportItems = Math.ceil(viewportHeight / itemHeight);
  const maxFirstIndex = Math.max(0, totalCount - viewportItems);
  const maxScrollable = MAX_SAFE_SCROLL_HEIGHT - viewportHeight;
  if (maxScrollable <= 0) return 0;
  const fraction = Math.max(0, Math.min(1, scrollTop / maxScrollable));
  return fraction * maxFirstIndex;
}

/**
 * Compute the visible range plus the compressed-mode `exactIndex` that
 * produced it. The `exactIndex` is `null` in direct mode and in the
 * empty-list case. Threading it out of this function lets the DOM
 * adapter position items off the same value `computeVisibleRange` used,
 * so the frame-level "one exactIndex per frame" invariant is explicit
 * in the type signature rather than implicit in the call order.
 */
function computeFrameLayout(params: ViewportParams): {
  range: VisibleRange;
  exactIndex: number | null;
} {
  const { scrollTop, viewportHeight, itemHeight, totalCount, overscan } =
    params;

  if (totalCount === 0)
    return { range: { start: 0, end: 0 }, exactIndex: null };

  const naturalHeight = totalCount * itemHeight;

  if (naturalHeight <= MAX_SAFE_SCROLL_HEIGHT) {
    // Direct mode — existing behaviour
    const rawStart = Math.floor(scrollTop / itemHeight);
    const rawEnd = Math.ceil((scrollTop + viewportHeight) / itemHeight);
    const start = Math.max(0, rawStart - overscan);
    const end = Math.min(totalCount, rawEnd + overscan);
    return { range: { start, end }, exactIndex: null };
  }

  // Compressed mode — proportional scroll-to-index mapping
  const exactIndex = compressedExactIndex(
    scrollTop,
    viewportHeight,
    itemHeight,
    totalCount,
  );
  // Compressed mode skips overscan: all items are repositioned every frame
  // anchored to scrollTop, so pre-rendering outside the viewport provides
  // no scroll-into-view benefit.
  const start = Math.max(0, Math.floor(exactIndex));
  const end = Math.min(
    totalCount,
    start + Math.ceil(viewportHeight / itemHeight),
  );
  return { range: { start, end }, exactIndex };
}

/** Compute which item index range is visible (plus overscan buffer). */
export function computeVisibleRange(params: ViewportParams): VisibleRange {
  return computeFrameLayout(params).range;
}

// ── DOM adapter ──────────────────────────────────────────────

export interface ScrollState {
  scrollTop: number;
  viewportHeight: number;
}

export interface VirtualListOptions {
  container: HTMLElement;
  itemHeight: number;
  overscan: number;
  /** Injected for testability — in production, reads window.scrollY etc. */
  getScrollState: () => ScrollState;
  onRangeChange?: (range: VisibleRange) => void;
}

export interface VirtualList {
  /**
   * Set total count and item renderer. Re-renders immediately.
   *
   * Shrinking is supported but has a scroll-position side effect: the
   * container height is rewritten in the same call, so the browser
   * synchronously clamps scrollTop to the new maximum. That means the
   * user lands at the *tail* of the new, shorter list — not the top.
   * Callers that want a top-of-list landing on shrink (for example a
   * data reset triggered by a new query) must explicitly scroll the
   * container to 0 *before* the update call. Setting scrollTop after
   * the height rewrite is too late — the clamp has already fired.
   *
   * This matters most for direct→compressed→direct round-trips: a list
   * that was compressed with scrollTop deep inside the virtual range
   * (e.g. 5 M px into a 10 M-capped container) will, on shrink back to
   * direct mode, have the browser clamp scrollTop to `newHeight −
   * viewportHeight`, putting the visible range at the end of the list.
   */
  update(
    totalCount: number,
    renderItem: (index: number) => HTMLElement | null,
  ): void;
  /** Re-render the visible window (call after scroll or data change). */
  refresh(): void;
  /** Current visible range (includes overscan). */
  visibleRange(): VisibleRange;
  /** Current total item count. */
  totalCount(): number;
  /** Whether the list is currently in compressed mode. */
  isCompressed(): boolean;
  /** Remove DOM and listeners. */
  destroy(): void;
}

export function createVirtualList(options: VirtualListOptions): VirtualList {
  const { container, itemHeight, overscan, getScrollState, onRangeChange } =
    options;

  let ul: HTMLUListElement | null = null;
  let totalCount = 0;
  let renderItem: (index: number) => HTMLElement | null = () => null;
  let lastRange: VisibleRange = { start: 0, end: 0 };
  let lastCompressed = false;
  // Compressed-mode items are anchored to scrollTop − subPixelOffset, so they
  // move with every scroll event even while range.start/end stay stable
  // between index ticks. Re-rendering only on range change would leave items
  // frozen in document coordinates and visually sliding off the viewport.
  // Track the last exactIndex so fine scroll within a stable range still
  // triggers a reposition. Direct mode keeps the range-only gate because
  // items live at fixed i*itemHeight offsets.
  let lastExactIndex: number | null = null;

  function ensureList(): HTMLUListElement {
    if (!ul) {
      ul = document.createElement("ul");
      ul.className = "nearby-list virtual-scroll";
      ul.style.position = "relative";
      container.appendChild(ul);
    }
    return ul;
  }

  function createItemElement(index: number, top: number): HTMLLIElement {
    const li = document.createElement("li");
    li.style.position = "absolute";
    li.style.height = `${itemHeight}px`;
    li.style.left = "0";
    li.style.right = "0";
    li.style.top = `${top}px`;

    const content = renderItem(index);
    if (content) {
      li.appendChild(content);
    } else {
      li.className = "virtual-placeholder";
    }
    return li;
  }

  // Direct mode positions items at fixed offsets; the browser handles
  // scroll-into-view.
  function renderDirect(range: VisibleRange): void {
    const list = ensureList();
    const fragment = document.createDocumentFragment();
    for (let i = range.start; i < range.end; i++) {
      fragment.appendChild(createItemElement(i, i * itemHeight));
    }
    list.replaceChildren(fragment);
  }

  // Compressed mode repositions all items every frame anchored to scrollTop.
  function renderCompressed(
    range: VisibleRange,
    scrollTop: number,
    exactIndex: number,
  ): void {
    const list = ensureList();
    const subPixelOffset = (exactIndex - Math.floor(exactIndex)) * itemHeight;
    const anchorTop = scrollTop - subPixelOffset;
    const fragment = document.createDocumentFragment();
    for (let i = range.start; i < range.end; i++) {
      fragment.appendChild(
        createItemElement(i, anchorTop + (i - range.start) * itemHeight),
      );
    }
    list.replaceChildren(fragment);
  }

  function doRefresh(force = false): void {
    const { scrollTop, viewportHeight } = getScrollState();
    const { range, exactIndex } = computeFrameLayout({
      scrollTop,
      viewportHeight,
      itemHeight,
      totalCount,
      overscan,
    });
    lastCompressed = exactIndex !== null;

    const rangeChanged =
      range.start !== lastRange.start || range.end !== lastRange.end;
    // Compressed-mode fine scroll moves items even when the index range
    // stays stable, so include exactIndex in the render predicate. Direct
    // mode does not need this because items sit at fixed i*itemHeight
    // offsets and the browser handles scroll-into-view natively.
    const compressedScrollChanged =
      exactIndex !== null && exactIndex !== lastExactIndex;
    const shouldRender = rangeChanged || compressedScrollChanged;

    lastRange = range;
    lastExactIndex = exactIndex;

    if (shouldRender || force) {
      if (exactIndex !== null) {
        renderCompressed(range, scrollTop, exactIndex);
      } else {
        renderDirect(range);
      }
    }

    if (rangeChanged && onRangeChange) {
      onRangeChange(range);
    }
  }

  return {
    update(count, renderer) {
      totalCount = count;
      renderItem = renderer;
      const list = ensureList();
      const naturalHeight = count * itemHeight;
      list.style.height =
        naturalHeight <= MAX_SAFE_SCROLL_HEIGHT
          ? `${naturalHeight}px`
          : `${MAX_SAFE_SCROLL_HEIGHT}px`;
      doRefresh(true);
    },

    refresh() {
      doRefresh();
    },

    visibleRange() {
      return lastRange;
    },

    totalCount() {
      return totalCount;
    },

    isCompressed() {
      return lastCompressed;
    },

    destroy() {
      if (ul) {
        ul.remove();
        ul = null;
      }
      lastRange = { start: 0, end: 0 };
      totalCount = 0;
      lastCompressed = false;
      lastExactIndex = null;
    },
  };
}

/**
 * Create a getScrollState function that reads from a scrollable container
 * element (for desktop split-view where window scroll is disabled).
 */
export function containerScrollState(
  scrollEl: HTMLElement,
  listEl: HTMLElement,
): () => ScrollState {
  return () => ({
    scrollTop: Math.max(0, scrollEl.scrollTop - listEl.offsetTop),
    viewportHeight: scrollEl.clientHeight,
  });
}

/**
 * Connect a VirtualList to scroll events from a container element.
 * Throttles via requestAnimationFrame to avoid excessive re-renders.
 * Returns a cleanup function.
 */
export function connectScroll(
  list: { refresh(): void },
  scrollSource: HTMLElement,
): () => void {
  let rafId: number | null = null;
  const onScroll = () => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      list.refresh();
    });
  };
  scrollSource.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    scrollSource.removeEventListener("scroll", onScroll);
    if (rafId !== null) cancelAnimationFrame(rafId);
  };
}
