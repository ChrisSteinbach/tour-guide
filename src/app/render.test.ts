// @vitest-environment jsdom

import {
  renderNearbyHeader,
  renderNearbyList,
  updateNearbyDistances,
  enrichArticleItem,
} from "./render";
import type { NearbyArticle } from "./types";
import type { ArticleSummary } from "./wiki-api";

afterEach(() => {
  while (document.body.firstChild) {
    document.body.firstChild.remove();
  }
});

// ── renderNearbyHeader ───────────────────────────────────────

describe("renderNearbyHeader", () => {
  it("renders article count in subtitle", () => {
    const header = renderNearbyHeader({
      articleCount: 5,
      currentLang: "en",
      onLangChange: () => {},
      paused: false,
    });
    const subtitle = header.querySelector("p");
    expect(subtitle?.textContent).toBe("5 nearby attractions");
  });

  it("uses singular when count is 1", () => {
    const header = renderNearbyHeader({
      articleCount: 1,
      currentLang: "en",
      onLangChange: () => {},
      paused: false,
    });
    const subtitle = header.querySelector("p");
    expect(subtitle?.textContent).toBe("1 nearby attraction");
  });

  it("shows paused in subtitle when paused", () => {
    const header = renderNearbyHeader({
      articleCount: 3,
      currentLang: "en",
      onLangChange: () => {},
      paused: true,
    });
    const subtitle = header.querySelector("p");
    expect(subtitle?.textContent).toContain("paused");
  });

  it("pause button label says Resume when manually paused", () => {
    const header = renderNearbyHeader({
      articleCount: 3,
      currentLang: "en",
      onLangChange: () => {},
      paused: true,
      pauseReason: "manual",
      onTogglePause: () => {},
    });
    const btn = header.querySelector(".pause-toggle");
    expect(btn?.getAttribute("aria-label")).toBe("Resume location updates");
    expect(btn?.getAttribute("title")).toBe("Resume location updates");
  });

  it("pause button label says paused by scroll when scroll-paused", () => {
    const header = renderNearbyHeader({
      articleCount: 3,
      currentLang: "en",
      onLangChange: () => {},
      paused: true,
      pauseReason: "scroll",
      onTogglePause: () => {},
    });
    const btn = header.querySelector(".pause-toggle");
    expect(btn?.getAttribute("aria-label")).toBe(
      "Resume updates (paused by scroll)",
    );
    expect(btn?.getAttribute("title")).toBe(
      "Resume updates (paused by scroll)",
    );
  });

  it("adds blink class when scroll-paused", () => {
    const header = renderNearbyHeader({
      articleCount: 3,
      currentLang: "en",
      onLangChange: () => {},
      paused: true,
      pauseReason: "scroll",
      onTogglePause: () => {},
    });
    const btn = header.querySelector(".pause-toggle");
    expect(btn?.classList.contains("scroll-pause-blink")).toBe(true);
  });

  it("does not add blink class when manually paused", () => {
    const header = renderNearbyHeader({
      articleCount: 3,
      currentLang: "en",
      onLangChange: () => {},
      paused: true,
      pauseReason: "manual",
      onTogglePause: () => {},
    });
    const btn = header.querySelector(".pause-toggle");
    expect(btn?.classList.contains("scroll-pause-blink")).toBe(false);
  });

  it("pause button label says Pause when unpaused", () => {
    const header = renderNearbyHeader({
      articleCount: 3,
      currentLang: "en",
      onLangChange: () => {},
      paused: false,
      onTogglePause: () => {},
    });
    const btn = header.querySelector(".pause-toggle");
    expect(btn?.getAttribute("aria-label")).toBe("Pause location updates");
    expect(btn?.getAttribute("title")).toBe("Pause location updates");
  });

  it("omits pause button when no onTogglePause callback", () => {
    const header = renderNearbyHeader({
      articleCount: 3,
      currentLang: "en",
      onLangChange: () => {},
      paused: false,
    });
    expect(header.querySelector(".pause-toggle")).toBeNull();
  });

  it("language selector reflects currentLang", () => {
    const header = renderNearbyHeader({
      articleCount: 3,
      currentLang: "sv",
      onLangChange: () => {},
      paused: false,
    });
    const select = header.querySelector(
      ".header-lang-select",
    ) as HTMLSelectElement;
    expect(select.value).toBe("sv");
  });

  it("calls onLangChange when language is changed", () => {
    const onLangChange = vi.fn();
    const header = renderNearbyHeader({
      articleCount: 3,
      currentLang: "en",
      onLangChange,
      paused: false,
    });
    const select = header.querySelector(
      ".header-lang-select",
    ) as HTMLSelectElement;
    select.value = "ja";
    select.dispatchEvent(new Event("change"));
    expect(onLangChange).toHaveBeenCalledWith("ja");
  });

  it("calls onTogglePause when pause button clicked", () => {
    const onTogglePause = vi.fn();
    const header = renderNearbyHeader({
      articleCount: 3,
      currentLang: "en",
      onLangChange: () => {},
      paused: false,
      onTogglePause,
    });
    const btn = header.querySelector(".pause-toggle") as HTMLButtonElement;
    btn.click();
    expect(onTogglePause).toHaveBeenCalledOnce();
  });

  it("renders dual-icon mode toggle with GPS active", () => {
    const onPickLocation = vi.fn();
    const onUseGps = vi.fn();
    const header = renderNearbyHeader({
      articleCount: 3,
      currentLang: "en",
      onLangChange: () => {},
      paused: false,
      positionSource: "gps",
      onPickLocation,
      onUseGps,
    });
    const gpsBtn = header.querySelector(".use-gps-btn") as HTMLButtonElement;
    const pinBtn = header.querySelector(
      ".pick-location-btn",
    ) as HTMLButtonElement;
    expect(gpsBtn).not.toBeNull();
    expect(pinBtn).not.toBeNull();
    expect(gpsBtn.classList.contains("mode-active")).toBe(true);
    expect(pinBtn.classList.contains("mode-inactive")).toBe(true);
    expect(gpsBtn.getAttribute("aria-pressed")).toBe("true");
    expect(gpsBtn.getAttribute("title")).toBe("Use GPS location");
    expect(pinBtn.getAttribute("aria-pressed")).toBe("false");
    expect(pinBtn.getAttribute("title")).toBe("Pick location on map");
    pinBtn.click();
    expect(onPickLocation).toHaveBeenCalledOnce();
  });

  it("renders dual-icon mode toggle with pin active", () => {
    const onPickLocation = vi.fn();
    const onUseGps = vi.fn();
    const header = renderNearbyHeader({
      articleCount: 3,
      currentLang: "en",
      onLangChange: () => {},
      paused: false,
      positionSource: "picked",
      onPickLocation,
      onUseGps,
    });
    const gpsBtn = header.querySelector(".use-gps-btn") as HTMLButtonElement;
    const pinBtn = header.querySelector(
      ".pick-location-btn",
    ) as HTMLButtonElement;
    expect(gpsBtn.classList.contains("mode-inactive")).toBe(true);
    expect(pinBtn.classList.contains("mode-active")).toBe(true);
    expect(pinBtn.getAttribute("title")).toBe("Pick a new location");
    gpsBtn.click();
    expect(onUseGps).toHaveBeenCalledOnce();
  });

  it("re-picks location with confirmation when pin is active", () => {
    const onPickLocation = vi.fn();
    const onUseGps = vi.fn();
    globalThis.confirm = vi.fn(() => true);
    const header = renderNearbyHeader({
      articleCount: 3,
      currentLang: "en",
      onLangChange: () => {},
      paused: false,
      positionSource: "picked",
      onPickLocation,
      onUseGps,
    });
    const pinBtn = header.querySelector(
      ".pick-location-btn",
    ) as HTMLButtonElement;
    pinBtn.click();
    expect(globalThis.confirm).toHaveBeenCalledWith(
      "Choose a different location?",
    );
    expect(onPickLocation).toHaveBeenCalledOnce();
  });

  it("does not re-pick location when confirmation is dismissed", () => {
    const onPickLocation = vi.fn();
    const onUseGps = vi.fn();
    globalThis.confirm = vi.fn(() => false);
    const header = renderNearbyHeader({
      articleCount: 3,
      currentLang: "en",
      onLangChange: () => {},
      paused: false,
      positionSource: "picked",
      onPickLocation,
      onUseGps,
    });
    const pinBtn = header.querySelector(
      ".pick-location-btn",
    ) as HTMLButtonElement;
    pinBtn.click();
    expect(globalThis.confirm).toHaveBeenCalled();
    expect(onPickLocation).not.toHaveBeenCalled();
  });

  it("omits mode toggle when positionSource not provided", () => {
    const header = renderNearbyHeader({
      articleCount: 3,
      currentLang: "en",
      onLangChange: () => {},
      paused: false,
    });
    expect(header.querySelector(".mode-toggle")).toBeNull();
    expect(header.querySelector(".pick-location-btn")).toBeNull();
    expect(header.querySelector(".use-gps-btn")).toBeNull();
  });
});

// ── helpers ──────────────────────────────────────────────────

function makeArticles(n: number): NearbyArticle[] {
  return Array.from({ length: n }, (_, i) => ({
    title: `Article ${i}`,
    lat: 48 + i * 0.01,
    lon: 2 + i * 0.01,
    distanceM: (i + 1) * 100,
  }));
}

// ── renderNearbyList ─────────────────────────────────────────

describe("renderNearbyList", () => {
  it("renders correct number of list items", () => {
    const container = document.createElement("div");
    renderNearbyList(container, makeArticles(3), {
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });
    const items = container.querySelectorAll(".nearby-item");
    expect(items).toHaveLength(3);
  });

  it("article items are keyboard-accessible", () => {
    const container = document.createElement("div");
    renderNearbyList(container, makeArticles(1), {
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });
    const item = container.querySelector(".nearby-item") as HTMLElement;
    expect(item.getAttribute("role")).toBe("button");
    expect(item.tabIndex).toBe(0);
  });

  it("calls onSelectArticle when item is clicked", () => {
    const articles = makeArticles(2);
    const onSelect = vi.fn();
    const container = document.createElement("div");
    renderNearbyList(container, articles, {
      onSelectArticle: onSelect,
      currentLang: "en",
      onLangChange: () => {},
    });
    const items = container.querySelectorAll(".nearby-item");
    (items[1] as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith(articles[1]);
  });

  it("clears container before rendering", () => {
    const container = document.createElement("div");
    const stale = document.createElement("p");
    stale.textContent = "stale";
    container.appendChild(stale);
    renderNearbyList(container, makeArticles(1), {
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });
    expect(stale.parentNode).toBeNull();
  });

  it("sets data-title on each list item", () => {
    const container = document.createElement("div");
    renderNearbyList(container, makeArticles(2), {
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });
    const items = container.querySelectorAll<HTMLElement>(".nearby-item");
    expect(items[0].dataset.title).toBe("Article 0");
    expect(items[1].dataset.title).toBe("Article 1");
  });

  it("restores scroll position on re-render", () => {
    const container = document.createElement("div");
    const opts = {
      onSelectArticle: () => {},
      currentLang: "en" as const,
      onLangChange: () => {},
    };
    renderNearbyList(container, makeArticles(3), opts);

    Object.defineProperty(window, "scrollY", {
      value: 250,
      configurable: true,
    });
    const scrollToSpy = vi
      .spyOn(window, "scrollTo")
      .mockImplementation(() => {});

    renderNearbyList(container, makeArticles(3), opts);
    expect(scrollToSpy).toHaveBeenCalledWith(0, 250);

    scrollToSpy.mockRestore();
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  });

  it("does not restore scroll on first render", () => {
    const container = document.createElement("div");
    Object.defineProperty(window, "scrollY", {
      value: 100,
      configurable: true,
    });
    const scrollToSpy = vi
      .spyOn(window, "scrollTo")
      .mockImplementation(() => {});

    renderNearbyList(container, makeArticles(2), {
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });
    expect(scrollToSpy).not.toHaveBeenCalled();

    scrollToSpy.mockRestore();
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  });

  it("restores focus to language selector on re-render", () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const container = document.createElement("div");
    document.body.appendChild(container);
    const opts = {
      onSelectArticle: () => {},
      currentLang: "en" as const,
      onLangChange: () => {},
    };
    renderNearbyList(container, makeArticles(2), opts);

    const langSelect = container.querySelector<HTMLElement>(
      ".header-lang-select",
    )!;
    langSelect.focus();
    expect(document.activeElement).toBe(langSelect);

    renderNearbyList(container, makeArticles(2), opts);
    const newLangSelect = container.querySelector<HTMLElement>(
      ".header-lang-select",
    )!;
    expect(document.activeElement).toBe(newLangSelect);

    vi.restoreAllMocks();
  });

  it("restores focus to article item by title on re-render", () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const container = document.createElement("div");
    document.body.appendChild(container);
    const opts = {
      onSelectArticle: () => {},
      currentLang: "en" as const,
      onLangChange: () => {},
    };
    renderNearbyList(container, makeArticles(3), opts);

    const items = container.querySelectorAll<HTMLElement>(".nearby-item");
    items[1].focus();
    expect(document.activeElement).toBe(items[1]);

    renderNearbyList(container, makeArticles(3), opts);
    const newItems = container.querySelectorAll<HTMLElement>(".nearby-item");
    expect(document.activeElement).toBe(newItems[1]);

    vi.restoreAllMocks();
  });

  it("restores focus to pick-location button on re-render", () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const container = document.createElement("div");
    document.body.appendChild(container);
    const opts = {
      onSelectArticle: () => {},
      currentLang: "en" as const,
      onLangChange: () => {},
      positionSource: "gps" as const,
      onPickLocation: () => {},
      onUseGps: () => {},
    };
    renderNearbyList(container, makeArticles(2), opts);

    const posBtn = container.querySelector<HTMLElement>(".pick-location-btn")!;
    posBtn.focus();
    expect(document.activeElement).toBe(posBtn);

    renderNearbyList(container, makeArticles(2), opts);
    const newPosBtn =
      container.querySelector<HTMLElement>(".pick-location-btn")!;
    expect(document.activeElement).toBe(newPosBtn);

    vi.restoreAllMocks();
  });

  it("restores focus to use-gps button on re-render", () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const container = document.createElement("div");
    document.body.appendChild(container);
    const opts = {
      onSelectArticle: () => {},
      currentLang: "en" as const,
      onLangChange: () => {},
      positionSource: "picked" as const,
      onPickLocation: () => {},
      onUseGps: () => {},
    };
    renderNearbyList(container, makeArticles(2), opts);

    const gpsBtn = container.querySelector<HTMLElement>(".use-gps-btn")!;
    gpsBtn.focus();
    expect(document.activeElement).toBe(gpsBtn);

    renderNearbyList(container, makeArticles(2), opts);
    const newGpsBtn = container.querySelector<HTMLElement>(".use-gps-btn")!;
    expect(document.activeElement).toBe(newGpsBtn);

    vi.restoreAllMocks();
  });

  it("restores focus to pause button on re-render", () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const container = document.createElement("div");
    document.body.appendChild(container);
    const opts = {
      onSelectArticle: () => {},
      currentLang: "en" as const,
      onLangChange: () => {},
      paused: false,
      onTogglePause: () => {},
    };
    renderNearbyList(container, makeArticles(2), opts);

    const pauseBtn = container.querySelector<HTMLElement>(".pause-toggle")!;
    pauseBtn.focus();
    expect(document.activeElement).toBe(pauseBtn);

    renderNearbyList(container, makeArticles(2), opts);
    const newPauseBtn = container.querySelector<HTMLElement>(".pause-toggle")!;
    expect(document.activeElement).toBe(newPauseBtn);

    vi.restoreAllMocks();
  });
});

// ── reconciliation on re-render ──────────────────────────────

describe("renderNearbyList reconciliation", () => {
  it("reuses DOM nodes for articles present in both renders", () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const container = document.createElement("div");
    const opts = {
      onSelectArticle: () => {},
      currentLang: "en" as const,
      onLangChange: () => {},
    };
    renderNearbyList(container, makeArticles(3), opts);

    const originalItems = Array.from(
      container.querySelectorAll(".nearby-item"),
    );

    renderNearbyList(container, makeArticles(3), opts);

    const newItems = Array.from(container.querySelectorAll(".nearby-item"));
    expect(newItems[0]).toBe(originalItems[0]);
    expect(newItems[1]).toBe(originalItems[1]);
    expect(newItems[2]).toBe(originalItems[2]);
    vi.restoreAllMocks();
  });

  it("creates new nodes only for new articles", () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const container = document.createElement("div");
    const original = makeArticles(3);
    const opts = {
      onSelectArticle: () => {},
      currentLang: "en" as const,
      onLangChange: () => {},
    };
    renderNearbyList(container, original, opts);

    const originalItems = Array.from(
      container.querySelectorAll(".nearby-item"),
    );

    // Drop Article 0, keep 1 and 2, add Article 3
    const updated = [
      ...original.slice(1),
      { title: "Article 3", lat: 49, lon: 3, distanceM: 400 },
    ];
    renderNearbyList(container, updated, opts);

    const newItems = Array.from(
      container.querySelectorAll<HTMLElement>(".nearby-item"),
    );
    expect(newItems).toHaveLength(3);
    expect(newItems[0]).toBe(originalItems[1]);
    expect(newItems[1]).toBe(originalItems[2]);
    expect(newItems[2].dataset.title).toBe("Article 3");
    vi.restoreAllMocks();
  });

  it("updates distance badges on reused nodes", () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const container = document.createElement("div");
    const opts = {
      onSelectArticle: () => {},
      currentLang: "en" as const,
      onLangChange: () => {},
    };
    renderNearbyList(container, makeArticles(2), opts);

    const updated = makeArticles(2).map((a) => ({
      ...a,
      distanceM: a.distanceM + 500,
    }));
    renderNearbyList(container, updated, opts);

    const badges = container.querySelectorAll(".nearby-distance");
    expect(badges[0].textContent).toBe("600 m");
    expect(badges[1].textContent).toBe("700 m");
    vi.restoreAllMocks();
  });
});

// ── updateNearbyDistances ────────────────────────────────────

describe("updateNearbyDistances", () => {
  it("updates distance badges without rebuilding the list", () => {
    const articles = [
      { title: "A", lat: 0, lon: 0, distanceM: 100 },
      { title: "B", lat: 1, lon: 1, distanceM: 200 },
    ];
    const container = document.createElement("div");
    renderNearbyList(container, articles, {
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });

    const titlesBefore = Array.from(
      container.querySelectorAll(".nearby-name"),
    ).map((el) => el.textContent);

    const updated = [
      { title: "A", lat: 0, lon: 0, distanceM: 500 },
      { title: "B", lat: 1, lon: 1, distanceM: 1500 },
    ];
    updateNearbyDistances(container, updated);

    const badges = container.querySelectorAll(".nearby-distance");
    expect(badges[0].textContent).toBe("500 m");
    expect(badges[1].textContent).toBe("1.5 km");

    const titlesAfter = Array.from(
      container.querySelectorAll(".nearby-name"),
    ).map((el) => el.textContent);
    expect(titlesAfter).toEqual(titlesBefore);
  });
});

// ── enrichArticleItem ─────────────────────────────────────────

function makeSummary(overrides: Partial<ArticleSummary> = {}): ArticleSummary {
  return {
    title: "Article 0",
    extract: "A place",
    description: "A nice description",
    thumbnailUrl: "https://example.com/thumb.jpg",
    thumbnailWidth: 100,
    thumbnailHeight: 100,
    pageUrl: "https://en.wikipedia.org/wiki/Article_0",
    ...overrides,
  };
}

describe("enrichArticleItem", () => {
  it("sets description text on matching item", () => {
    const container = document.createElement("div");
    renderNearbyList(container, makeArticles(2), {
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });

    enrichArticleItem(container, "Article 0", makeSummary());
    const desc = container.querySelector(
      '.nearby-item[data-title="Article 0"] .nearby-desc',
    );
    expect(desc?.textContent).toBe("A nice description");
  });

  it("adds thumbnail image on matching item", () => {
    const container = document.createElement("div");
    renderNearbyList(container, makeArticles(1), {
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });

    enrichArticleItem(container, "Article 0", makeSummary());
    const thumb = container.querySelector(".nearby-thumb");
    const img = thumb?.querySelector("img");
    expect(img?.src).toBe("https://example.com/thumb.jpg");
    expect(thumb?.classList.contains("nearby-thumb-loaded")).toBe(true);
  });

  it("does not add duplicate images on repeated calls", () => {
    const container = document.createElement("div");
    renderNearbyList(container, makeArticles(1), {
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });

    const summary = makeSummary();
    enrichArticleItem(container, "Article 0", summary);
    enrichArticleItem(container, "Article 0", summary);
    const imgs = container.querySelectorAll(".nearby-thumb img");
    expect(imgs).toHaveLength(1);
  });

  it("handles missing thumbnail gracefully", () => {
    const container = document.createElement("div");
    renderNearbyList(container, makeArticles(1), {
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });

    enrichArticleItem(
      container,
      "Article 0",
      makeSummary({ thumbnailUrl: null }),
    );
    const img = container.querySelector(".nearby-thumb img");
    expect(img).toBeNull();
    expect(
      container
        .querySelector(".nearby-thumb")
        ?.classList.contains("nearby-thumb-loaded"),
    ).toBe(false);
  });

  it("handles empty description gracefully", () => {
    const container = document.createElement("div");
    renderNearbyList(container, makeArticles(1), {
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });

    enrichArticleItem(container, "Article 0", makeSummary({ description: "" }));
    const desc = container.querySelector(".nearby-desc");
    expect(desc?.textContent).toBe("");
  });

  it("does nothing for non-matching title", () => {
    const container = document.createElement("div");
    renderNearbyList(container, makeArticles(1), {
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });

    enrichArticleItem(container, "Nonexistent", makeSummary());
    const desc = container.querySelector(".nearby-desc");
    expect(desc?.textContent).toBe("");
  });

  it("preserves enrichment through list reconciliation", () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const container = document.createElement("div");
    const opts = {
      onSelectArticle: () => {},
      currentLang: "en" as const,
      onLangChange: () => {},
    };
    renderNearbyList(container, makeArticles(2), opts);

    enrichArticleItem(container, "Article 0", makeSummary());

    // Re-render with same articles (triggers reconciliation)
    renderNearbyList(container, makeArticles(2), opts);

    const desc = container.querySelector(
      '.nearby-item[data-title="Article 0"] .nearby-desc',
    );
    expect(desc?.textContent).toBe("A nice description");
    const img = container.querySelector(".nearby-thumb img");
    expect(img).not.toBeNull();
    vi.restoreAllMocks();
  });
});
