// Virtual scroll: pure viewport math + thin DOM adapter.
// The core is fully testable without a DOM; the adapter is testable
// with injected scroll state (no real scroll events needed in tests).

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

/** Compute which item index range is visible (plus overscan buffer). */
export function computeVisibleRange(params: ViewportParams): VisibleRange {
  const { scrollTop, viewportHeight, itemHeight, totalCount, overscan } =
    params;

  if (totalCount === 0) return { start: 0, end: 0 };

  const rawStart = Math.floor(scrollTop / itemHeight);
  const rawEnd = Math.ceil((scrollTop + viewportHeight) / itemHeight);

  const start = Math.max(0, rawStart - overscan);
  const end = Math.min(totalCount, rawEnd + overscan);

  return { start, end };
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
  /** Set total count and item renderer. Re-renders immediately. */
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

  function ensureList(): HTMLUListElement {
    if (!ul) {
      ul = document.createElement("ul");
      ul.className = "nearby-list virtual-scroll";
      ul.style.position = "relative";
      container.appendChild(ul);
    }
    return ul;
  }

  function renderRange(range: VisibleRange): void {
    const list = ensureList();

    // Remove all current children and render the new range
    const fragment = document.createDocumentFragment();
    for (let i = range.start; i < range.end; i++) {
      const li = document.createElement("li");
      li.style.position = "absolute";
      li.style.top = `${i * itemHeight}px`;
      li.style.height = `${itemHeight}px`;
      li.style.left = "0";
      li.style.right = "0";

      const content = renderItem(i);
      if (content) {
        li.appendChild(content);
      } else {
        li.className = "virtual-placeholder";
      }
      fragment.appendChild(li);
    }
    list.replaceChildren(fragment);
  }

  function doRefresh(force = false): void {
    const { scrollTop, viewportHeight } = getScrollState();
    const range = computeVisibleRange({
      scrollTop,
      viewportHeight,
      itemHeight,
      totalCount,
      overscan,
    });

    const changed =
      range.start !== lastRange.start || range.end !== lastRange.end;
    lastRange = range;

    if (changed || force) {
      renderRange(range);
    }

    if (changed && onRangeChange) {
      onRangeChange(range);
    }
  }

  return {
    update(count, renderer) {
      totalCount = count;
      renderItem = renderer;
      const list = ensureList();
      list.style.height = `${count * itemHeight}px`;
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

    destroy() {
      if (ul) {
        ul.remove();
        ul = null;
      }
      lastRange = { start: 0, end: 0 };
      totalCount = 0;
    },
  };
}

/**
 * Create a getScrollState function that reads from window scroll,
 * adjusting for the list container's offset from the top of the page.
 */
export function windowScrollState(
  listContainer: HTMLElement,
): () => ScrollState {
  return () => {
    const scrollTop = window.scrollY - listContainer.offsetTop;
    return {
      scrollTop: Math.max(0, scrollTop),
      viewportHeight: window.innerHeight,
    };
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
 * Connect a VirtualList to scroll events from either window or a container element.
 * Throttles via requestAnimationFrame to avoid excessive re-renders.
 * Returns a cleanup function.
 */
export function connectScroll(
  list: { refresh(): void },
  scrollSource?: HTMLElement,
): () => void {
  let rafId: number | null = null;
  const target: EventTarget = scrollSource ?? window;
  const onScroll = () => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      list.refresh();
    });
  };
  target.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    target.removeEventListener("scroll", onScroll);
    if (rafId !== null) cancelAnimationFrame(rafId);
  };
}
