// @vitest-environment jsdom
import { createBootstrap } from "./bootstrap";
import type { BootstrapDeps } from "./bootstrap";
import { STARTED_STORAGE_KEY } from "./effect-executor";
import { idbOpen, idbCleanupOldKeys } from "./idb";
import { renderWelcome } from "./status";
import type { Lang } from "../lang";

// Stub out side-effectful modules so tests can focus on listener wiring.
vi.mock("./idb", () => ({
  idbOpen: vi.fn(() => Promise.resolve(null)),
  idbCleanupOldKeys: vi.fn(() => Promise.resolve(0)),
}));

vi.mock("./status", () => ({
  renderWelcome: vi.fn(),
}));

function makeDeps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
  const app = document.createElement("div");
  document.body.appendChild(app);
  return {
    dispatch: vi.fn(),
    app,
    getCurrentLang: vi.fn<() => Lang>(() => "en"),
    getLocationRestore: vi.fn(() => null),
    ...overrides,
  };
}

describe("createBootstrap", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    document.body.textContent = "";
  });

  describe("destroy", () => {
    it("removes the popstate listener so later popstate events do not dispatch back", () => {
      const dispatch = vi.fn();
      const deps = makeDeps({ dispatch });
      const bootstrap = createBootstrap(deps);
      bootstrap.run();
      dispatch.mockClear();

      bootstrap.destroy();

      window.dispatchEvent(new PopStateEvent("popstate"));

      expect(dispatch).not.toHaveBeenCalledWith({ type: "back" });
    });

    it("removes the serviceWorker controllerchange listener so later events do not dispatch swUpdateAvailable", () => {
      const listeners = new Set<EventListener>();
      const swContainer = {
        controller: {} as ServiceWorker,
        addEventListener: vi.fn((type: string, cb: EventListener) => {
          if (type === "controllerchange") listeners.add(cb);
        }),
        removeEventListener: vi.fn((type: string, cb: EventListener) => {
          if (type === "controllerchange") listeners.delete(cb);
        }),
      };
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: swContainer,
      });

      const dispatch = vi.fn();
      const deps = makeDeps({ dispatch });
      const bootstrap = createBootstrap(deps);
      bootstrap.run();
      dispatch.mockClear();

      bootstrap.destroy();

      // Fire any listeners that remain; there should be none.
      listeners.forEach((cb) => cb(new Event("controllerchange")));

      expect(dispatch).not.toHaveBeenCalledWith({ type: "swUpdateAvailable" });
      expect(swContainer.removeEventListener).toHaveBeenCalledWith(
        "controllerchange",
        expect.any(Function),
      );

      // Restore for other tests.
      delete (navigator as unknown as { serviceWorker?: unknown })
        .serviceWorker;
    });

    it("is safe to call more than once", () => {
      const deps = makeDeps();
      const bootstrap = createBootstrap(deps);
      bootstrap.run();

      bootstrap.destroy();
      expect(() => bootstrap.destroy()).not.toThrow();
    });

    it("is safe to call before run", () => {
      const deps = makeDeps();
      const bootstrap = createBootstrap(deps);

      expect(() => bootstrap.destroy()).not.toThrow();
    });
  });

  describe("run", () => {
    it("dispatches back when popstate fires with no state (navigating back to list)", () => {
      const dispatch = vi.fn();
      const deps = makeDeps({ dispatch });
      const bootstrap = createBootstrap(deps);

      bootstrap.run();
      window.dispatchEvent(new PopStateEvent("popstate"));

      expect(dispatch).toHaveBeenCalledWith({ type: "back" });
    });

    it("dispatches forwardToDetail when popstate fires with a detail state carrying a title", () => {
      const dispatch = vi.fn();
      const deps = makeDeps({ dispatch });
      const bootstrap = createBootstrap(deps);

      bootstrap.run();
      window.dispatchEvent(
        new PopStateEvent("popstate", {
          state: { view: "detail", title: "Eiffel Tower" },
        }),
      );

      expect(dispatch).toHaveBeenCalledWith({
        type: "forwardToDetail",
        title: "Eiffel Tower",
      });
      expect(dispatch).not.toHaveBeenCalledWith({ type: "back" });
    });

    it("dispatches back when popstate fires with a non-detail state (e.g. map picker)", () => {
      const dispatch = vi.fn();
      const deps = makeDeps({ dispatch });
      const bootstrap = createBootstrap(deps);

      bootstrap.run();
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: { view: "mapPicker" } }),
      );

      expect(dispatch).toHaveBeenCalledWith({ type: "back" });
    });

    it("dispatches a non-persisting langChanged with the current language at startup", () => {
      const dispatch = vi.fn();
      const getCurrentLang = vi.fn<() => Lang>(() => "sv");
      const deps = makeDeps({ dispatch, getCurrentLang });
      const bootstrap = createBootstrap(deps);

      bootstrap.run();

      // persist: false — the boot dispatch only kicks the data load. The active
      // language may have come from a shared permalink hash, and must not
      // overwrite the visitor's own saved language.
      expect(dispatch).toHaveBeenCalledWith({
        type: "langChanged",
        lang: "sv",
        persist: false,
      });
    });

    it("logs a warning when idbCleanupOldKeys rejects", async () => {
      const fakeDb = {} as IDBDatabase;
      vi.mocked(idbOpen).mockResolvedValueOnce(fakeDb);
      vi.mocked(idbCleanupOldKeys).mockRejectedValueOnce(new Error("boom"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const deps = makeDeps();
      const bootstrap = createBootstrap(deps);
      bootstrap.run();

      // Let the idbOpen microtask chain settle so the rejection is observed.
      await Promise.resolve();
      await Promise.resolve();

      expect(warn).toHaveBeenCalledWith(
        "IDB cleanup failed",
        expect.any(Error),
      );

      warn.mockRestore();
    });

    it("dispatches start when a recent started-at timestamp is in localStorage", () => {
      localStorage.setItem(STARTED_STORAGE_KEY, String(Date.now()));
      const dispatch = vi.fn();
      const deps = makeDeps({ dispatch });
      const bootstrap = createBootstrap(deps);

      bootstrap.run();

      expect(dispatch).toHaveBeenCalledWith({
        type: "start",
        hasGeolocation: !!navigator.geolocation,
      });
    });

    it("wires the welcome onExplore callback to dispatch pickPosition", () => {
      vi.mocked(renderWelcome).mockClear();
      const dispatch = vi.fn();
      const deps = makeDeps({ dispatch });
      const bootstrap = createBootstrap(deps);

      bootstrap.run();

      const options = vi.mocked(renderWelcome).mock.calls.at(-1)?.[1];
      options?.onExplore({ lat: 1, lon: 2 });

      expect(dispatch).toHaveBeenCalledWith({
        type: "pickPosition",
        position: { lat: 1, lon: 2 },
      });
    });
  });

  describe("location restore (permalink)", () => {
    it("dispatches pickPosition with the restored position", () => {
      const dispatch = vi.fn();
      const deps = makeDeps({
        dispatch,
        getLocationRestore: () => ({
          position: { lat: 41.8902, lon: 12.4922 },
          lang: "sv",
        }),
        getCurrentLang: () => "sv",
      });
      const bootstrap = createBootstrap(deps);

      bootstrap.run();

      expect(dispatch).toHaveBeenCalledWith({
        type: "pickPosition",
        position: { lat: 41.8902, lon: 12.4922 },
      });
    });

    it("loads data for the hash language without persisting it", () => {
      const dispatch = vi.fn();
      const deps = makeDeps({
        dispatch,
        getLocationRestore: () => ({
          position: { lat: 41.8902, lon: 12.4922 },
          lang: "sv",
        }),
        getCurrentLang: () => "sv",
      });
      const bootstrap = createBootstrap(deps);

      bootstrap.run();

      // persist: false keeps a shared link from overwriting the visitor's own
      // saved language. The non-persisting langChanged carries the data load.
      expect(dispatch).toHaveBeenCalledWith({
        type: "langChanged",
        lang: "sv",
        persist: false,
      });
    });

    it("skips the welcome screen and the auto-resume start when restoring", () => {
      vi.mocked(renderWelcome).mockClear();
      // A recent started-at would normally trigger auto-resume.
      localStorage.setItem(STARTED_STORAGE_KEY, String(Date.now()));
      const dispatch = vi.fn();
      const deps = makeDeps({
        dispatch,
        getLocationRestore: () => ({ position: { lat: 10, lon: 20 } }),
      });
      const bootstrap = createBootstrap(deps);

      bootstrap.run();

      expect(renderWelcome).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalledWith({
        type: "start",
        hasGeolocation: !!navigator.geolocation,
      });
    });

    it("falls through to the normal welcome flow when there is no hash to restore", () => {
      vi.mocked(renderWelcome).mockClear();
      const dispatch = vi.fn();
      const deps = makeDeps({ dispatch, getLocationRestore: () => null });
      const bootstrap = createBootstrap(deps);

      bootstrap.run();

      expect(renderWelcome).toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "pickPosition" }),
      );
    });
  });
});
