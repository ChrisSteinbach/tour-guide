// Bootstrap — extracted from main.ts.
// Owns the app's startup sequence and window-level event listeners.
// Must run after all other modules are wired, because the effects
// it dispatches reach into the renderer, effect executor, etc.

import { idbOpen, idbCleanupOldKeys } from "./idb";
import { renderWelcome } from "./status";
import { STARTED_STORAGE_KEY, STARTED_TTL_MS } from "./effect-executor";
import type { Event } from "./state-machine";
import type { Lang } from "../lang";

export interface BootstrapDeps {
  dispatch: (event: Event) => void;
  app: HTMLElement;
  getCurrentLang: () => Lang;
}

export interface Bootstrap {
  run(): void;
  /** Remove window-level listeners attached by run(). Safe to call more than once. */
  destroy(): void;
}

export function createBootstrap(deps: BootstrapDeps): Bootstrap {
  const onPopState = (): void => {
    deps.dispatch({ type: "back" });
  };

  const onControllerChange = (): void => {
    deps.dispatch({ type: "swUpdateAvailable" });
  };

  let swTarget: ServiceWorkerContainer | null = null;

  function listenForSwUpdate(): void {
    if (!("serviceWorker" in navigator)) return;
    // Only attach the listener when a service worker is already controlling
    // this page. On the very first page load (before any SW has claimed
    // clients) navigator.serviceWorker.controller is null and we intentionally
    // skip attachment — there is no in-flight update to react to, and the
    // next navigation will hit this path with a controller present. This
    // looks like a bug at a glance, but is the intended semantics.
    const initialController = navigator.serviceWorker.controller;
    if (!initialController) return;
    swTarget = navigator.serviceWorker;
    swTarget.addEventListener("controllerchange", onControllerChange);
  }

  function run(): void {
    window.addEventListener("popstate", onPopState);

    void idbOpen().then((db) => {
      if (!db) return;
      idbCleanupOldKeys(db).catch((err: unknown) => {
        console.warn("IDB cleanup failed", err);
      });
    });

    listenForSwUpdate();
    deps.dispatch({ type: "langChanged", lang: deps.getCurrentLang() });

    const startedAt = Number(localStorage.getItem(STARTED_STORAGE_KEY));
    if (startedAt && Date.now() - startedAt < STARTED_TTL_MS) {
      deps.dispatch({
        type: "start",
        hasGeolocation: !!navigator.geolocation,
      });
    } else {
      renderWelcome(deps.app, {
        onStart: () =>
          deps.dispatch({
            type: "start",
            hasGeolocation: !!navigator.geolocation,
          }),
        onPickLocation: () => deps.dispatch({ type: "showMapPicker" }),
        currentLang: deps.getCurrentLang(),
        onLangChange: (lang) => deps.dispatch({ type: "langChanged", lang }),
        onShowAbout: () => deps.dispatch({ type: "showAbout" }),
      });
    }
  }

  function destroy(): void {
    window.removeEventListener("popstate", onPopState);
    if (swTarget) {
      swTarget.removeEventListener("controllerchange", onControllerChange);
      swTarget = null;
    }
  }

  return { run, destroy };
}
