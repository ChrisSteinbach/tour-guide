// @vitest-environment jsdom

import {
  renderNearbyHeader,
  renderNearbyList,
  updateNearbyDistances,
  enrichArticleItem,
} from "./render";
import type { NearbyArticle } from "./types";
import type { ArticleSummary } from "./wiki-api";

const onShowAbout = () => {};

afterEach(() => {
  while (document.body.firstChild) {
    document.body.firstChild.remove();
  }
});

// ── renderNearbyHeader ───────────────────────────────────────

describe("renderNearbyHeader", () => {
  afterEach(() => vi.restoreAllMocks());
  it("omits subtitle when not paused", () => {
    const header = renderNearbyHeader({
      onShowAbout,
      currentLang: "en",
      onLangChange: () => {},
      paused: false,
    });
    expect(header.querySelector("p")).toBeNull();
  });

  it("shows paused in subtitle when paused", () => {
    const header = renderNearbyHeader({
      onShowAbout,
      currentLang: "en",
      onLangChange: () => {},
      paused: true,
    });
    const subtitle = header.querySelector("p");
    expect(subtitle?.textContent).toBe("paused");
  });

  it("pause button label says Resume when manually paused", () => {
    const header = renderNearbyHeader({
      onShowAbout,
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
      onShowAbout,
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
      onShowAbout,
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
      onShowAbout,
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
      onShowAbout,
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
      onShowAbout,
      currentLang: "en",
      onLangChange: () => {},
      paused: false,
    });
    expect(header.querySelector(".pause-toggle")).toBeNull();
  });

  it("language selector reflects currentLang", () => {
    const header = renderNearbyHeader({
      onShowAbout,
      currentLang: "sv",
      onLangChange: () => {},
      paused: false,
    });
    const trigger = header.querySelector(".lang-trigger") as HTMLButtonElement;
    expect(trigger.textContent).toBe("SV");
    const active = header.querySelector(".lang-option-active") as HTMLElement;
    expect(active.dataset.lang).toBe("sv");
  });

  it("calls onLangChange when language is changed", () => {
    const onLangChange = vi.fn();
    const header = renderNearbyHeader({
      onShowAbout,
      currentLang: "en",
      onLangChange,
      paused: false,
    });
    const jaOption = header.querySelector('[data-lang="ja"]') as HTMLElement;
    jaOption.click();
    expect(onLangChange).toHaveBeenCalledWith("ja");
  });

  it("calls onTogglePause when pause button clicked", () => {
    const onTogglePause = vi.fn();
    const header = renderNearbyHeader({
      onShowAbout,
      currentLang: "en",
      onLangChange: () => {},
      paused: false,
      onTogglePause,
    });
    const btn = header.querySelector(".pause-toggle") as HTMLButtonElement;
    btn.click();
    expect(onTogglePause).toHaveBeenCalledOnce();
  });

  it("renders the filter toggle pressed in Highlights mode", () => {
    const header = renderNearbyHeader({
      onShowAbout,
      currentLang: "en",
      onLangChange: () => {},
      paused: false,
      filter: "highlights",
      onToggleFilter: () => {},
    });
    const btn = header.querySelector(".filter-toggle") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders the filter toggle unpressed in Everything mode", () => {
    const header = renderNearbyHeader({
      onShowAbout,
      currentLang: "en",
      onLangChange: () => {},
      paused: false,
      filter: "all",
      onToggleFilter: () => {},
    });
    const btn = header.querySelector(".filter-toggle") as HTMLButtonElement;
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("aria-label")).toBe("Show highlights only");
  });

  it("calls onToggleFilter when the filter toggle is clicked", () => {
    const onToggleFilter = vi.fn();
    const header = renderNearbyHeader({
      onShowAbout,
      currentLang: "en",
      onLangChange: () => {},
      paused: false,
      filter: "highlights",
      onToggleFilter,
    });
    const btn = header.querySelector(".filter-toggle") as HTMLButtonElement;
    btn.click();
    expect(onToggleFilter).toHaveBeenCalledOnce();
  });

  it("omits the filter toggle when no onToggleFilter callback", () => {
    const header = renderNearbyHeader({
      onShowAbout,
      currentLang: "en",
      onLangChange: () => {},
      paused: false,
    });
    expect(header.querySelector(".filter-toggle")).toBeNull();
  });

  it("renders dual-icon mode toggle with GPS active", () => {
    const onPickLocation = vi.fn();
    const onUseGps = vi.fn();
    const header = renderNearbyHeader({
      onShowAbout,
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
      onShowAbout,
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
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    const header = renderNearbyHeader({
      onShowAbout,
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
    vi.spyOn(globalThis, "confirm").mockReturnValue(false);
    const header = renderNearbyHeader({
      onShowAbout,
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

  it("adds gps-signal-lost class when gpsSignalLost is true", () => {
    const header = renderNearbyHeader({
      onShowAbout,
      currentLang: "en",
      onLangChange: () => {},
      paused: false,
      positionSource: "gps",
      onPickLocation: () => {},
      onUseGps: () => {},
      gpsSignalLost: true,
    });
    const gpsBtn = header.querySelector(".use-gps-btn") as HTMLButtonElement;
    expect(gpsBtn.classList.contains("gps-signal-lost")).toBe(true);
  });

  it("aria-label reads 'GPS signal lost' when gpsSignalLost is true", () => {
    const header = renderNearbyHeader({
      onShowAbout,
      currentLang: "en",
      onLangChange: () => {},
      paused: false,
      positionSource: "gps",
      onPickLocation: () => {},
      onUseGps: () => {},
      gpsSignalLost: true,
    });
    const gpsBtn = header.querySelector(".use-gps-btn") as HTMLButtonElement;
    expect(gpsBtn.getAttribute("aria-label")).toBe("GPS signal lost");
  });

  it("aria-label reads 'Use GPS location' when gpsSignalLost is absent", () => {
    const header = renderNearbyHeader({
      onShowAbout,
      currentLang: "en",
      onLangChange: () => {},
      paused: false,
      positionSource: "gps",
      onPickLocation: () => {},
      onUseGps: () => {},
    });
    const gpsBtn = header.querySelector(".use-gps-btn") as HTMLButtonElement;
    expect(gpsBtn.getAttribute("aria-label")).toBe("Use GPS location");
  });

  it("omits mode toggle when positionSource not provided", () => {
    const header = renderNearbyHeader({
      onShowAbout,
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
      onShowAbout,
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
      onShowAbout,
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
      onShowAbout,
      onSelectArticle: onSelect,
      currentLang: "en",
      onLangChange: () => {},
    });
    const items = container.querySelectorAll(".nearby-item");
    (items[1] as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith(articles[1]);
  });

  it("calls onSelectArticle when Enter is pressed on item", () => {
    const articles = makeArticles(1);
    const onSelect = vi.fn();
    const container = document.createElement("div");
    renderNearbyList(container, articles, {
      onShowAbout,
      onSelectArticle: onSelect,
      currentLang: "en",
      onLangChange: () => {},
    });
    const item = container.querySelector(".nearby-item") as HTMLElement;
    item.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(onSelect).toHaveBeenCalledWith(articles[0]);
  });

  it("calls onSelectArticle when Space is pressed on item", () => {
    const articles = makeArticles(1);
    const onSelect = vi.fn();
    const container = document.createElement("div");
    renderNearbyList(container, articles, {
      onShowAbout,
      onSelectArticle: onSelect,
      currentLang: "en",
      onLangChange: () => {},
    });
    const item = container.querySelector(".nearby-item") as HTMLElement;
    item.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
    expect(onSelect).toHaveBeenCalledWith(articles[0]);
  });

  it("does not call onSelectArticle for unrelated keys", () => {
    const onSelect = vi.fn();
    const container = document.createElement("div");
    renderNearbyList(container, makeArticles(1), {
      onShowAbout,
      onSelectArticle: onSelect,
      currentLang: "en",
      onLangChange: () => {},
    });
    const item = container.querySelector(".nearby-item") as HTMLElement;
    item.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clears container before rendering", () => {
    const container = document.createElement("div");
    const stale = document.createElement("p");
    stale.textContent = "stale";
    container.appendChild(stale);
    renderNearbyList(container, makeArticles(1), {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });
    expect(stale.parentNode).toBeNull();
  });

  it("sets data-title on each list item", () => {
    const container = document.createElement("div");
    renderNearbyList(container, makeArticles(2), {
      onShowAbout,
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
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en" as const,
      onLangChange: () => {},
    };
    renderNearbyList(container, makeArticles(3), opts);

    container.scrollTop = 250;

    renderNearbyList(container, makeArticles(3), opts);
    expect(container.scrollTop).toBe(250);
  });

  it("first render takes the fresh-build path (no scroll restore)", () => {
    const container = document.createElement("div");
    renderNearbyList(container, makeArticles(2), {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });
    // First render clears the container and builds from scratch
    // (no existing .nearby-list to trigger the incremental path).
    expect(container.querySelector(".app-scroll .nearby-list")).not.toBeNull();
    expect(container.querySelectorAll(".nearby-item")).toHaveLength(2);
  });

  it.each([
    {
      name: "language selector",
      selector: ".lang-trigger",
      articleCount: 2,
      extraOpts: {},
    },
    {
      name: "article item (by title)",
      selector: '.nearby-item[data-title="Article 1"]',
      articleCount: 3,
      extraOpts: {},
    },
    {
      name: "pick-location button",
      selector: ".pick-location-btn",
      articleCount: 2,
      extraOpts: {
        positionSource: "gps" as const,
        onPickLocation: () => {},
        onUseGps: () => {},
      },
    },
    {
      name: "use-gps button",
      selector: ".use-gps-btn",
      articleCount: 2,
      extraOpts: {
        positionSource: "picked" as const,
        onPickLocation: () => {},
        onUseGps: () => {},
      },
    },
    {
      name: "pause button",
      selector: ".pause-toggle",
      articleCount: 2,
      extraOpts: {
        paused: false,
        onTogglePause: () => {},
      },
    },
    {
      name: "about button",
      selector: ".about-btn",
      articleCount: 2,
      extraOpts: {},
    },
  ])(
    "restores focus to $name on re-render",
    ({ selector, articleCount, extraOpts }) => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const opts = {
        onShowAbout,
        onSelectArticle: () => {},
        currentLang: "en" as const,
        onLangChange: () => {},
        ...extraOpts,
      };
      renderNearbyList(container, makeArticles(articleCount), opts);

      const el = container.querySelector<HTMLElement>(selector)!;
      el.focus();
      expect(document.activeElement).toBe(el);

      renderNearbyList(container, makeArticles(articleCount), opts);
      const newEl = container.querySelector<HTMLElement>(selector)!;
      expect(document.activeElement).toBe(newEl);
    },
  );
});

// ── open dropdown protection ─────────────────────────────────

describe("renderNearbyList empty-highlights hint", () => {
  it("shows the hint when Highlights mode yields zero articles", () => {
    const container = document.createElement("div");
    renderNearbyList(container, [], {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
      filter: "highlights",
      onToggleFilter: () => {},
    });
    const hint = container.querySelector(".nearby-empty");
    expect(hint?.textContent).toContain("No highlights nearby");
  });

  it("clicking the hint's action switches to Everything", () => {
    const onToggleFilter = vi.fn();
    const container = document.createElement("div");
    renderNearbyList(container, [], {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
      filter: "highlights",
      onToggleFilter,
    });
    const btn = container.querySelector(
      ".nearby-empty-action",
    ) as HTMLButtonElement;
    btn.click();
    expect(onToggleFilter).toHaveBeenCalledOnce();
  });

  it("shows no hint for an empty list in Everything mode", () => {
    const container = document.createElement("div");
    renderNearbyList(container, [], {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
      filter: "all",
      onToggleFilter: () => {},
    });
    expect(container.querySelector(".nearby-empty")).toBeNull();
  });

  it("removes the hint when a re-render brings articles", () => {
    const container = document.createElement("div");
    const opts = {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en" as const,
      onLangChange: () => {},
      filter: "highlights" as const,
      onToggleFilter: () => {},
    };
    renderNearbyList(container, [], opts);
    expect(container.querySelector(".nearby-empty")).not.toBeNull();

    renderNearbyList(container, makeArticles(2), opts);
    expect(container.querySelector(".nearby-empty")).toBeNull();
    expect(container.querySelectorAll(".nearby-item")).toHaveLength(2);
  });

  it("adds the hint when a re-render empties the list", () => {
    const container = document.createElement("div");
    const opts = {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en" as const,
      onLangChange: () => {},
      filter: "highlights" as const,
      onToggleFilter: () => {},
    };
    renderNearbyList(container, makeArticles(2), opts);
    expect(container.querySelector(".nearby-empty")).toBeNull();

    renderNearbyList(container, [], opts);
    expect(container.querySelector(".nearby-empty")).not.toBeNull();
  });
});

describe("renderNearbyList skips header replacement while dropdown is open", () => {
  it("preserves header when lang dropdown is open", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const opts = {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en" as const,
      onLangChange: () => {},
    };
    renderNearbyList(container, makeArticles(3), opts);

    const oldHeader = container.querySelector("header.app-header")!;
    // Simulate opening the dropdown
    const listbox = oldHeader.querySelector(".lang-listbox") as HTMLElement;
    listbox.hidden = false;

    renderNearbyList(container, makeArticles(3), opts);

    // Header should be the same DOM node (not replaced)
    expect(container.querySelector("header.app-header")).toBe(oldHeader);
    // Dropdown should still be open
    expect(listbox.hidden).toBe(false);
  });

  it("replaces header when lang dropdown is closed", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const opts = {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en" as const,
      onLangChange: () => {},
    };
    renderNearbyList(container, makeArticles(3), opts);

    const oldHeader = container.querySelector("header.app-header")!;
    // Dropdown stays closed (default)

    renderNearbyList(container, makeArticles(3), opts);

    // Header should be a new DOM node
    expect(container.querySelector("header.app-header")).not.toBe(oldHeader);
  });
});

// ── reconciliation on re-render ──────────────────────────────

describe("renderNearbyList reconciliation", () => {
  it("reuses DOM nodes for articles present in both renders", () => {
    const container = document.createElement("div");
    const opts = {
      onShowAbout,
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
  });

  it("creates new nodes only for new articles", () => {
    const container = document.createElement("div");
    const original = makeArticles(3);
    const opts = {
      onShowAbout,
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
  });

  it("updates distance badges on reused nodes", () => {
    const container = document.createElement("div");
    const opts = {
      onShowAbout,
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
  });
});

// ── article item hover ───────────────────────────────────────

describe("article item hover", () => {
  it("fires onHoverArticle with title on pointerenter", () => {
    const onHover = vi.fn();
    const container = document.createElement("div");
    renderNearbyList(container, makeArticles(2), {
      onShowAbout,
      onSelectArticle: () => {},
      onHoverArticle: onHover,
      currentLang: "en",
      onLangChange: () => {},
    });

    const item = container.querySelector(".nearby-item") as HTMLElement;
    item.dispatchEvent(new Event("pointerenter"));

    expect(onHover).toHaveBeenCalledWith("Article 0");
  });

  it("fires onHoverArticle with null on pointerleave", () => {
    const onHover = vi.fn();
    const container = document.createElement("div");
    renderNearbyList(container, makeArticles(1), {
      onShowAbout,
      onSelectArticle: () => {},
      onHoverArticle: onHover,
      currentLang: "en",
      onLangChange: () => {},
    });

    const item = container.querySelector(".nearby-item") as HTMLElement;
    item.dispatchEvent(new Event("pointerleave"));

    expect(onHover).toHaveBeenCalledWith(null);
  });

  it("does not add pointer listeners when onHoverArticle is omitted", () => {
    const container = document.createElement("div");
    renderNearbyList(container, makeArticles(1), {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });

    const item = container.querySelector(".nearby-item") as HTMLElement;
    // Should not throw — no listeners attached
    item.dispatchEvent(new Event("pointerenter"));
    item.dispatchEvent(new Event("pointerleave"));
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
      onShowAbout,
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
      onShowAbout,
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
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });

    enrichArticleItem(container, "Article 0", makeSummary());
    const thumb = container.querySelector(".nearby-thumb");
    const img = thumb?.querySelector("img");
    expect(img?.src).toBe("https://example.com/thumb.jpg");
    // The column stays collapsed until the image actually loads, so an
    // in-flight thumbnail never leaves a blank indented gap on the card.
    expect(thumb?.classList.contains("nearby-thumb-loaded")).toBe(false);
  });

  it("reveals the thumbnail column only once the image loads", () => {
    const container = document.createElement("div");
    renderNearbyList(container, makeArticles(1), {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });

    enrichArticleItem(container, "Article 0", makeSummary());
    const thumb = container.querySelector(".nearby-thumb");
    const img = thumb?.querySelector("img");
    expect(thumb?.classList.contains("nearby-thumb-loaded")).toBe(false);

    img?.dispatchEvent(new Event("load"));
    expect(thumb?.classList.contains("nearby-thumb-loaded")).toBe(true);
  });

  it("collapses the thumbnail when the image fails to load", () => {
    const container = document.createElement("div");
    renderNearbyList(container, makeArticles(1), {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });

    enrichArticleItem(container, "Article 0", makeSummary());
    const thumb = container.querySelector(".nearby-thumb");
    const img = thumb?.querySelector("img");
    expect(img).not.toBeNull();

    img?.dispatchEvent(new Event("error"));
    expect(thumb?.querySelector("img")).toBeNull();
    expect(thumb?.classList.contains("nearby-thumb-loaded")).toBe(false);
  });

  it("does not add duplicate images on repeated calls", () => {
    const container = document.createElement("div");
    renderNearbyList(container, makeArticles(1), {
      onShowAbout,
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
      onShowAbout,
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
      onShowAbout,
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
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });

    enrichArticleItem(container, "Nonexistent", makeSummary());
    const desc = container.querySelector(".nearby-desc");
    expect(desc?.textContent).toBe("");
  });

  it("preserves enrichment through list reconciliation", () => {
    const container = document.createElement("div");
    const opts = {
      onShowAbout,
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
  });
});

// ── renderNearbyList coincident collapse ──────────────────────

describe("renderNearbyList coincident collapse", () => {
  it("collapses a coincident group behind a toggle", () => {
    const container = document.createElement("div");
    const articles = [
      { title: "Museum", lat: 40, lon: -70, distanceM: 100, weight: 200 },
      { title: "Cafe", lat: 40, lon: -70, distanceM: 100, weight: 30 },
      { title: "Gift Shop", lat: 40, lon: -70, distanceM: 100, weight: 10 },
      { title: "Park", lat: 41, lon: -71, distanceM: 800, weight: 5 },
    ];
    renderNearbyList(container, articles, {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });

    const groups = container.querySelectorAll<HTMLElement>(".nearby-group");
    expect(groups).toHaveLength(2);

    const firstGroup = groups[0];
    const rep = firstGroup.querySelector<HTMLElement>(".nearby-item");
    expect(rep?.dataset.title).toBe("Museum");

    const toggle = firstGroup.querySelector<HTMLButtonElement>(".nearby-more");
    expect(toggle?.textContent).toBe("+2 more here");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");

    const members = firstGroup.querySelector<HTMLElement>(".nearby-members");
    expect(members?.hidden).toBe(true);
  });

  it("picks the highest-weight member as representative even when it's not first", () => {
    const container = document.createElement("div");
    const articles = [
      { title: "Small", lat: 10, lon: 10, distanceM: 50, weight: 5 },
      { title: "Landmark", lat: 10, lon: 10, distanceM: 50, weight: 90 },
    ];
    renderNearbyList(container, articles, {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });

    const group = container.querySelector<HTMLElement>(".nearby-group");
    const rep = group?.querySelector<HTMLElement>(".nearby-item");
    expect(rep?.dataset.title).toBe("Landmark");

    const toggle = group?.querySelector<HTMLButtonElement>(".nearby-more");
    expect(toggle?.textContent).toBe("+1 more here");
  });

  it("renders lone articles without a toggle", () => {
    const container = document.createElement("div");
    renderNearbyList(container, makeArticles(2), {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });

    expect(container.querySelectorAll(".nearby-group")).toHaveLength(2);
    expect(container.querySelectorAll(".nearby-more")).toHaveLength(0);
  });

  it("keeps member rows in the DOM but hidden until expanded", () => {
    const container = document.createElement("div");
    const articles = [
      { title: "Museum", lat: 40, lon: -70, distanceM: 100, weight: 200 },
      { title: "Cafe", lat: 40, lon: -70, distanceM: 100, weight: 30 },
      { title: "Gift Shop", lat: 40, lon: -70, distanceM: 100, weight: 10 },
      { title: "Park", lat: 41, lon: -71, distanceM: 800, weight: 5 },
    ];
    renderNearbyList(container, articles, {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });

    const memberItems = container.querySelectorAll<HTMLElement>(
      ".nearby-members .nearby-item",
    );
    expect(memberItems).toHaveLength(2);
    expect(Array.from(memberItems).map((el) => el.dataset.title)).toEqual([
      "Cafe",
      "Gift Shop",
    ]);

    const membersWrap = container.querySelector<HTMLElement>(".nearby-members");
    expect(membersWrap?.hidden).toBe(true);
  });

  it("reveals members when the toggle is clicked", () => {
    const container = document.createElement("div");
    const articles = [
      { title: "Museum", lat: 40, lon: -70, distanceM: 100, weight: 200 },
      { title: "Cafe", lat: 40, lon: -70, distanceM: 100, weight: 30 },
      { title: "Gift Shop", lat: 40, lon: -70, distanceM: 100, weight: 10 },
      { title: "Park", lat: 41, lon: -71, distanceM: 800, weight: 5 },
    ];
    renderNearbyList(container, articles, {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });

    const toggle = container.querySelector<HTMLButtonElement>(".nearby-more")!;
    toggle.click();

    const membersWrap = container.querySelector<HTMLElement>(".nearby-members");
    expect(membersWrap?.hidden).toBe(false);
    expect(toggle.textContent).toBe("Show less");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const group = container.querySelector<HTMLElement>(".nearby-group");
    expect(group?.dataset.expanded).toBe("true");
  });

  it("re-collapses when the toggle is clicked twice", () => {
    const container = document.createElement("div");
    const articles = [
      { title: "Museum", lat: 40, lon: -70, distanceM: 100, weight: 200 },
      { title: "Cafe", lat: 40, lon: -70, distanceM: 100, weight: 30 },
      { title: "Gift Shop", lat: 40, lon: -70, distanceM: 100, weight: 10 },
      { title: "Park", lat: 41, lon: -71, distanceM: 800, weight: 5 },
    ];
    renderNearbyList(container, articles, {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });

    const toggle = container.querySelector<HTMLButtonElement>(".nearby-more")!;
    toggle.click();
    toggle.click();

    const membersWrap = container.querySelector<HTMLElement>(".nearby-members");
    expect(membersWrap?.hidden).toBe(true);
    expect(toggle.textContent).toBe("+2 more here");
  });

  it("opens a member's own detail when it is clicked", () => {
    const articles = [
      { title: "Museum", lat: 40, lon: -70, distanceM: 100, weight: 200 },
      { title: "Cafe", lat: 40, lon: -70, distanceM: 100, weight: 30 },
      { title: "Gift Shop", lat: 40, lon: -70, distanceM: 100, weight: 10 },
      { title: "Park", lat: 41, lon: -71, distanceM: 800, weight: 5 },
    ];
    const cafe = articles[1];
    const onSelect = vi.fn();
    const container = document.createElement("div");
    renderNearbyList(container, articles, {
      onShowAbout,
      onSelectArticle: onSelect,
      currentLang: "en",
      onLangChange: () => {},
    });

    const toggle = container.querySelector<HTMLButtonElement>(".nearby-more")!;
    toggle.click();

    const cafeItem = container.querySelector<HTMLElement>(
      '.nearby-item[data-title="Cafe"]',
    )!;
    cafeItem.click();
    expect(onSelect).toHaveBeenCalledWith(cafe);
  });

  it("patches member badges by title via updateNearbyDistances", () => {
    const container = document.createElement("div");
    const articles = [
      { title: "Museum", lat: 40, lon: -70, distanceM: 100, weight: 200 },
      { title: "Cafe", lat: 40, lon: -70, distanceM: 100, weight: 30 },
      { title: "Gift Shop", lat: 40, lon: -70, distanceM: 100, weight: 10 },
      { title: "Park", lat: 41, lon: -71, distanceM: 800, weight: 5 },
    ];
    renderNearbyList(container, articles, {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });

    updateNearbyDistances(container, [
      { title: "Museum", lat: 40, lon: -70, distanceM: 250, weight: 200 },
      { title: "Cafe", lat: 40, lon: -70, distanceM: 250, weight: 30 },
      { title: "Gift Shop", lat: 40, lon: -70, distanceM: 250, weight: 10 },
      { title: "Park", lat: 41, lon: -71, distanceM: 900, weight: 5 },
    ]);

    expect(
      container.querySelector(
        '.nearby-item[data-title="Museum"] .nearby-distance',
      )?.textContent,
    ).toBe("250 m");
    expect(
      container.querySelector(
        '.nearby-item[data-title="Cafe"] .nearby-distance',
      )?.textContent,
    ).toBe("250 m");
    expect(
      container.querySelector(
        '.nearby-item[data-title="Park"] .nearby-distance',
      )?.textContent,
    ).toBe("900 m");
  });

  it("enriches a member hidden inside a collapsed group", () => {
    const container = document.createElement("div");
    const articles = [
      { title: "Museum", lat: 40, lon: -70, distanceM: 100, weight: 200 },
      { title: "Cafe", lat: 40, lon: -70, distanceM: 100, weight: 30 },
      { title: "Gift Shop", lat: 40, lon: -70, distanceM: 100, weight: 10 },
      { title: "Park", lat: 41, lon: -71, distanceM: 800, weight: 5 },
    ];
    renderNearbyList(container, articles, {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en",
      onLangChange: () => {},
    });

    enrichArticleItem(
      container,
      "Cafe",
      makeSummary({ title: "Cafe", description: "A cozy cafe" }),
    );

    const desc = container.querySelector(
      '.nearby-item[data-title="Cafe"] .nearby-desc',
    );
    expect(desc?.textContent).toBe("A cozy cafe");
  });

  it("keeps a group expanded across a re-render", () => {
    const container = document.createElement("div");
    const articles = [
      { title: "Museum", lat: 40, lon: -70, distanceM: 100, weight: 200 },
      { title: "Cafe", lat: 40, lon: -70, distanceM: 100, weight: 30 },
      { title: "Gift Shop", lat: 40, lon: -70, distanceM: 100, weight: 10 },
      { title: "Park", lat: 41, lon: -71, distanceM: 800, weight: 5 },
    ];
    const opts = {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en" as const,
      onLangChange: () => {},
    };
    renderNearbyList(container, articles, opts);

    const toggle = container.querySelector<HTMLButtonElement>(".nearby-more")!;
    toggle.click();

    renderNearbyList(container, articles, opts);

    const membersWrap = container.querySelector<HTMLElement>(".nearby-members");
    const newToggle =
      container.querySelector<HTMLButtonElement>(".nearby-more");
    expect(membersWrap?.hidden).toBe(false);
    expect(newToggle?.textContent).toBe("Show less");
    expect(newToggle?.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps a member's enrichment across a re-render", () => {
    const container = document.createElement("div");
    const articles = [
      { title: "Museum", lat: 40, lon: -70, distanceM: 100, weight: 200 },
      { title: "Cafe", lat: 40, lon: -70, distanceM: 100, weight: 30 },
      { title: "Gift Shop", lat: 40, lon: -70, distanceM: 100, weight: 10 },
      { title: "Park", lat: 41, lon: -71, distanceM: 800, weight: 5 },
    ];
    const opts = {
      onShowAbout,
      onSelectArticle: () => {},
      currentLang: "en" as const,
      onLangChange: () => {},
    };
    renderNearbyList(container, articles, opts);

    const toggle = container.querySelector<HTMLButtonElement>(".nearby-more")!;
    toggle.click();

    enrichArticleItem(
      container,
      "Cafe",
      makeSummary({ title: "Cafe", description: "A cozy cafe" }),
    );

    renderNearbyList(container, articles, opts);

    const desc = container.querySelector(
      '.nearby-item[data-title="Cafe"] .nearby-desc',
    );
    expect(desc?.textContent).toBe("A cozy cafe");
  });
});
