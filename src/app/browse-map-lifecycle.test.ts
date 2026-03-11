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

describe("BrowseMapLifecycle", () => {
  afterEach(() => {
    document.body.textContent = "";
  });

  describe("update", () => {
    it("creates map container inside provided element", async () => {
      const deps = makeDeps();
      const lifecycle = createBrowseMapLifecycle(deps);

      lifecycle.update({ lat: 51, lon: 0 }, []);
      await Promise.resolve();

      expect(deps.container.querySelector(".browse-map")).toBeTruthy();
    });

    it("calls handle.update when map DOM still exists", async () => {
      const deps = makeDeps();
      const lifecycle = createBrowseMapLifecycle(deps);

      lifecycle.update({ lat: 51, lon: 0 }, []);
      await Promise.resolve();

      // Second update should reuse existing handle
      lifecycle.update({ lat: 52, lon: 1 }, []);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(deps.lastHandle.update).toHaveBeenCalledWith(
        { lat: 52, lon: 1 },
        [],
      );
    });

    it("recreates map when container was cleared between updates", async () => {
      const deps = makeDeps();
      const lifecycle = createBrowseMapLifecycle(deps);

      lifecycle.update({ lat: 51, lon: 0 }, []);
      await Promise.resolve();

      // Simulate detail view clearing the container
      deps.container.textContent = "";

      lifecycle.update({ lat: 52, lon: 1 }, []);
      await Promise.resolve();

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
  });

  describe("resize", () => {
    it("calls handle.resize when map exists", async () => {
      const deps = makeDeps();
      const lifecycle = createBrowseMapLifecycle(deps);

      lifecycle.update({ lat: 51, lon: 0 }, []);
      await Promise.resolve();

      lifecycle.resize();

      // eslint-disable-next-line @typescript-eslint/unbound-method
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
      await Promise.resolve();

      lifecycle.destroy();

      expect(deps.container.querySelector(".browse-map")).toBeNull();
      // eslint-disable-next-line @typescript-eslint/unbound-method
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
      await Promise.resolve();

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
      await Promise.resolve();

      // 4th arg is onSelectArticle

      const onSelect = (createBrowseMap.mock.calls[0] as any[])?.[3];
      expect(onSelect).toBe(onSelectArticle);
    });
  });
});
