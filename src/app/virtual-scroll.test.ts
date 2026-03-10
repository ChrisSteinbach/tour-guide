// @vitest-environment jsdom

import {
  computeVisibleRange,
  createVirtualList,
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
