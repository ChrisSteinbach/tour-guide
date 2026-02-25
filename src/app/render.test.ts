// @vitest-environment jsdom

import {
  renderNearbyHeader,
  renderShowMoreButton,
  renderNearbyList,
  updateNearbyDistances,
} from "./render";
import type { NearbyArticle } from "./types";

// ── renderNearbyHeader ───────────────────────────────────────

describe("renderNearbyHeader", () => {
  it("renders article count in subtitle", () => {
    const header = renderNearbyHeader(5, "en", () => {}, false);
    const subtitle = header.querySelector("p");
    expect(subtitle?.textContent).toBe("5 nearby attractions");
  });

  it("uses singular when count is 1", () => {
    const header = renderNearbyHeader(1, "en", () => {}, false);
    const subtitle = header.querySelector("p");
    expect(subtitle?.textContent).toBe("1 nearby attraction");
  });

  it("shows paused in subtitle when paused", () => {
    const header = renderNearbyHeader(3, "en", () => {}, true);
    const subtitle = header.querySelector("p");
    expect(subtitle?.textContent).toContain("paused");
  });

  it("pause button label says Resume when paused", () => {
    const header = renderNearbyHeader(
      3,
      "en",
      () => {},
      true,
      () => {},
    );
    const btn = header.querySelector(".pause-toggle");
    expect(btn?.getAttribute("aria-label")).toBe("Resume updates");
  });

  it("pause button label says Pause when unpaused", () => {
    const header = renderNearbyHeader(
      3,
      "en",
      () => {},
      false,
      () => {},
    );
    const btn = header.querySelector(".pause-toggle");
    expect(btn?.getAttribute("aria-label")).toBe("Pause updates");
  });

  it("omits pause button when no onTogglePause callback", () => {
    const header = renderNearbyHeader(3, "en", () => {}, false);
    expect(header.querySelector(".pause-toggle")).toBeNull();
  });

  it("language selector reflects currentLang", () => {
    const header = renderNearbyHeader(3, "sv", () => {}, false);
    const select = header.querySelector(
      ".header-lang-select",
    ) as HTMLSelectElement;
    expect(select.value).toBe("sv");
  });

  it("calls onLangChange when language is changed", () => {
    const onLangChange = vi.fn();
    const header = renderNearbyHeader(3, "en", onLangChange, false);
    const select = header.querySelector(
      ".header-lang-select",
    ) as HTMLSelectElement;
    select.value = "ja";
    select.dispatchEvent(new Event("change"));
    expect(onLangChange).toHaveBeenCalledWith("ja");
  });

  it("calls onTogglePause when pause button clicked", () => {
    const onTogglePause = vi.fn();
    const header = renderNearbyHeader(3, "en", () => {}, false, onTogglePause);
    const btn = header.querySelector(".pause-toggle") as HTMLButtonElement;
    btn.click();
    expect(onTogglePause).toHaveBeenCalledOnce();
  });
});

// ── renderShowMoreButton ─────────────────────────────────────

describe("renderShowMoreButton", () => {
  it("shows correct count in button text", () => {
    const btn = renderShowMoreButton(20, () => {});
    expect(btn?.textContent).toBe("Show 20");
  });

  it("returns null when nextCount is undefined", () => {
    expect(renderShowMoreButton(undefined, () => {})).toBeNull();
  });

  it("returns null when no onShowMore callback", () => {
    expect(renderShowMoreButton(20)).toBeNull();
  });

  it("calls onShowMore when clicked", () => {
    const onShowMore = vi.fn();
    const btn = renderShowMoreButton(20, onShowMore) as HTMLButtonElement;
    btn.click();
    expect(onShowMore).toHaveBeenCalledOnce();
  });
});

// ── renderNearbyList ─────────────────────────────────────────

describe("renderNearbyList", () => {
  function makeArticles(n: number): NearbyArticle[] {
    return Array.from({ length: n }, (_, i) => ({
      title: `Article ${i}`,
      lat: 48 + i * 0.01,
      lon: 2 + i * 0.01,
      distanceM: (i + 1) * 100,
    }));
  }

  it("renders correct number of list items", () => {
    const container = document.createElement("div");
    renderNearbyList(
      container,
      makeArticles(3),
      () => {},
      "en",
      () => {},
    );
    const items = container.querySelectorAll(".nearby-item");
    expect(items).toHaveLength(3);
  });

  it("article items are keyboard-accessible", () => {
    const container = document.createElement("div");
    renderNearbyList(
      container,
      makeArticles(1),
      () => {},
      "en",
      () => {},
    );
    const item = container.querySelector(".nearby-item") as HTMLElement;
    expect(item.getAttribute("role")).toBe("button");
    expect(item.tabIndex).toBe(0);
  });

  it("calls onSelectArticle when item is clicked", () => {
    const articles = makeArticles(2);
    const onSelect = vi.fn();
    const container = document.createElement("div");
    renderNearbyList(container, articles, onSelect, "en", () => {});
    const items = container.querySelectorAll(".nearby-item");
    (items[1] as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith(articles[1]);
  });

  it("includes show-more button when nextCount provided", () => {
    const container = document.createElement("div");
    renderNearbyList(
      container,
      makeArticles(2),
      () => {},
      "en",
      () => {},
      () => {},
      20,
    );
    expect(container.querySelector(".show-more")?.textContent).toBe("Show 20");
  });

  it("omits show-more button when nextCount is undefined", () => {
    const container = document.createElement("div");
    renderNearbyList(
      container,
      makeArticles(2),
      () => {},
      "en",
      () => {},
    );
    expect(container.querySelector(".show-more")).toBeNull();
  });

  it("clears container before rendering", () => {
    const container = document.createElement("div");
    container.appendChild(document.createElement("p"));
    renderNearbyList(
      container,
      makeArticles(1),
      () => {},
      "en",
      () => {},
    );
    expect(container.querySelector("p:not(header p)")?.textContent).not.toBe(
      "old content",
    );
  });

  it("sets data-title on each list item", () => {
    const container = document.createElement("div");
    renderNearbyList(
      container,
      makeArticles(2),
      () => {},
      "en",
      () => {},
    );
    const items = container.querySelectorAll<HTMLElement>(".nearby-item");
    expect(items[0].dataset.title).toBe("Article 0");
    expect(items[1].dataset.title).toBe("Article 1");
  });

  it("restores scroll position on re-render", () => {
    const container = document.createElement("div");
    const args = [
      container,
      makeArticles(3),
      () => {},
      "en",
      () => {},
    ] as const;
    renderNearbyList(...args);

    Object.defineProperty(window, "scrollY", {
      value: 250,
      configurable: true,
    });
    const scrollToSpy = vi
      .spyOn(window, "scrollTo")
      .mockImplementation(() => {});

    renderNearbyList(...args);
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

    renderNearbyList(
      container,
      makeArticles(2),
      () => {},
      "en",
      () => {},
    );
    expect(scrollToSpy).not.toHaveBeenCalled();

    scrollToSpy.mockRestore();
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  });

  it("restores focus to language selector on re-render", () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const container = document.createElement("div");
    document.body.appendChild(container);
    const args = [
      container,
      makeArticles(2),
      () => {},
      "en",
      () => {},
    ] as const;
    renderNearbyList(...args);

    const langSelect = container.querySelector<HTMLElement>(
      ".header-lang-select",
    )!;
    langSelect.focus();
    expect(document.activeElement).toBe(langSelect);

    renderNearbyList(...args);
    const newLangSelect = container.querySelector<HTMLElement>(
      ".header-lang-select",
    )!;
    expect(document.activeElement).toBe(newLangSelect);

    document.body.removeChild(container);
    vi.restoreAllMocks();
  });

  it("restores focus to article item by title on re-render", () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const container = document.createElement("div");
    document.body.appendChild(container);
    const args = [
      container,
      makeArticles(3),
      () => {},
      "en",
      () => {},
    ] as const;
    renderNearbyList(...args);

    const items = container.querySelectorAll<HTMLElement>(".nearby-item");
    items[1].focus();
    expect(document.activeElement).toBe(items[1]);

    renderNearbyList(...args);
    const newItems = container.querySelectorAll<HTMLElement>(".nearby-item");
    expect(document.activeElement).toBe(newItems[1]);

    document.body.removeChild(container);
    vi.restoreAllMocks();
  });

  it("restores focus to pause button on re-render", () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const container = document.createElement("div");
    document.body.appendChild(container);
    renderNearbyList(
      container,
      makeArticles(2),
      () => {},
      "en",
      () => {},
      () => {},
      20,
      false,
      () => {},
    );

    const pauseBtn = container.querySelector<HTMLElement>(".pause-toggle")!;
    pauseBtn.focus();
    expect(document.activeElement).toBe(pauseBtn);

    renderNearbyList(
      container,
      makeArticles(2),
      () => {},
      "en",
      () => {},
      () => {},
      20,
      false,
      () => {},
    );
    const newPauseBtn = container.querySelector<HTMLElement>(".pause-toggle")!;
    expect(document.activeElement).toBe(newPauseBtn);

    document.body.removeChild(container);
    vi.restoreAllMocks();
  });
});

// ── reconciliation on re-render ──────────────────────────────

describe("renderNearbyList reconciliation", () => {
  function makeArticles(n: number): NearbyArticle[] {
    return Array.from({ length: n }, (_, i) => ({
      title: `Article ${i}`,
      lat: 48 + i * 0.01,
      lon: 2 + i * 0.01,
      distanceM: (i + 1) * 100,
    }));
  }

  it("reuses DOM nodes for articles present in both renders", () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const container = document.createElement("div");
    renderNearbyList(
      container,
      makeArticles(3),
      () => {},
      "en",
      () => {},
    );

    const originalItems = Array.from(
      container.querySelectorAll(".nearby-item"),
    );

    renderNearbyList(
      container,
      makeArticles(3),
      () => {},
      "en",
      () => {},
    );

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
    renderNearbyList(
      container,
      original,
      () => {},
      "en",
      () => {},
    );

    const originalItems = Array.from(
      container.querySelectorAll(".nearby-item"),
    );

    // Drop Article 0, keep 1 and 2, add Article 3
    const updated = [
      ...original.slice(1),
      { title: "Article 3", lat: 49, lon: 3, distanceM: 400 },
    ];
    renderNearbyList(
      container,
      updated,
      () => {},
      "en",
      () => {},
    );

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
    renderNearbyList(
      container,
      makeArticles(2),
      () => {},
      "en",
      () => {},
    );

    const updated = makeArticles(2).map((a) => ({
      ...a,
      distanceM: a.distanceM + 500,
    }));
    renderNearbyList(
      container,
      updated,
      () => {},
      "en",
      () => {},
    );

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
    renderNearbyList(
      container,
      articles,
      () => {},
      "en",
      () => {},
    );

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
