// @vitest-environment jsdom
import { createEffectUIAdapter } from "./effect-ui-adapter";
import type { AppState } from "./state-machine";
import type { Renderer } from "./renderer";
import type { MapPickerLifecycle } from "./map-picker-lifecycle";
import type { NearbyArticle, UserPosition } from "./types";
import type { ArticleSummary } from "./wiki-api";

// Stub the sibling render modules so we can observe whether each
// effect-level UI callback routes to the matching concrete function
// without actually touching the DOM.
vi.mock("./render", () => ({
  updateNearbyDistances: vi.fn(),
}));
vi.mock("./about", () => ({
  showAbout: vi.fn(),
  hideAbout: vi.fn(),
}));
vi.mock("./detail", () => ({
  renderDetailLoading: vi.fn(),
  renderDetailReady: vi.fn(),
  renderDetailError: vi.fn(),
}));

import { updateNearbyDistances } from "./render";
import { showAbout, hideAbout } from "./about";
import {
  renderDetailLoading,
  renderDetailReady,
  renderDetailError,
} from "./detail";

const pos: UserPosition = { lat: 59.33, lon: 18.07 };
const article: NearbyArticle = {
  title: "Stockholm",
  lat: 59.33,
  lon: 18.07,
  distanceM: 42,
};
const summary = {
  title: "Stockholm",
  extract: "…",
  description: "Capital of Sweden",
  thumbnailUrl: null,
  thumbnailWidth: null,
  thumbnailHeight: null,
  pageUrl: "https://en.wikipedia.org/wiki/Stockholm",
} satisfies ArticleSummary;

function stubRenderer(): Renderer {
  return {
    renderPhase: vi.fn(),
    renderBrowsingList: vi.fn(),
    renderBrowsingHeader: vi.fn(),
    renderAppUpdateBanner: vi.fn(),
    resetDrawerForMapPicker: vi.fn(),
  };
}

function stubMapPicker(): MapPickerLifecycle {
  return {
    show: vi.fn(),
    destroy: vi.fn(),
  };
}

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    phase: { phase: "welcome" },
    query: { mode: "none" },
    position: null,
    positionSource: null,
    currentLang: "en",
    loadGeneration: 0,
    loadingTiles: new Set(),
    downloadProgress: -1,
    updateBanner: null,
    hasGeolocation: true,
    gpsSignalLost: false,
    viewportFillCount: 15,
    aboutOpen: false,
    ...overrides,
  };
}

describe("createEffectUIAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renderDetailReady forwards picked position as origin when source is picked", () => {
    const assertSpy = vi.spyOn(console, "assert");
    const app = document.createElement("div");
    const container = document.createElement("div");
    const renderer = stubRenderer();
    const mapPicker = stubMapPicker();
    const state = makeState({ position: pos, positionSource: "picked" });

    const ui = createEffectUIAdapter({
      app,
      renderer,
      mapPicker,
      getState: () => state,
      itemHeight: 68,
      getScrollContainer: () => container,
    });

    ui.renderDetailReady(article, summary);

    expect(renderDetailReady).toHaveBeenCalledTimes(1);
    const call = (renderDetailReady as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(app);
    expect(call[1]).toBe(article);
    expect(call[2]).toBe(summary);
    // call[3] is goBack (function); call[4] is origin
    expect(call[4]).toEqual(pos);
    expect(assertSpy).toHaveBeenCalledWith(true, expect.any(String));
    assertSpy.mockRestore();
  });

  it("renderDetailReady passes undefined origin when position source is gps", () => {
    const assertSpy = vi.spyOn(console, "assert");
    const app = document.createElement("div");
    const renderer = stubRenderer();
    const state = makeState({ position: pos, positionSource: "gps" });

    const ui = createEffectUIAdapter({
      app,
      renderer,
      mapPicker: stubMapPicker(),
      getState: () => state,
      itemHeight: 68,
      getScrollContainer: () => document.createElement("div"),
    });

    ui.renderDetailReady(article, summary);

    const call = (renderDetailReady as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[4]).toBeUndefined();
    expect(assertSpy).toHaveBeenCalledWith(true, expect.any(String));
    assertSpy.mockRestore();
  });

  it("renderDetailReady passes undefined origin when source is picked but position is null", () => {
    const assertSpy = vi.spyOn(console, "assert");
    const app = document.createElement("div");
    const state = makeState({ position: null, positionSource: "picked" });

    const ui = createEffectUIAdapter({
      app,
      renderer: stubRenderer(),
      mapPicker: stubMapPicker(),
      getState: () => state,
      itemHeight: 68,
      getScrollContainer: () => document.createElement("div"),
    });

    ui.renderDetailReady(article, summary);

    const call = (renderDetailReady as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[4]).toBeUndefined();
    expect(assertSpy).toHaveBeenCalledWith(
      false,
      expect.stringContaining("state-machine invariant violation"),
    );
    assertSpy.mockRestore();
  });

  it("renderDetailError reuses the picked-origin resolution", () => {
    const app = document.createElement("div");
    const state = makeState({ position: pos, positionSource: "picked" });
    const ui = createEffectUIAdapter({
      app,
      renderer: stubRenderer(),
      mapPicker: stubMapPicker(),
      getState: () => state,
      itemHeight: 68,
      getScrollContainer: () => document.createElement("div"),
    });

    ui.renderDetailError(article, "boom", () => {}, "en");

    const call = (renderDetailError as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(app);
    expect(call[1]).toBe(article);
    expect(call[2]).toBe("boom");
    // call[3]=goBack, call[4]=retry, call[5]=lang, call[6]=origin
    expect(call[5]).toBe("en");
    expect(call[6]).toEqual(pos);
  });

  it("showMapPicker resets the drawer before calling mapPicker.show", () => {
    const renderer = stubRenderer();
    const mapPicker = stubMapPicker();
    const callOrder: string[] = [];
    (
      renderer.resetDrawerForMapPicker as ReturnType<typeof vi.fn>
    ).mockImplementation(() => {
      callOrder.push("reset");
    });
    (mapPicker.show as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push("show");
    });

    const ui = createEffectUIAdapter({
      app: document.createElement("div"),
      renderer,
      mapPicker,
      getState: () => makeState(),
      itemHeight: 68,
      getScrollContainer: () => document.createElement("div"),
    });

    ui.showMapPicker();

    expect(callOrder).toEqual(["reset", "show"]);
  });

  it("scrollToTop scrolls the resolved container to origin", () => {
    const container = document.createElement("div");
    container.scrollTo = vi.fn();
    const ui = createEffectUIAdapter({
      app: document.createElement("div"),
      renderer: stubRenderer(),
      mapPicker: stubMapPicker(),
      getState: () => makeState(),
      itemHeight: 68,
      getScrollContainer: () => container,
    });

    ui.scrollToTop();

    expect(container.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("restoreScrollTop multiplies firstVisibleIndex by itemHeight", () => {
    const container = document.createElement("div");
    const ui = createEffectUIAdapter({
      app: document.createElement("div"),
      renderer: stubRenderer(),
      mapPicker: stubMapPicker(),
      getState: () => makeState(),
      itemHeight: 68,
      getScrollContainer: () => container,
    });

    ui.restoreScrollTop(10);

    expect(container.scrollTop).toBe(680);
  });

  it("updateDistances forwards to renderer's updateNearbyDistances", () => {
    const app = document.createElement("div");
    const articles = [article];
    const ui = createEffectUIAdapter({
      app,
      renderer: stubRenderer(),
      mapPicker: stubMapPicker(),
      getState: () => makeState(),
      itemHeight: 68,
      getScrollContainer: () => document.createElement("div"),
    });

    ui.updateDistances(articles);

    expect(updateNearbyDistances).toHaveBeenCalledWith(app, articles);
  });

  it("render/renderBrowsingList/renderBrowsingHeader/renderAppUpdateBanner dispatch to renderer", () => {
    const renderer = stubRenderer();
    const ui = createEffectUIAdapter({
      app: document.createElement("div"),
      renderer,
      mapPicker: stubMapPicker(),
      getState: () => makeState(),
      itemHeight: 68,
      getScrollContainer: () => document.createElement("div"),
    });

    ui.render();
    ui.renderBrowsingList();
    ui.renderBrowsingHeader();
    ui.renderAppUpdateBanner();

    expect(renderer.renderPhase).toHaveBeenCalledTimes(1);
    expect(renderer.renderBrowsingList).toHaveBeenCalledTimes(1);
    expect(renderer.renderBrowsingHeader).toHaveBeenCalledTimes(1);
    expect(renderer.renderAppUpdateBanner).toHaveBeenCalledTimes(1);
  });

  it("showAbout and hideAbout re-export the about module functions", () => {
    const ui = createEffectUIAdapter({
      app: document.createElement("div"),
      renderer: stubRenderer(),
      mapPicker: stubMapPicker(),
      getState: () => makeState(),
      itemHeight: 68,
      getScrollContainer: () => document.createElement("div"),
    });

    const onClose = (): void => {};
    ui.showAbout(onClose);
    ui.hideAbout();

    expect(showAbout).toHaveBeenCalledWith(onClose);
    expect(hideAbout).toHaveBeenCalled();
  });

  it("renderDetailLoading forwards app and article to detail module", () => {
    const app = document.createElement("div");
    const ui = createEffectUIAdapter({
      app,
      renderer: stubRenderer(),
      mapPicker: stubMapPicker(),
      getState: () => makeState(),
      itemHeight: 68,
      getScrollContainer: () => document.createElement("div"),
    });

    ui.renderDetailLoading(article);

    const call = (renderDetailLoading as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[0]).toBe(app);
    expect(call[1]).toBe(article);
    expect(typeof call[2]).toBe("function");
  });

  it("goBack callback invokes history.back exactly once", () => {
    const app = document.createElement("div");
    const historyBackSpy = vi
      .spyOn(window.history, "back")
      .mockImplementation(() => {});
    const ui = createEffectUIAdapter({
      app,
      renderer: stubRenderer(),
      mapPicker: stubMapPicker(),
      getState: () => makeState(),
      itemHeight: 68,
      getScrollContainer: () => document.createElement("div"),
    });

    ui.renderDetailLoading(article);
    const goBack = (renderDetailLoading as ReturnType<typeof vi.fn>).mock
      .calls[0][2] as () => void;
    goBack();

    expect(historyBackSpy).toHaveBeenCalledTimes(1);
    historyBackSpy.mockRestore();
  });
});
