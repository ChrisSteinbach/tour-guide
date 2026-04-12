// @vitest-environment jsdom

import {
  computeVisibleRange,
  connectScroll,
  containerScrollState,
  createVirtualList,
  MAX_SAFE_SCROLL_HEIGHT,
  type VisibleRange,
} from "./virtual-scroll";

describe("computeVisibleRange", () => {
  // ── Basic viewport math ──────────────────────────────────────

  it("returns empty range when there are no items", () => {
    const range = computeVisibleRange({
      scrollTop: 0,
      viewportHeight: 500,
      itemHeight: 50,
      totalCount: 0,
      overscan: 5,
    });
    expect(range).toEqual({ start: 0, end: 0 });
  });

  it("shows first items when scrolled to top", () => {
    const range = computeVisibleRange({
      scrollTop: 0,
      viewportHeight: 200,
      itemHeight: 50,
      totalCount: 100,
      overscan: 0,
    });
    expect(range).toEqual({ start: 0, end: 4 });
  });

  it("shifts range when scrolled down", () => {
    const range = computeVisibleRange({
      scrollTop: 300,
      viewportHeight: 200,
      itemHeight: 50,
      totalCount: 100,
      overscan: 0,
    });
    expect(range).toEqual({ start: 6, end: 10 });
  });

  it("clamps end to totalCount", () => {
    const range = computeVisibleRange({
      scrollTop: 4800,
      viewportHeight: 500,
      itemHeight: 50,
      totalCount: 100,
      overscan: 0,
    });
    expect(range.end).toBe(100);
  });

  it("clamps start to 0 for negative scrollTop", () => {
    const range = computeVisibleRange({
      scrollTop: -100,
      viewportHeight: 200,
      itemHeight: 50,
      totalCount: 100,
      overscan: 0,
    });
    expect(range.start).toBe(0);
  });

  // ── Overscan buffer ──────────────────────────────────────────

  it("adds overscan items above and below viewport", () => {
    const range = computeVisibleRange({
      scrollTop: 500,
      viewportHeight: 200,
      itemHeight: 50,
      totalCount: 100,
      overscan: 3,
    });
    expect(range).toEqual({ start: 7, end: 17 });
  });

  it("clamps overscan to valid bounds", () => {
    const range = computeVisibleRange({
      scrollTop: 50,
      viewportHeight: 200,
      itemHeight: 50,
      totalCount: 10,
      overscan: 20,
    });
    expect(range.start).toBe(0);
    expect(range.end).toBe(10);
  });

  // ── Partial items ────────────────────────────────────────────

  it("includes partially visible items at top and bottom", () => {
    const range = computeVisibleRange({
      scrollTop: 75,
      viewportHeight: 200,
      itemHeight: 50,
      totalCount: 100,
      overscan: 0,
    });
    expect(range).toEqual({ start: 1, end: 6 });
  });
});

// ── VirtualList DOM adapter ──────────────────────────────────

describe("createVirtualList", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function makeItem(index: number): HTMLElement {
    const el = document.createElement("div");
    el.textContent = `Item ${index}`;
    el.dataset.index = String(index);
    return el;
  }

  it("creates a list element with correct total height", () => {
    const list = createVirtualList({
      container,
      itemHeight: 50,
      overscan: 0,
      getScrollState: () => ({ scrollTop: 0, viewportHeight: 200 }),
    });
    list.update(20, makeItem);

    const ul = container.querySelector("ul")!;
    expect(ul).toBeTruthy();
    expect(ul.style.height).toBe("1000px"); // 20 * 50
    list.destroy();
  });

  it("renders only visible items", () => {
    const list = createVirtualList({
      container,
      itemHeight: 50,
      overscan: 0,
      getScrollState: () => ({ scrollTop: 0, viewportHeight: 200 }),
    });
    list.update(100, makeItem);

    const items = container.querySelectorAll("li");
    expect(items.length).toBe(4); // 200 / 50
    expect(items[0].querySelector("div")!.dataset.index).toBe("0");
    expect(items[3].querySelector("div")!.dataset.index).toBe("3");
    list.destroy();
  });

  it("positions items absolutely at correct offsets", () => {
    const list = createVirtualList({
      container,
      itemHeight: 50,
      overscan: 0,
      getScrollState: () => ({ scrollTop: 100, viewportHeight: 200 }),
    });
    list.update(100, makeItem);

    const items = container.querySelectorAll("li");
    // scrollTop=100 → start=2, items at 100px, 150px, 200px, 250px
    expect(items[0].style.top).toBe("100px");
    expect(items[1].style.top).toBe("150px");
    list.destroy();
  });

  it("updates rendered items on refresh", () => {
    let scrollTop = 0;
    const list = createVirtualList({
      container,
      itemHeight: 50,
      overscan: 0,
      getScrollState: () => ({ scrollTop, viewportHeight: 200 }),
    });
    list.update(100, makeItem);

    let items = container.querySelectorAll("li");
    expect(items[0].querySelector("div")!.dataset.index).toBe("0");

    scrollTop = 500;
    list.refresh();

    items = container.querySelectorAll("li");
    expect(items[0].querySelector("div")!.dataset.index).toBe("10");
    list.destroy();
  });

  it("fires onRangeChange when visible range changes", () => {
    let scrollTop = 0;
    const ranges: VisibleRange[] = [];
    const list = createVirtualList({
      container,
      itemHeight: 50,
      overscan: 0,
      getScrollState: () => ({ scrollTop, viewportHeight: 200 }),
      onRangeChange: (r) => ranges.push(r),
    });
    list.update(100, makeItem);

    expect(ranges).toEqual([{ start: 0, end: 4 }]);

    scrollTop = 500;
    list.refresh();

    expect(ranges).toEqual([
      { start: 0, end: 4 },
      { start: 10, end: 14 },
    ]);
    list.destroy();
  });

  it("does not fire onRangeChange when range is unchanged", () => {
    const ranges: VisibleRange[] = [];
    const list = createVirtualList({
      container,
      itemHeight: 50,
      overscan: 0,
      getScrollState: () => ({ scrollTop: 0, viewportHeight: 200 }),
      onRangeChange: (r) => ranges.push(r),
    });
    list.update(100, makeItem);
    list.refresh(); // same scroll position

    expect(ranges.length).toBe(1);
    list.destroy();
  });

  it("updates total height when count changes", () => {
    const list = createVirtualList({
      container,
      itemHeight: 50,
      overscan: 0,
      getScrollState: () => ({ scrollTop: 0, viewportHeight: 200 }),
    });
    list.update(20, makeItem);
    expect(container.querySelector("ul")!.style.height).toBe("1000px");

    list.update(50, makeItem);
    expect(container.querySelector("ul")!.style.height).toBe("2500px");
    list.destroy();
  });

  it("exposes current visible range", () => {
    const list = createVirtualList({
      container,
      itemHeight: 50,
      overscan: 3,
      getScrollState: () => ({ scrollTop: 500, viewportHeight: 200 }),
    });
    list.update(100, makeItem);

    expect(list.visibleRange()).toEqual({ start: 7, end: 17 });
    list.destroy();
  });

  it("cleans up DOM on destroy", () => {
    const list = createVirtualList({
      container,
      itemHeight: 50,
      overscan: 0,
      getScrollState: () => ({ scrollTop: 0, viewportHeight: 200 }),
    });
    list.update(10, makeItem);
    expect(container.querySelector("ul")).toBeTruthy();

    list.destroy();
    expect(container.querySelector("ul")).toBeNull();
  });

  it("preserves DOM nodes when refresh does not change the range", () => {
    const list = createVirtualList({
      container,
      itemHeight: 50,
      overscan: 0,
      getScrollState: () => ({ scrollTop: 0, viewportHeight: 200 }),
    });
    list.update(100, makeItem);

    const itemsBefore = container.querySelectorAll("li");
    const firstNode = itemsBefore[0];

    list.refresh(); // same scroll position — range unchanged

    const itemsAfter = container.querySelectorAll("li");
    expect(itemsAfter[0]).toBe(firstNode); // same DOM node, not rebuilt
    list.destroy();
  });

  it("rebuilds DOM when update is called even if range is unchanged", () => {
    const list = createVirtualList({
      container,
      itemHeight: 50,
      overscan: 0,
      getScrollState: () => ({ scrollTop: 0, viewportHeight: 200 }),
    });
    list.update(100, makeItem);

    const firstNode = container.querySelectorAll("li")[0];

    list.update(100, makeItem); // same range but forced rebuild

    expect(container.querySelectorAll("li")[0]).not.toBe(firstNode);
    list.destroy();
  });

  it("renders placeholder li when renderItem returns null", () => {
    const list = createVirtualList({
      container,
      itemHeight: 50,
      overscan: 0,
      getScrollState: () => ({ scrollTop: 0, viewportHeight: 200 }),
    });
    list.update(100, (i) => (i === 1 ? null : makeItem(i)));

    const items = container.querySelectorAll("li");
    expect(items.length).toBe(4);
    // Item 1 should be a placeholder (no child div with data-index)
    expect(items[1].classList.contains("virtual-placeholder")).toBe(true);
    expect(items[0].querySelector("div")!.dataset.index).toBe("0");
    list.destroy();
  });
});

// ── Compressed mode (large list) ──────────────────────────────

describe("computeVisibleRange — compressed mode", () => {
  // Use itemHeight=68 and a count that exceeds MAX_SAFE_SCROLL_HEIGHT / 68
  const itemHeight = 68;
  const totalCount = 200_000; // 200K × 68 = 13.6M > 10M threshold

  it("uses direct mode below threshold", () => {
    const range = computeVisibleRange({
      scrollTop: 0,
      viewportHeight: 800,
      itemHeight: 50,
      totalCount: 100,
      overscan: 0,
    });
    // 100 × 50 = 5000 < 10M → direct mode
    expect(range).toEqual({ start: 0, end: 16 });
  });

  it("uses proportional mapping at scrollTop=0", () => {
    const range = computeVisibleRange({
      scrollTop: 0,
      viewportHeight: 800,
      itemHeight,
      totalCount,
      overscan: 0,
    });
    expect(range.start).toBe(0);
    // ceil(800 / 68) = 12 items visible
    expect(range.end).toBe(12);
  });

  it("maps scrollTop at the middle of the scrollable range to the middle of the index range", () => {
    const viewportHeight = 800;
    // The scrollable range is MAX_SAFE_SCROLL_HEIGHT - viewportHeight.
    const scrollTop = (MAX_SAFE_SCROLL_HEIGHT - viewportHeight) / 2;
    const range = computeVisibleRange({
      scrollTop,
      viewportHeight,
      itemHeight,
      totalCount,
      overscan: 0,
    });
    // maxFirstIndex = 200_000 - ceil(800/68) = 200_000 - 12 = 199_988.
    // Half → start = 99_994, end = 99_994 + 12 = 100_006.
    expect(range.start).toBe(99_994);
    expect(range.end).toBe(100_006);
  });

  it("reaches the final item at max scrollable scrollTop (no dead zone)", () => {
    const viewportHeight = 800;
    const scrollTop = MAX_SAFE_SCROLL_HEIGHT - viewportHeight;
    const range = computeVisibleRange({
      scrollTop,
      viewportHeight,
      itemHeight,
      totalCount,
      overscan: 0,
    });
    // Final item index is totalCount - 1; range is exclusive at the end.
    expect(range.end).toBe(totalCount);
    expect(range.start).toBeLessThan(totalCount - 1);
  });

  it("clamps end to totalCount at the very bottom", () => {
    const range = computeVisibleRange({
      scrollTop: MAX_SAFE_SCROLL_HEIGHT,
      viewportHeight: 800,
      itemHeight,
      totalCount,
      overscan: 0,
    });
    expect(range.end).toBe(totalCount);
  });

  it("does not apply overscan in compressed mode", () => {
    const viewportHeight = 800;
    const scrollTop = (MAX_SAFE_SCROLL_HEIGHT - viewportHeight) / 2;
    const range = computeVisibleRange({
      scrollTop,
      viewportHeight,
      itemHeight,
      totalCount,
      overscan: 5,
    });
    expect(range.start).toBe(99_994);
    expect(range.end).toBe(100_006);
  });
});

describe("createVirtualList — compressed mode", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function makeItem(index: number): HTMLElement {
    const el = document.createElement("div");
    el.textContent = `Item ${index}`;
    el.dataset.index = String(index);
    return el;
  }

  it("caps container height at MAX_SAFE_SCROLL_HEIGHT for large counts", () => {
    const list = createVirtualList({
      container,
      itemHeight: 68,
      overscan: 0,
      getScrollState: () => ({ scrollTop: 0, viewportHeight: 800 }),
    });
    list.update(200_000, makeItem); // 200K × 68 = 13.6M > 10M

    const ul = container.querySelector("ul")!;
    expect(ul.style.height).toBe(`${MAX_SAFE_SCROLL_HEIGHT}px`);
    list.destroy();
  });

  it("uses natural height below threshold", () => {
    const list = createVirtualList({
      container,
      itemHeight: 50,
      overscan: 0,
      getScrollState: () => ({ scrollTop: 0, viewportHeight: 200 }),
    });
    list.update(100, makeItem);

    expect(container.querySelector("ul")!.style.height).toBe("5000px");
    list.destroy();
  });

  it("positions items at natural spacing in compressed mode", () => {
    const scrollTop = 5_000_000; // middle of 10M
    const list = createVirtualList({
      container,
      itemHeight: 68,
      overscan: 0,
      getScrollState: () => ({ scrollTop, viewportHeight: 800 }),
    });
    list.update(200_000, makeItem);

    const items = container.querySelectorAll("li");
    expect(items.length).toBeGreaterThan(0);

    // Items should be 68px apart (natural itemHeight spacing)
    const top0 = parseFloat(items[0].style.top);
    const top1 = parseFloat(items[1].style.top);
    expect(top1 - top0).toBe(68);
  });

  it("anchor-based positioning keeps items near scrollTop", () => {
    const scrollTop = 5_000_000;
    const list = createVirtualList({
      container,
      itemHeight: 68,
      overscan: 0,
      getScrollState: () => ({ scrollTop, viewportHeight: 800 }),
    });
    list.update(200_000, makeItem);

    const items = container.querySelectorAll("li");
    const firstTop = parseFloat(items[0].style.top);
    // First item should be at or just before scrollTop
    expect(firstTop).toBeLessThanOrEqual(scrollTop);
    expect(firstTop).toBeGreaterThan(scrollTop - 68);
    list.destroy();
  });

  it("MAX_SAFE_SCROLL_HEIGHT is a positive number", () => {
    expect(MAX_SAFE_SCROLL_HEIGHT).toBeGreaterThan(0);
  });

  it("transitions from direct to compressed mode when update grows past threshold", () => {
    const itemHeight = 68;
    // Start below threshold: 1000 × 68 = 68,000 < 10M
    const smallCount = 1000;
    // Grow past threshold: 200K × 68 = 13.6M > 10M
    const largeCount = 200_000;

    const scrollTop = 500;
    const list = createVirtualList({
      container,
      itemHeight,
      overscan: 0,
      getScrollState: () => ({ scrollTop, viewportHeight: 800 }),
    });

    // Phase 1: direct mode
    list.update(smallCount, makeItem);
    const ul = container.querySelector("ul")!;
    expect(ul.style.height).toBe(`${smallCount * itemHeight}px`);

    const directItems = container.querySelectorAll("li");
    // In direct mode at scrollTop=500: start = floor(500/68) = 7
    expect(directItems[0].querySelector("div")!.dataset.index).toBe("7");
    // Items positioned at index * itemHeight
    expect(directItems[0].style.top).toBe(`${7 * itemHeight}px`);

    // Phase 2: grow past threshold — switches to compressed mode
    list.update(largeCount, makeItem);
    expect(ul.style.height).toBe(`${MAX_SAFE_SCROLL_HEIGHT}px`);

    const compressedItems = container.querySelectorAll("li");
    expect(compressedItems.length).toBeGreaterThan(0);

    // Items should still be itemHeight apart (natural spacing)
    const top0 = parseFloat(compressedItems[0].style.top);
    const top1 = parseFloat(compressedItems[1].style.top);
    expect(top1 - top0).toBe(itemHeight);

    // First item should be anchored near scrollTop (no visual jump)
    expect(top0).toBeLessThanOrEqual(scrollTop);
    expect(top0).toBeGreaterThan(scrollTop - itemHeight);

    list.destroy();
  });
});

// ── direct → compressed → direct round-trip ─────────────────

describe("createVirtualList — direct→compressed→direct round-trip", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function makeItem(index: number): HTMLElement {
    const el = document.createElement("div");
    el.textContent = `Item ${index}`;
    el.dataset.index = String(index);
    return el;
  }

  // jsdom doesn't clamp scrollTop against container height the way real
  // browsers do, so we wire up a getScrollState that reads the current
  // ul.style.height and applies the clamp explicitly. That mirrors what
  // Chrome / Firefox do when a scroll container shrinks below scrollTop.
  function makeClampingScroll(viewportHeight: number) {
    const state = { raw: 0 };
    const getState = () => {
      const ul = container.querySelector("ul");
      const ulHeight = ul ? parseFloat(ul.style.height) || 0 : 0;
      const maxScroll = Math.max(0, ulHeight - viewportHeight);
      return {
        scrollTop: Math.min(state.raw, maxScroll),
        viewportHeight,
      };
    };
    return { state, getState };
  }

  it("shrinking update(): scrollTop clamps to the new tail, visible range follows", () => {
    const itemHeight = 68;
    const viewportHeight = 800;
    const { state, getState } = makeClampingScroll(viewportHeight);

    const list = createVirtualList({
      container,
      itemHeight,
      overscan: 0,
      getScrollState: getState,
    });

    // Grow into compressed mode, then scroll deep into the virtual range.
    list.update(200_000, makeItem);
    state.raw = 5_000_000;
    list.refresh();

    // Shrink back to a short list that fits in direct mode.
    list.update(500, makeItem);

    // Container is now 500 × 68 = 34_000px; the browser clamps scrollTop
    // to 34_000 − 800 = 33_200. Direct-mode range math then lands at the
    // tail of the new list.
    expect(container.querySelector("ul")!.style.height).toBe(
      `${500 * itemHeight}px`,
    );
    const range = list.visibleRange();
    expect(range.start).toBe(Math.floor(33_200 / itemHeight)); // 488
    expect(range.end).toBe(500);
  });

  it("full direct → compressed → direct round-trip switches positioning back to natural offsets", () => {
    const itemHeight = 68;
    const viewportHeight = 800;
    const { state, getState } = makeClampingScroll(viewportHeight);

    const list = createVirtualList({
      container,
      itemHeight,
      overscan: 0,
      getScrollState: getState,
    });

    // Phase 1: direct mode with a small list.
    list.update(1000, makeItem);
    expect(container.querySelector("ul")!.style.height).toBe(
      `${1000 * itemHeight}px`,
    );
    expect(container.querySelectorAll("li")[0].style.top).toBe("0px");

    // Phase 2: grow past the threshold → compressed mode. Scroll deep so
    // the anchor-based positioning drops items near scrollTop.
    list.update(200_000, makeItem);
    state.raw = 5_000_000;
    list.refresh();
    const p2First = container.querySelectorAll("li")[0];
    expect(parseFloat(p2First.style.top)).toBeGreaterThan(
      5_000_000 - itemHeight,
    );

    // Phase 3: shrink back below the threshold → direct mode again.
    // The critical assertion is that the items are positioned at
    // index * itemHeight (direct mode), not left over at the compressed
    // anchor near 5 M px.
    list.update(500, makeItem);
    expect(container.querySelector("ul")!.style.height).toBe(
      `${500 * itemHeight}px`,
    );

    const p3Items = container.querySelectorAll("li");
    expect(p3Items.length).toBeGreaterThan(0);
    const firstTop = parseFloat(p3Items[0].style.top);
    const firstIndex = parseInt(
      p3Items[0].querySelector("div")!.dataset.index!,
      10,
    );
    // Direct-mode positioning: top === index * itemHeight, and it must
    // be inside the new shrunken container — not stuck at the 5 M px
    // compressed-mode anchor from before.
    expect(firstTop).toBe(firstIndex * itemHeight);
    expect(firstTop).toBeLessThan(500 * itemHeight);
  });
});

// ── isCompressed ────────────────────────────────────────────

describe("createVirtualList — isCompressed", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function makeItem(index: number): HTMLElement {
    const el = document.createElement("div");
    el.textContent = `Item ${index}`;
    el.dataset.index = String(index);
    return el;
  }

  it("returns false for a small list", () => {
    const list = createVirtualList({
      container,
      itemHeight: 50,
      overscan: 0,
      getScrollState: () => ({ scrollTop: 0, viewportHeight: 800 }),
    });
    list.update(100, makeItem); // 100 × 50 = 5000 < 10M
    expect(list.isCompressed()).toBe(false);
    list.destroy();
  });

  it("returns true for a large list", () => {
    const list = createVirtualList({
      container,
      itemHeight: 68,
      overscan: 0,
      getScrollState: () => ({ scrollTop: 0, viewportHeight: 800 }),
    });
    list.update(200_000, makeItem); // 200K × 68 = 13.6M > 10M
    expect(list.isCompressed()).toBe(true);
    list.destroy();
  });

  it("transitions correctly: small → large → small", () => {
    const list = createVirtualList({
      container,
      itemHeight: 68,
      overscan: 0,
      getScrollState: () => ({ scrollTop: 0, viewportHeight: 800 }),
    });

    list.update(100, makeItem);
    expect(list.isCompressed()).toBe(false);

    list.update(200_000, makeItem);
    expect(list.isCompressed()).toBe(true);

    list.update(100, makeItem);
    expect(list.isCompressed()).toBe(false);

    list.destroy();
  });
});

// ── connectScroll ────────────────────────────────────────────

describe("connectScroll", () => {
  it("refreshes the list after a scroll event is flushed", () => {
    const frames: Array<() => void> = [];
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => {
        frames.push(() => cb(0));
        return frames.length;
      });

    const scrollSource = document.createElement("div");
    let refreshes = 0;
    const cleanup = connectScroll({ refresh: () => refreshes++ }, scrollSource);

    scrollSource.dispatchEvent(new Event("scroll"));
    expect(refreshes).toBe(0); // not yet — waiting for frame
    frames.forEach((f) => f());
    expect(refreshes).toBe(1);

    cleanup();
    rafSpy.mockRestore();
  });

  it("coalesces rapid scroll events into a single refresh per frame", () => {
    const frames: Array<() => void> = [];
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => {
        frames.push(() => cb(0));
        return frames.length;
      });

    const scrollSource = document.createElement("div");
    let refreshes = 0;
    const cleanup = connectScroll({ refresh: () => refreshes++ }, scrollSource);

    scrollSource.dispatchEvent(new Event("scroll"));
    scrollSource.dispatchEvent(new Event("scroll"));
    scrollSource.dispatchEvent(new Event("scroll"));
    expect(frames.length).toBe(1); // only one frame scheduled

    frames[0]();
    expect(refreshes).toBe(1);

    // After the frame fires, the next scroll re-arms
    scrollSource.dispatchEvent(new Event("scroll"));
    expect(frames.length).toBe(2);
    frames[1]();
    expect(refreshes).toBe(2);

    cleanup();
    rafSpy.mockRestore();
  });

  it("stops refreshing after cleanup is called", () => {
    const frames: Array<() => void> = [];
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => {
        frames.push(() => cb(0));
        return frames.length;
      });

    const scrollSource = document.createElement("div");
    let refreshes = 0;
    const cleanup = connectScroll({ refresh: () => refreshes++ }, scrollSource);

    cleanup();
    scrollSource.dispatchEvent(new Event("scroll"));
    frames.forEach((f) => f());
    expect(refreshes).toBe(0);

    rafSpy.mockRestore();
  });

  it("cancels a pending frame on cleanup", () => {
    const frames: Array<() => void> = [];
    const cancelled: number[] = [];
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => {
        frames.push(() => cb(0));
        return frames.length;
      });
    const cafSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation((id) => {
        cancelled.push(id);
      });

    const scrollSource = document.createElement("div");
    const cleanup = connectScroll({ refresh: () => {} }, scrollSource);

    scrollSource.dispatchEvent(new Event("scroll"));
    cleanup();

    expect(cancelled).toEqual([1]);

    rafSpy.mockRestore();
    cafSpy.mockRestore();
  });
});

// ── containerScrollState ─────────────────────────────────────

describe("containerScrollState", () => {
  it("reports scrollTop and clientHeight from the scroll element", () => {
    const scrollEl = document.createElement("div");
    const listEl = document.createElement("div");
    scrollEl.appendChild(listEl);

    Object.defineProperty(scrollEl, "scrollTop", {
      value: 250,
      configurable: true,
    });
    Object.defineProperty(scrollEl, "clientHeight", {
      value: 600,
      configurable: true,
    });

    const getState = containerScrollState(scrollEl, listEl);
    expect(getState()).toEqual({ scrollTop: 250, viewportHeight: 600 });
  });

  it("subtracts the list's offsetTop so scroll is relative to the list", () => {
    const scrollEl = document.createElement("div");
    const listEl = document.createElement("div");
    scrollEl.appendChild(listEl);

    Object.defineProperty(scrollEl, "scrollTop", {
      value: 500,
      configurable: true,
    });
    Object.defineProperty(scrollEl, "clientHeight", {
      value: 400,
      configurable: true,
    });
    Object.defineProperty(listEl, "offsetTop", {
      value: 120,
      configurable: true,
    });

    const getState = containerScrollState(scrollEl, listEl);
    expect(getState().scrollTop).toBe(380); // 500 - 120
  });

  it("clamps scrollTop to zero when the list header is still on-screen", () => {
    const scrollEl = document.createElement("div");
    const listEl = document.createElement("div");
    scrollEl.appendChild(listEl);

    Object.defineProperty(scrollEl, "scrollTop", {
      value: 50,
      configurable: true,
    });
    Object.defineProperty(scrollEl, "clientHeight", {
      value: 400,
      configurable: true,
    });
    Object.defineProperty(listEl, "offsetTop", {
      value: 200,
      configurable: true,
    });

    const getState = containerScrollState(scrollEl, listEl);
    expect(getState().scrollTop).toBe(0);
  });

  it("reflects live updates to scrollTop on each call", () => {
    const scrollEl = document.createElement("div");
    const listEl = document.createElement("div");
    scrollEl.appendChild(listEl);

    let live = 0;
    Object.defineProperty(scrollEl, "scrollTop", {
      get: () => live,
      configurable: true,
    });
    Object.defineProperty(scrollEl, "clientHeight", {
      value: 400,
      configurable: true,
    });

    const getState = containerScrollState(scrollEl, listEl);
    expect(getState().scrollTop).toBe(0);
    live = 900;
    expect(getState().scrollTop).toBe(900);
  });
});
