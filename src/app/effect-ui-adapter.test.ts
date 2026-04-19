// @vitest-environment jsdom
import { createEffectUIAdapter } from "./effect-ui-adapter";
import type { AppState } from "./state-machine";
import type { Renderer } from "./renderer";
import type { MapPickerLifecycle } from "./map-picker-lifecycle";
import type { BrowseMapLifecycle } from "./browse-map-lifecycle";
import type { NearbyArticle, UserPosition } from "./types";
import type { ArticleSummary } from "./wiki-api";

// Stub the sibling render modules so we can observe whether each
// effect-level UI callback routes to the matching concrete function
// without actually touching the DOM.
vi.mock("./detail", () => ({
  renderDetailLoading: vi.fn(),
  renderDetailReady: vi.fn(),
  renderDetailError: vi.fn(),
}));

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

function stubBrowseMap(): BrowseMapLifecycle {
  return {
    update: vi.fn(),
    highlight: vi.fn(),
    resize: vi.fn(),
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
      browseMap: stubBrowseMap(),
      getState: () => state,
      dispatch: vi.fn(),
      itemHeight: 68,
      getScrollContainer: () => container,
    });

    ui.renderDetailReady(article, summary);

    expect(renderDetailReady).toHaveBeenCalledTimes(1);
    const [receivedApp, receivedArticle, receivedSummary, , , origin] = (
      renderDetailReady as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(receivedApp).toBe(app);
    expect(receivedArticle).toBe(article);
    expect(receivedSummary).toBe(summary);
    expect(origin).toEqual(pos);
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
      browseMap: stubBrowseMap(),
      getState: () => state,
      dispatch: vi.fn(),
      itemHeight: 68,
      getScrollContainer: () => document.createElement("div"),
    });

    ui.renderDetailReady(article, summary);

    const [, , , , , origin] = (renderDetailReady as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(origin).toBeUndefined();
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
      browseMap: stubBrowseMap(),
      getState: () => state,
      dispatch: vi.fn(),
      itemHeight: 68,
      getScrollContainer: () => document.createElement("div"),
    });

    ui.renderDetailReady(article, summary);

    const [, , , , , origin] = (renderDetailReady as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(origin).toBeUndefined();
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
      browseMap: stubBrowseMap(),
      getState: () => state,
      dispatch: vi.fn(),
      itemHeight: 68,
      getScrollContainer: () => document.createElement("div"),
    });

    ui.renderDetailError(article, "boom", () => {}, "en");

    const [receivedApp, receivedArticle, receivedMsg, , , , lang, origin] = (
      renderDetailError as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(receivedApp).toBe(app);
    expect(receivedArticle).toBe(article);
    expect(receivedMsg).toBe("boom");
    expect(lang).toBe("en");
    expect(origin).toEqual(pos);
  });

  it("recenter callback from renderDetailReady pops history and dispatches pickPosition with the article coords", () => {
    const historyBackSpy = vi
      .spyOn(window.history, "back")
      .mockImplementation(() => {});
    const dispatch = vi.fn();
    const ui = createEffectUIAdapter({
      app: document.createElement("div"),
      renderer: stubRenderer(),
      mapPicker: stubMapPicker(),
      browseMap: stubBrowseMap(),
      getState: () => makeState({ position: pos, positionSource: "gps" }),
      dispatch,
      itemHeight: 68,
      getScrollContainer: () => document.createElement("div"),
    });

    ui.renderDetailReady(article, summary);
    const [, , , , onRecenter] = (renderDetailReady as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    (onRecenter as () => void)();

    expect(historyBackSpy).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: "pickPosition",
      position: { lat: article.lat, lon: article.lon },
    });
    historyBackSpy.mockRestore();
  });

  it("recenter callback from renderDetailError pops history and dispatches pickPosition with the article coords", () => {
    const historyBackSpy = vi
      .spyOn(window.history, "back")
      .mockImplementation(() => {});
    const dispatch = vi.fn();
    const ui = createEffectUIAdapter({
      app: document.createElement("div"),
      renderer: stubRenderer(),
      mapPicker: stubMapPicker(),
      browseMap: stubBrowseMap(),
      getState: () => makeState({ position: pos, positionSource: "gps" }),
      dispatch,
      itemHeight: 68,
      getScrollContainer: () => document.createElement("div"),
    });

    ui.renderDetailError(article, "boom", () => {}, "en");
    const [, , , , , onRecenter] = (
      renderDetailError as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    (onRecenter as () => void)();

    expect(historyBackSpy).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: "pickPosition",
      position: { lat: article.lat, lon: article.lon },
    });
    historyBackSpy.mockRestore();
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
      browseMap: stubBrowseMap(),
      getState: () => makeState(),
      dispatch: vi.fn(),
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
      browseMap: stubBrowseMap(),
      getState: () => makeState(),
      dispatch: vi.fn(),
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
      browseMap: stubBrowseMap(),
      getState: () => makeState(),
      dispatch: vi.fn(),
      itemHeight: 68,
      getScrollContainer: () => container,
    });

    ui.restoreScrollTop(10);

    expect(container.scrollTop).toBe(680);
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
      browseMap: stubBrowseMap(),
      getState: () => makeState(),
      dispatch: vi.fn(),
      itemHeight: 68,
      getScrollContainer: () => document.createElement("div"),
    });

    ui.renderDetailLoading(article);
    const [, , goBackFn] = (renderDetailLoading as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    (goBackFn as () => void)();

    expect(historyBackSpy).toHaveBeenCalledTimes(1);
    historyBackSpy.mockRestore();
  });
});
