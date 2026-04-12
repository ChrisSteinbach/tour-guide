// @vitest-environment jsdom
import { createInfiniteScrollLifecycle } from "./infinite-scroll-lifecycle";
import type { InfiniteScrollDeps } from "./infinite-scroll-lifecycle";

/** Create a minimal DOM container for tests. */
function makeContainer(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

/** Build deps with sensible defaults; override per test. */
function makeDeps(
  overrides: Partial<InfiniteScrollDeps> = {},
): InfiniteScrollDeps {
  const container = overrides.container ?? makeContainer();
  return {
    container,
    itemHeight: 68,
    overscan: 5,
    enrichSettleMs: 300,
    mapSyncSettleMs: 150,
    getTitle: (i) => `Article ${i}`,
    enrich: () => {},
    cancelEnrich: () => {},
    getVisibleArticles: () => null,
    syncMapMarkers: () => {},
    renderItem: () => {
      const el = document.createElement("div");
      el.textContent = "item";
      return el;
    },
    renderHeader: () => {
      const header = document.createElement("header");
      header.className = "app-header";
      header.textContent = "Header";
      return header;
    },
    initBrowseMap: () => {},
    destroyBrowseMap: () => {},
    ...overrides,
  };
}

describe("InfiniteScrollLifecycle", () => {
  afterEach(() => {
    document.body.textContent = "";
  });

  describe("init", () => {
    it("creates DOM structure with header and virtual scroll container", () => {
      const deps = makeDeps();
      const lifecycle = createInfiniteScrollLifecycle(deps);

      lifecycle.init(10);

      expect(deps.container.querySelector("header.app-header")).toBeTruthy();
      expect(
        deps.container.querySelector(".virtual-scroll-container"),
      ).toBeTruthy();
    });

    it("nests virtual-scroll-container inside .app-scroll wrapper", () => {
      const deps = makeDeps();
      const lifecycle = createInfiniteScrollLifecycle(deps);

      lifecycle.init(10);

      expect(
        deps.container.querySelector(".app-scroll > .virtual-scroll-container"),
      ).toBeTruthy();
    });

    it("marks lifecycle as active after init", () => {
      const lifecycle = createInfiniteScrollLifecycle(makeDeps());

      expect(lifecycle.isActive()).toBe(false);
      lifecycle.init(5);
      expect(lifecycle.isActive()).toBe(true);
    });

    it("clears container contents before building DOM", () => {
      const container = makeContainer();
      const p = document.createElement("p");
      p.textContent = "old content";
      container.appendChild(p);
      const lifecycle = createInfiniteScrollLifecycle(makeDeps({ container }));

      lifecycle.init(5);

      expect(container.querySelector("p")).toBeNull();
    });

    it("destroys browse map before rebuilding", () => {
      const calls: string[] = [];
      const lifecycle = createInfiniteScrollLifecycle(
        makeDeps({ destroyBrowseMap: () => calls.push("destroyBrowseMap") }),
      );

      lifecycle.init(5);

      expect(calls).toContain("destroyBrowseMap");
    });

    it("initializes browse map on init", () => {
      const calls: string[] = [];
      const lifecycle = createInfiniteScrollLifecycle(
        makeDeps({
          initBrowseMap: () => calls.push("initBrowseMap"),
        }),
      );

      lifecycle.init(5);

      expect(calls).toContain("initBrowseMap");
    });

    it("creates virtual list with correct total count", () => {
      const lifecycle = createInfiniteScrollLifecycle(makeDeps());

      lifecycle.init(20);

      expect(lifecycle.virtualList()?.totalCount()).toBe(20);
    });

    it("renders items via renderItem callback", () => {
      const rendered: number[] = [];
      const lifecycle = createInfiniteScrollLifecycle(
        makeDeps({
          renderItem: (i) => {
            rendered.push(i);
            const el = document.createElement("div");
            el.textContent = `item-${i}`;
            return el;
          },
        }),
      );

      lifecycle.init(3);

      // Virtual scroll should have called renderItem for visible items
      expect(rendered.length).toBeGreaterThan(0);
    });
  });

  describe("update", () => {
    it("replaces header with fresh render", () => {
      let headerCount = 0;
      const lifecycle = createInfiniteScrollLifecycle(
        makeDeps({
          renderHeader: () => {
            headerCount++;
            const h = document.createElement("header");
            h.className = "app-header";
            h.textContent = `Header ${headerCount}`;
            return h;
          },
        }),
      );

      lifecycle.init(5);
      expect(headerCount).toBe(1);

      lifecycle.update(10);
      expect(headerCount).toBe(2);
    });

    it("does nothing if not initialized", () => {
      const container = makeContainer();
      const lifecycle = createInfiniteScrollLifecycle(makeDeps({ container }));

      // Should not throw
      lifecycle.update(10);

      expect(container.querySelector("header")).toBeNull();
    });

    it("updates virtual list total count", () => {
      const lifecycle = createInfiniteScrollLifecycle(makeDeps());

      lifecycle.init(5);
      lifecycle.update(50);

      expect(lifecycle.virtualList()?.totalCount()).toBe(50);
    });
  });

  describe("destroy", () => {
    it("marks lifecycle as inactive", () => {
      const lifecycle = createInfiniteScrollLifecycle(makeDeps());

      lifecycle.init(5);
      lifecycle.destroy();

      expect(lifecycle.isActive()).toBe(false);
    });

    it("removes virtual scroll DOM", () => {
      const container = makeContainer();
      const lifecycle = createInfiniteScrollLifecycle(makeDeps({ container }));

      lifecycle.init(5);
      expect(
        container.querySelector(".nearby-list.virtual-scroll"),
      ).toBeTruthy();

      lifecycle.destroy();
      expect(container.querySelector(".nearby-list.virtual-scroll")).toBeNull();
    });

    it("is safe to call multiple times", () => {
      const lifecycle = createInfiniteScrollLifecycle(makeDeps());

      lifecycle.init(5);
      lifecycle.destroy();
      lifecycle.destroy(); // should not throw
    });

    it("is safe to call without init", () => {
      const lifecycle = createInfiniteScrollLifecycle(makeDeps());
      lifecycle.destroy(); // should not throw
    });
  });

  describe("updateHeader skips replacement while dropdown is open", () => {
    it("preserves header when lang dropdown is open", () => {
      const container = makeContainer();
      const lifecycle = createInfiniteScrollLifecycle(
        makeDeps({
          container,
          renderHeader: () => {
            const h = document.createElement("header");
            h.className = "app-header";
            const listbox = document.createElement("ul");
            listbox.className = "lang-listbox";
            listbox.hidden = true;
            h.appendChild(listbox);
            return h;
          },
        }),
      );

      lifecycle.init(5);

      const oldHeader = container.querySelector("header.app-header")!;
      // Simulate opening the dropdown
      const listbox = oldHeader.querySelector(".lang-listbox") as HTMLElement;
      listbox.hidden = false;

      lifecycle.updateHeader();

      // Header should be the same DOM node (not replaced)
      expect(container.querySelector("header.app-header")).toBe(oldHeader);
    });

    it("replaces header when lang dropdown is closed", () => {
      let headerCount = 0;
      const lifecycle = createInfiniteScrollLifecycle(
        makeDeps({
          renderHeader: () => {
            headerCount++;
            const h = document.createElement("header");
            h.className = "app-header";
            const listbox = document.createElement("ul");
            listbox.className = "lang-listbox";
            listbox.hidden = true;
            h.appendChild(listbox);
            h.textContent = `Header ${headerCount}`;
            return h;
          },
        }),
      );

      lifecycle.init(5);
      lifecycle.updateHeader();

      expect(headerCount).toBe(2);
    });
  });

  describe("scrollElement", () => {
    it("returns null before init", () => {
      const lifecycle = createInfiniteScrollLifecycle(makeDeps());

      expect(lifecycle.scrollElement()).toBeNull();
    });

    it("returns the .app-scroll wrapper after init", () => {
      const lifecycle = createInfiniteScrollLifecycle(makeDeps());

      lifecycle.init(10);

      const el = lifecycle.scrollElement();
      expect(el).not.toBeNull();
      expect(el!.className).toBe("app-scroll");
    });

    it("returns null after destroy", () => {
      const lifecycle = createInfiniteScrollLifecycle(makeDeps());

      lifecycle.init(10);
      lifecycle.destroy();

      expect(lifecycle.scrollElement()).toBeNull();
    });
  });

  describe("re-init after destroy", () => {
    it("can init again after destroy", () => {
      const lifecycle = createInfiniteScrollLifecycle(makeDeps());

      lifecycle.init(5);
      lifecycle.destroy();
      lifecycle.init(10);

      expect(lifecycle.isActive()).toBe(true);
      expect(lifecycle.virtualList()?.totalCount()).toBe(10);
    });
  });

  describe("enrichment wiring", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("enriches visible articles after settle period", () => {
      const enriched: string[] = [];
      const lifecycle = createInfiniteScrollLifecycle(
        makeDeps({
          enrichSettleMs: 200,
          getTitle: (i) => `Article ${i}`,
          enrich: (title) => enriched.push(title),
        }),
      );

      lifecycle.init(3);

      // Virtual scroll triggers onRangeChange immediately on init,
      // which feeds into enrichScheduler. After settle, enrich fires.
      vi.advanceTimersByTime(200);

      expect(enriched.length).toBeGreaterThan(0);
    });

    it("does not enrich after destroy", () => {
      const enriched: string[] = [];
      const lifecycle = createInfiniteScrollLifecycle(
        makeDeps({
          enrichSettleMs: 200,
          getTitle: (i) => `Article ${i}`,
          enrich: (title) => enriched.push(title),
        }),
      );

      lifecycle.init(3);
      lifecycle.destroy();
      vi.advanceTimersByTime(200);

      expect(enriched).toEqual([]);
    });
  });

  describe("onNearEnd", () => {
    it("fires when scroll range nears total count", () => {
      let called = 0;
      const lifecycle = createInfiniteScrollLifecycle(
        makeDeps({
          onNearEnd: () => called++,
          nearEndThreshold: 5,
        }),
      );

      // With totalCount=3 and threshold=5, the initial render (range.end >= 3-5=-2)
      // should trigger immediately since any visible range meets the condition.
      lifecycle.init(3);
      expect(called).toBeGreaterThan(0);
    });

    it("does not fire when far from end", () => {
      let called = 0;
      const lifecycle = createInfiniteScrollLifecycle(
        makeDeps({
          onNearEnd: () => called++,
          nearEndThreshold: 2,
        }),
      );

      // With 1000 items, initial render only shows top items — well below threshold.
      lifecycle.init(1000);
      expect(called).toBe(0);
    });

    it("adjusts to updated loaded count", () => {
      let called = 0;
      const lifecycle = createInfiniteScrollLifecycle(
        makeDeps({
          onNearEnd: () => called++,
          nearEndThreshold: 2,
        }),
      );

      lifecycle.init(1000);
      expect(called).toBe(0);

      // Shrink loaded count so visible range meets threshold
      lifecycle.update(3, 3);
      expect(called).toBeGreaterThan(0);
    });

    it("fires onNearEnd based on loadedCount, not totalCount", () => {
      let called = 0;
      const lifecycle = createInfiniteScrollLifecycle(
        makeDeps({
          onNearEnd: () => called++,
          nearEndThreshold: 5,
        }),
      );

      // Init with small count — near-end fires on init (range.end >= 3 - 5)
      lifecycle.init(3);

      // Update: inflate totalCount but keep loadedCount small
      // Virtual list now has 10000 items, but loadedCount stays 3
      // Near-end check: range.end >= 3 - 5 = -2 → true
      called = 0;
      lifecycle.update(10000, 3);
      expect(called).toBeGreaterThan(0);
    });

    it("does not fire onNearEnd in compressed mode even when mapped range exceeds loadedCount", () => {
      // In compressed mode, computeVisibleRange maps scrollTop proportionally
      // onto [0, totalCount], so range.end lives in virtual-index space and
      // can sit arbitrarily far above currentLoadedCount. The near-end check
      // must not interpret those mapped indices as progress through loaded
      // data — otherwise it fires on every scroll event.
      let called = 0;
      // 200_000 * 68 = 13.6M > MAX_SAFE_SCROLL_HEIGHT (10M) → compressed mode
      const hugeTotal = 200_000;
      const lifecycle = createInfiniteScrollLifecycle(
        makeDeps({
          itemHeight: 68,
          onNearEnd: () => called++,
          nearEndThreshold: 50,
        }),
      );

      // Init with a small loadedCount but a totalCount large enough to
      // trigger compressed mode in the virtual list.
      lifecycle.init(hugeTotal, 500);
      // In direct mode this would fire (range.end spans huge mapped indices
      // vs. currentLoadedCount=500); compressed mode must suppress it.
      expect(called).toBe(0);
    });

    // XOR rationale — do not "simplify" the dispatch in
    // infinite-scroll-lifecycle.ts back into parallel onNearEnd +
    // onVisibleRangeChange calls. onNearEnd issues
    // ensureRange(start, end + PREFETCH_BUFFER), which is a superset of
    // onVisibleRangeChange's ensureRange(start, end); firing both would
    // queue a redundant unbuffered fetch behind the prefetch (both
    // serialize via pendingFetch). The next two tests pin that exactly
    // one of the two callbacks fires per range event.
    it("skips onVisibleRangeChange when onNearEnd fires (consolidated fetch)", () => {
      const visibleRangeCalls: Array<{ start: number; end: number }> = [];
      let nearEndCalls = 0;
      const lifecycle = createInfiniteScrollLifecycle(
        makeDeps({
          onNearEnd: () => nearEndCalls++,
          onVisibleRangeChange: (range) => visibleRangeCalls.push(range),
          nearEndThreshold: 5,
        }),
      );

      // loadedCount=3, threshold=5 → any visible range hits near-end.
      // onNearEnd should fire; onVisibleRangeChange should NOT.
      lifecycle.init(3);

      expect(nearEndCalls).toBeGreaterThan(0);
      expect(visibleRangeCalls).toEqual([]);
    });

    it("still fires onVisibleRangeChange for non-near-end scrolls", () => {
      const visibleRangeCalls: Array<{ start: number; end: number }> = [];
      let nearEndCalls = 0;
      const lifecycle = createInfiniteScrollLifecycle(
        makeDeps({
          onNearEnd: () => nearEndCalls++,
          onVisibleRangeChange: (range) => visibleRangeCalls.push(range),
          nearEndThreshold: 2,
        }),
      );

      // 1000 items, threshold=2 → initial top-of-list render is nowhere
      // near the end, so onVisibleRangeChange fires normally and onNearEnd
      // does not.
      lifecycle.init(1000);

      expect(nearEndCalls).toBe(0);
      expect(visibleRangeCalls.length).toBeGreaterThan(0);
    });

    it("fires onVisibleRangeChange in compressed mode even at high indices", () => {
      // Compressed mode suppresses near-end detection (mapped indices are
      // not progress through loaded data), so onVisibleRangeChange must
      // still run — it is the only ensureRange trigger in that mode.
      //
      // jsdom elements have clientHeight=0, so we need to mock it to get a
      // non-empty visible range (compressed mode has no overscan buffer).
      const desc = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "clientHeight",
      );
      Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        get() {
          return 800;
        },
        configurable: true,
      });

      const visibleRangeCalls: Array<{ start: number; end: number }> = [];
      let nearEndCalls = 0;
      const hugeTotal = 200_000;
      const lifecycle = createInfiniteScrollLifecycle(
        makeDeps({
          itemHeight: 68,
          onNearEnd: () => nearEndCalls++,
          onVisibleRangeChange: (range) => visibleRangeCalls.push(range),
          nearEndThreshold: 50,
        }),
      );

      lifecycle.init(hugeTotal, 500);

      expect(nearEndCalls).toBe(0);
      expect(visibleRangeCalls.length).toBeGreaterThan(0);

      if (desc) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", desc);
      }
    });

    it("does not fire onNearEnd when loadedCount is large despite small totalCount", () => {
      let called = 0;
      const lifecycle = createInfiniteScrollLifecycle(
        makeDeps({
          onNearEnd: () => called++,
          nearEndThreshold: 2,
        }),
      );

      // Init with large count — range.end is small, no near-end
      lifecycle.init(1000);
      expect(called).toBe(0);

      // Shrink totalCount but preserve loadedCount (omit second arg)
      // currentLoadedCount stays at 1000, so near-end won't fire
      lifecycle.update(3);
      expect(called).toBe(0);
    });
  });
});
