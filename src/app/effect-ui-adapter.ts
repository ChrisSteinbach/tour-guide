// Effect UI adapter — extracted from main.ts.
// Translates the effect executor's `ui` callbacks (state-machine
// effect names) into concrete renderer / mapPicker / detail calls.
// All I/O boundaries are injected via EffectUIAdapterDeps.

import { updateNearbyDistances } from "./render";
import { hideAbout, showAbout } from "./about";
import {
  renderDetailLoading,
  renderDetailReady,
  renderDetailError,
} from "./detail";
import type { AppState } from "./state-machine";
import type { RenderDeps } from "./effect-executor";
import type { Renderer } from "./renderer";
import type { MapPickerLifecycle } from "./map-picker-lifecycle";

export interface EffectUIAdapterDeps {
  app: HTMLElement;
  renderer: Renderer;
  mapPicker: MapPickerLifecycle;
  getState: () => AppState;
  itemHeight: number;
  getScrollContainer: () => HTMLElement;
}

// goBack captures nothing from EffectUIAdapterDeps, so it lives at
// module scope and is shared across all adapters instead of being
// recreated per factory call.
const goBack = (): void => {
  history.back();
};

export function createEffectUIAdapter(deps: EffectUIAdapterDeps): RenderDeps {
  // Detail views show the picked-spot marker only when the position
  // is user-picked; GPS positions render without an origin pin.
  //
  // Invariant: call pickedOrigin() at most once per adapter handler.
  // Each call re-reads state via deps.getState(), and calling it twice
  // within the same effect-handler pass would risk observing an
  // inconsistent snapshot if a future dispatch-loop interleaving
  // mutates state between calls. Cache the result locally if a handler
  // needs the value more than once.
  const pickedOrigin = (): { lat: number; lon: number } | undefined => {
    const state = deps.getState();
    return state.positionSource === "picked" && state.position
      ? state.position
      : undefined;
  };

  return {
    render: () => deps.renderer.renderPhase(),
    renderBrowsingList: () => deps.renderer.renderBrowsingList(),
    renderBrowsingHeader: () => deps.renderer.renderBrowsingHeader(),
    updateDistances: (articles) => updateNearbyDistances(deps.app, articles),
    showAbout,
    hideAbout,
    renderDetailLoading: (article) =>
      renderDetailLoading(deps.app, article, goBack),
    renderDetailReady: (article, summary) => {
      renderDetailReady(deps.app, article, summary, goBack, pickedOrigin());
    },
    renderDetailError: (article, msg, retry, lang) => {
      renderDetailError(
        deps.app,
        article,
        msg,
        goBack,
        retry,
        lang,
        pickedOrigin(),
      );
    },
    renderAppUpdateBanner: () => deps.renderer.renderAppUpdateBanner(),
    showMapPicker: () => {
      // resetDrawerForMapPicker() destroys the prior mapPicker/browseMap;
      // mapPicker.show() re-initializes it. The destroy-then-show sequence
      // is intentional — see Renderer.resetDrawerForMapPicker.
      deps.renderer.resetDrawerForMapPicker();
      deps.mapPicker.show();
    },
    scrollToTop: () => {
      deps.getScrollContainer().scrollTo(0, 0);
    },
    restoreScrollTop: (firstVisibleIndex) => {
      deps.getScrollContainer().scrollTop = firstVisibleIndex * deps.itemHeight;
    },
  };
}
