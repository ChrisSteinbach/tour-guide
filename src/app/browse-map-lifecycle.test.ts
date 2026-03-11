// @vitest-environment jsdom
import { createBrowseMapLifecycle } from "./browse-map-lifecycle";
import type { BrowseMapLifecycleDeps } from "./browse-map-lifecycle";
import type { BrowseMapHandle } from "./browse-map";

function makeContainer(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

function makeHandle(): BrowseMapHandle & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    update: (...args) => calls.push(`update:${JSON.stringify(args)}`),
    resize: () => calls.push("resize"),
    destroy: () => calls.push("destroy"),
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

      expect(deps.lastHandle.calls).toContain(
        `update:${JSON.stringify([{ lat: 52, lon: 1 }, []])}`,
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

      expect(deps.lastHandle.calls).toContain("resize");
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
      expect(deps.lastHandle.calls).toContain("destroy");
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
});
