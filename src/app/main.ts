import "./style.css";
import {
  transition,
  DEFAULT_VIEWPORT_FILL,
  type AppState,
  type Event,
} from "./state-machine";
import { composeApp } from "./compose-app";
import { getStoredLang } from "./stored-lang";

const app =
  document.getElementById("app") ??
  (() => {
    throw new Error("Missing #app element in document");
  })();

// ── Constants ────────────────────────────────────────────────

/** Item height for virtual scroll (px). Matches .nearby-item (64px) + gap (4px). */
const VIRTUAL_ITEM_HEIGHT = 68;

/** Scroll-pause detection threshold (px) — two items high. */
const SCROLL_PAUSE_THRESHOLD = VIRTUAL_ITEM_HEIGHT * 2;

/** Compute how many articles fill the viewport, plus a few extra for scroll trigger. */
const viewportFillCount = Math.max(
  DEFAULT_VIEWPORT_FILL,
  Math.ceil(window.innerHeight / VIRTUAL_ITEM_HEIGHT) + 3,
);

// ── State ────────────────────────────────────────────────────

let appState: AppState = {
  phase: { phase: "welcome" },
  query: { mode: "none" },
  position: null,
  positionSource: null,
  currentLang: getStoredLang(),
  loadGeneration: 0,
  loadingTiles: new Set(),
  downloadProgress: -1,
  updateBanner: null,
  hasGeolocation: true,
  gpsSignalLost: false,
  viewportFillCount,
  aboutOpen: false,
};

// ── Dispatch ─────────────────────────────────────────────────

function dispatch(event: Event): void {
  const { next, effects } = transition(appState, event);
  appState = next;
  for (const effect of effects) {
    executeEffect(effect);
  }
}

// ── Compose ──────────────────────────────────────────────────

const { executeEffect, bootstrap, destroy } = composeApp({
  app,
  getState: () => appState,
  dispatch,
  itemHeight: VIRTUAL_ITEM_HEIGHT,
  scrollPauseThreshold: SCROLL_PAUSE_THRESHOLD,
});

bootstrap.run();

// Release window-level listeners owned by the composed app on HMR
// dispose. Without this, editing any file imported by main.ts would
// leak a new set of listeners on every reload.
if (import.meta.hot) {
  import.meta.hot.dispose(destroy);
}
