// @vitest-environment jsdom
import { createBrowseMapLifecycle } from "./browse-map-lifecycle";
import type { BrowseMapLifecycleDeps } from "./browse-map-lifecycle";
import type { BrowseMapHandle } from "./browse-map";

function makeContainer(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

function makeHandle(): BrowseMapHandle {
  return {
    update: vi.fn(),
    highlight: vi.fn(),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
}

function makeDeps(
  overrides: Partial<BrowseMapLifecycleDeps> = {},
): BrowseMapLifecycleDeps & { lastHandle: ReturnType<typeof makeHandle> } {
  const lastHandle = makeHandle();
  return {
    lastHandle,
    container: overrides.container ?? makeContainer(),
    onSelectArticle: () => {},
    importBrowseMap: () =>
      Promise.resolve({
        createBrowseMap: () => lastHandle,
      }),
    ...overrides,
  };
}

/** Flush the import promise (microtask) + deferred rAF (jsdom uses ~16ms setTimeout). */
async function flushImportAndRaf(): Promise<void> {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(20);
}

describe("BrowseMapLifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.textContent = "";
  });

  describe("update", () => {
    it("creates map container inside provided element", async () => {
      const deps = makeDeps();
      const lifecycle = createBrowseMapLifecycle(deps);

      lifecycle.update({ lat: 51, lon: 0 }, []);
      await flushImportAndRaf();

      expect(deps.container.querySelector(".browse-map")).toBeTruthy();
    });

    it("calls handle.update when map DOM still exists", async () => {
      const deps = makeDeps();
      const lifecycle = createBrowseMapLifecycle(deps);

      lifecycle.update({ lat: 51, lon: 0 }, []);
      await flushImportAndRaf();

      // Second update should reuse existing handle
      lifecycle.update({ lat: 52, lon: 1 }, []);

      expect(deps.lastHandle.update).toHaveBeenCalledWith(
        { lat: 52, lon: 1 },
        [],
      );
    });

    it("recreates map when container was cleared between updates", async () => {
      const deps = makeDeps();
      const lifecycle = createBrowseMapLifecycle(deps);

      lifecycle.update({ lat: 51, lon: 0 }, []);
      await flushImportAndRaf();

      // Simulate detail view clearing the container
      deps.container.textContent = "";

      lifecycle.update({ lat: 52, lon: 1 }, []);
      await flushImportAndRaf();

      // Should have created a new map container
      expect(deps.container.querySelector(".browse-map")).toBeTruthy();
    });

    it("removes map element on import failure", async () => {
      const deps = makeDeps({
        importBrowseMap: () => Promise.reject(new Error("network")),
      });
      const lifecycle = createBrowseMapLifecycle(deps);

      lifecycle.update({ lat: 51, lon: 0 }, []);
      // Wait for rejection microtask
      await Promise.resolve();
      await Promise.resolve();

      expect(deps.container.querySelector(".browse-map")).toBeNull();
    });

    it("two rapid updates only create one map with the latest position", async () => {
      const createBrowseMap = vi.fn(() => makeHandle());
      const deps = makeDeps({
        importBrowseMap: () => Promise.resolve({ createBrowseMap }),
      });
      const lifecycle = createBrowseMapLifecycle(deps);

      const firstArticles = [{ title: "A" }] as any[];
      const secondArticles = [{ title: "B" }] as any[];
      lifecycle.update({ lat: 51, lon: 0 }, firstArticles);
      lifecycle.update({ lat: 52, lon: 1 }, secondArticles);
      await flushImportAndRaf();

      expect(createBrowseMap).toHaveBeenCalledTimes(1);
      expect(createBrowseMap).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        { lat: 52, lon: 1 },
        secondArticles,
        expect.any(Function),
      );
    });
  });

  describe("highlight", () => {
    it("calls handle.highlight when map exists", async () => {
      const deps = makeDeps();
      const lifecycle = createBrowseMapLifecycle(deps);

      lifecycle.update({ lat: 51, lon: 0 }, []);
      await flushImportAndRaf();

      lifecycle.highlight("Some Article");

      expect(deps.lastHandle.highlight).toHaveBeenCalledWith("Some Article");
    });

    it("is safe to call without a map", () => {
      const lifecycle = createBrowseMapLifecycle(makeDeps());
      lifecycle.highlight("Some Article"); // should not throw
    });

    it("applies pending highlight after map initializes", async () => {
      const deps = makeDeps();
      const lifecycle = createBrowseMapLifecycle(deps);

      lifecycle.update({ lat: 51, lon: 0 }, []);
      lifecycle.highlight("Deferred Article");
      await flushImportAndRaf();

      expect(deps.lastHandle.highlight).toHaveBeenCalledWith(
        "Deferred Article",
      );
    });

    it("highlight(null) before init clears pending highlight", async () => {
      const deps = makeDeps();
      const lifecycle = createBrowseMapLifecycle(deps);

      lifecycle.update({ lat: 51, lon: 0 }, []);
      lifecycle.highlight("Some Article");
      lifecycle.highlight(null);
      await flushImportAndRaf();

      expect(deps.lastHandle.highlight).toHaveBeenCalledWith(null);
    });
  });

  describe("resize", () => {
    it("calls handle.resize when map exists", async () => {
      const deps = makeDeps();
      const lifecycle = createBrowseMapLifecycle(deps);

      lifecycle.update({ lat: 51, lon: 0 }, []);
      await flushImportAndRaf();

      lifecycle.resize();

      expect(deps.lastHandle.resize).toHaveBeenCalled();
    });

    it("is safe to call without a map", () => {
      const lifecycle = createBrowseMapLifecycle(makeDeps());
      lifecycle.resize(); // should not throw
    });
  });

  describe("destroy", () => {
    it("removes map element and calls handle.destroy", async () => {
      const deps = makeDeps();
      const lifecycle = createBrowseMapLifecycle(deps);

      lifecycle.update({ lat: 51, lon: 0 }, []);
      await flushImportAndRaf();

      lifecycle.destroy();

      expect(deps.container.querySelector(".browse-map")).toBeNull();
      expect(deps.lastHandle.destroy).toHaveBeenCalled();
    });

    it("is safe to call without prior update", () => {
      const lifecycle = createBrowseMapLifecycle(makeDeps());
      lifecycle.destroy(); // should not throw
    });

    it("is safe to call multiple times", async () => {
      const deps = makeDeps();
      const lifecycle = createBrowseMapLifecycle(deps);

      lifecycle.update({ lat: 51, lon: 0 }, []);
      await flushImportAndRaf();

      lifecycle.destroy();
      lifecycle.destroy(); // should not throw
    });
  });

  describe("onSelectArticle passthrough", () => {
    it("passes onSelectArticle to createBrowseMap", async () => {
      const onSelectArticle = vi.fn();
      const createBrowseMap = vi.fn(() => makeHandle());
      const deps = makeDeps({
        onSelectArticle,
        importBrowseMap: () => Promise.resolve({ createBrowseMap }),
      });
      const lifecycle = createBrowseMapLifecycle(deps);

      lifecycle.update({ lat: 51, lon: 0 }, []);
      await flushImportAndRaf();

      // 4th arg is onSelectArticle

      const onSelect = (createBrowseMap.mock.calls[0] as any[])?.[3];
      expect(onSelect).toBe(onSelectArticle);
    });
  });
});
