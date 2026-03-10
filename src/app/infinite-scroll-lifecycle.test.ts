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
    isDesktop: () => false,
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

    it("initializes browse map on desktop", () => {
      const calls: string[] = [];
      const lifecycle = createInfiniteScrollLifecycle(
        makeDeps({
          isDesktop: () => true,
          initBrowseMap: () => calls.push("initBrowseMap"),
        }),
      );

      lifecycle.init(5);

      expect(calls).toContain("initBrowseMap");
    });

    it("does not initialize browse map on mobile", () => {
      const calls: string[] = [];
      const lifecycle = createInfiniteScrollLifecycle(
        makeDeps({
          isDesktop: () => false,
          initBrowseMap: () => calls.push("initBrowseMap"),
        }),
      );

      lifecycle.init(5);

      expect(calls).not.toContain("initBrowseMap");
    });

    it("creates virtual list with correct total count", () => {
      const container = makeContainer();
      const lifecycle = createInfiniteScrollLifecycle(makeDeps({ container }));

      lifecycle.init(20);

      const list = container.querySelector<HTMLElement>(
        ".nearby-list.virtual-scroll",
      );
      // Virtual scroll sets height = totalCount * itemHeight
      expect(list?.style.height).toBe(`${20 * 68}px`);
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
      const container = makeContainer();
      const lifecycle = createInfiniteScrollLifecycle(makeDeps({ container }));

      lifecycle.init(5);
      lifecycle.update(50);

      const list = container.querySelector<HTMLElement>(
        ".nearby-list.virtual-scroll",
      );
      expect(list?.style.height).toBe(`${50 * 68}px`);
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

  describe("re-init after destroy", () => {
    it("can init again after destroy", () => {
      const container = makeContainer();
      const lifecycle = createInfiniteScrollLifecycle(makeDeps({ container }));

      lifecycle.init(5);
      lifecycle.destroy();
      lifecycle.init(10);

      expect(lifecycle.isActive()).toBe(true);
      const list = container.querySelector<HTMLElement>(
        ".nearby-list.virtual-scroll",
      );
      expect(list?.style.height).toBe(`${10 * 68}px`);
    });
  });

  describe("enrichment wiring", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
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
});
