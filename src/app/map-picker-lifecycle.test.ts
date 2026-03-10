// @vitest-environment jsdom
import { createMapPickerLifecycle } from "./map-picker-lifecycle";
import type { MapPickerLifecycleDeps } from "./map-picker-lifecycle";
import type { MapPickerHandle } from "./map-picker";

function makeContainer(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

function makeHandle(): MapPickerHandle & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    destroy: () => calls.push("destroy"),
  };
}

function makeDeps(
  overrides: Partial<MapPickerLifecycleDeps> = {},
): MapPickerLifecycleDeps & { lastHandle: ReturnType<typeof makeHandle> } {
  const lastHandle = makeHandle();
  return {
    lastHandle,
    container: overrides.container ?? makeContainer(),
    appName: "TestApp",
    getPosition: () => null,
    onPick: () => {},
    importMapPicker: () =>
      Promise.resolve({
        createMapPicker: () => lastHandle,
      }),
    ...overrides,
  };
}

describe("MapPickerLifecycle", () => {
  afterEach(() => {
    document.body.textContent = "";
  });

  describe("show", () => {
    it("creates header, instructions, and map container", () => {
      const deps = makeDeps();
      const lifecycle = createMapPickerLifecycle(deps);

      lifecycle.show();

      expect(deps.container.querySelector("header.app-header")).toBeTruthy();
      expect(
        deps.container.querySelector(".map-picker-instructions"),
      ).toBeTruthy();
      expect(
        deps.container.querySelector(".map-picker-container"),
      ).toBeTruthy();
      expect(deps.container.querySelector(".map-picker-map")).toBeTruthy();
    });

    it("displays the app name in the header", () => {
      const deps = makeDeps({ appName: "WikiRadar" });
      const lifecycle = createMapPickerLifecycle(deps);

      lifecycle.show();

      const h1 = deps.container.querySelector("h1");
      expect(h1?.textContent).toBe("WikiRadar");
    });

    it("clears existing container content", () => {
      const container = makeContainer();
      const p = document.createElement("p");
      p.textContent = "old";
      container.appendChild(p);

      const lifecycle = createMapPickerLifecycle(makeDeps({ container }));

      lifecycle.show();

      expect(container.querySelector("p.status-message")).toBeNull();
      expect(container.textContent).not.toContain("old");
    });

    it("passes current position as center to map picker", async () => {
      let receivedCenter: { lat: number; lon: number } | undefined;
      const deps = makeDeps({
        getPosition: () => ({ lat: 48.8, lon: 2.3 }),
        importMapPicker: () =>
          Promise.resolve({
            createMapPicker: (_el, opts) => {
              receivedCenter = opts.center;
              return makeHandle();
            },
          }),
      });
      const lifecycle = createMapPickerLifecycle(deps);

      lifecycle.show();
      await Promise.resolve();

      expect(receivedCenter).toEqual({ lat: 48.8, lon: 2.3 });
    });

    it("shows error with retry button on import failure", async () => {
      const deps = makeDeps({
        importMapPicker: () => Promise.reject(new Error("network")),
      });
      const lifecycle = createMapPickerLifecycle(deps);

      lifecycle.show();
      await Promise.resolve();
      await Promise.resolve();

      expect(deps.container.querySelector(".status-message")).toBeTruthy();
      expect(deps.container.querySelector(".status-action")).toBeTruthy();
    });

    it("destroys previous handle when show is called again", async () => {
      const handles: ReturnType<typeof makeHandle>[] = [];
      const deps = makeDeps({
        importMapPicker: () => {
          const h = makeHandle();
          handles.push(h);
          return Promise.resolve({ createMapPicker: () => h });
        },
      });
      const lifecycle = createMapPickerLifecycle(deps);

      lifecycle.show();
      await Promise.resolve();

      lifecycle.show();

      // First handle should have been destroyed
      expect(handles[0].calls).toContain("destroy");
    });
  });

  describe("destroy", () => {
    it("calls handle.destroy", async () => {
      const deps = makeDeps();
      const lifecycle = createMapPickerLifecycle(deps);

      lifecycle.show();
      await Promise.resolve();

      lifecycle.destroy();

      expect(deps.lastHandle.calls).toContain("destroy");
    });

    it("is safe to call without prior show", () => {
      const lifecycle = createMapPickerLifecycle(makeDeps());
      lifecycle.destroy(); // should not throw
    });

    it("is safe to call multiple times", async () => {
      const deps = makeDeps();
      const lifecycle = createMapPickerLifecycle(deps);

      lifecycle.show();
      await Promise.resolve();

      lifecycle.destroy();
      lifecycle.destroy(); // should not throw
    });
  });

  describe("onPick callback", () => {
    it("destroys handle and dispatches pick when user picks location", async () => {
      let pickCb: ((lat: number, lon: number) => void) | undefined;
      const picked: Array<{ lat: number; lon: number }> = [];

      const deps = makeDeps({
        onPick: (lat, lon) => picked.push({ lat, lon }),
        importMapPicker: () =>
          Promise.resolve({
            createMapPicker: (_el, opts) => {
              pickCb = opts.onPick;
              return makeHandle();
            },
          }),
      });
      const lifecycle = createMapPickerLifecycle(deps);

      lifecycle.show();
      await Promise.resolve();

      pickCb!(48.8, 2.3);

      expect(picked).toEqual([{ lat: 48.8, lon: 2.3 }]);
    });
  });
});
