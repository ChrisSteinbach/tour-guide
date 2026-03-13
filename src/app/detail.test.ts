// @vitest-environment jsdom

import {
  renderDetailLoading,
  renderDetailReady,
  renderDetailError,
} from "./detail";
import type { NearbyArticle } from "./types";
import type { ArticleSummary } from "./wiki-api";

function makeArticle(overrides: Partial<NearbyArticle> = {}): NearbyArticle {
  return {
    title: "Eiffel Tower",
    lat: 48.8584,
    lon: 2.2945,
    distanceM: 350,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<ArticleSummary> = {}): ArticleSummary {
  return {
    title: "Eiffel Tower",
    extract: "The Eiffel Tower is a landmark in Paris.",
    description: "Iron lattice tower in Paris",
    thumbnailUrl: "https://example.com/eiffel.jpg",
    thumbnailWidth: 200,
    thumbnailHeight: 300,
    pageUrl: "https://en.wikipedia.org/wiki/Eiffel_Tower",
    ...overrides,
  };
}

// ── renderDetailLoading ──────────────────────────────────────

describe("renderDetailLoading", () => {
  it("renders header with back button and title", () => {
    const container = document.createElement("div");
    renderDetailLoading(container, makeArticle(), () => {});

    expect(container.querySelector("h1")?.textContent).toBe("Eiffel Tower");
    expect(container.querySelector(".detail-back")).not.toBeNull();
  });

  it("renders distance in header", () => {
    const container = document.createElement("div");
    renderDetailLoading(container, makeArticle({ distanceM: 350 }), () => {});

    const sub = container.querySelector(".detail-header-text p");
    expect(sub?.textContent).toBe("350 m");
  });

  it("renders loading dot", () => {
    const container = document.createElement("div");
    renderDetailLoading(container, makeArticle(), () => {});

    expect(container.querySelector(".loading-dot")).not.toBeNull();
  });

  it("clears previous container content", () => {
    const container = document.createElement("div");
    const stale = document.createElement("p");
    stale.textContent = "old content";
    container.appendChild(stale);

    renderDetailLoading(container, makeArticle(), () => {});

    expect(stale.parentNode).toBeNull();
  });

  it("fires onBack when back button is clicked", () => {
    const onBack = vi.fn();
    const container = document.createElement("div");
    renderDetailLoading(container, makeArticle(), onBack);

    const back = container.querySelector(".detail-back") as HTMLButtonElement;
    back.click();
    expect(onBack).toHaveBeenCalledOnce();
  });
});

// ── renderDetailReady ────────────────────────────────────────

describe("renderDetailReady", () => {
  const noop = () => {};

  it("renders header with title and distance", () => {
    const container = document.createElement("div");
    renderDetailReady(container, makeArticle(), makeSummary(), noop, noop);

    expect(container.querySelector("h1")?.textContent).toBe("Eiffel Tower");
    const sub = container.querySelector(".detail-header-text p");
    expect(sub?.textContent).toBe("350 m");
  });

  it("renders thumbnail when summary has thumbnailUrl", () => {
    const container = document.createElement("div");
    renderDetailReady(container, makeArticle(), makeSummary(), noop, noop);

    const img = container.querySelector(
      ".detail-thumbnail",
    ) as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toBe("https://example.com/eiffel.jpg");
    expect(img.width).toBe(200);
    expect(img.height).toBe(300);
  });

  it("omits thumbnail when summary has no thumbnailUrl", () => {
    const container = document.createElement("div");
    renderDetailReady(
      container,
      makeArticle(),
      makeSummary({ thumbnailUrl: null }),
      noop,
      noop,
    );

    expect(container.querySelector(".detail-thumbnail")).toBeNull();
  });

  it("renders description when present", () => {
    const container = document.createElement("div");
    renderDetailReady(container, makeArticle(), makeSummary(), noop, noop);

    const desc = container.querySelector(".detail-description");
    expect(desc?.textContent).toBe("Iron lattice tower in Paris");
  });

  it("omits description when empty", () => {
    const container = document.createElement("div");
    renderDetailReady(
      container,
      makeArticle(),
      makeSummary({ description: "" }),
      noop,
      noop,
    );

    expect(container.querySelector(".detail-description")).toBeNull();
  });

  it("renders extract when present", () => {
    const container = document.createElement("div");
    renderDetailReady(container, makeArticle(), makeSummary(), noop, noop);

    const extract = container.querySelector(".detail-extract");
    expect(extract?.textContent).toBe(
      "The Eiffel Tower is a landmark in Paris.",
    );
  });

  it("omits extract when empty", () => {
    const container = document.createElement("div");
    renderDetailReady(
      container,
      makeArticle(),
      makeSummary({ extract: "" }),
      noop,
      noop,
    );

    expect(container.querySelector(".detail-extract")).toBeNull();
  });

  it("renders Wikipedia link with correct URL and target", () => {
    const container = document.createElement("div");
    renderDetailReady(container, makeArticle(), makeSummary(), noop, noop);

    const link = container.querySelector(
      ".detail-wiki-link",
    ) as HTMLAnchorElement;
    expect(link.href).toBe("https://en.wikipedia.org/wiki/Eiffel_Tower");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener");
  });

  it("renders directions link with correct URL", () => {
    const container = document.createElement("div");
    const article = makeArticle({ lat: 48.8584, lon: 2.2945 });
    renderDetailReady(container, article, makeSummary(), noop, noop);

    const link = container.querySelector(
      ".detail-directions-link",
    ) as HTMLAnchorElement;
    expect(link.href).toContain("48.8584");
    expect(link.href).toContain("2.2945");
    expect(link.target).toBe("_blank");
  });

  it("renders explore-from-here button", () => {
    const container = document.createElement("div");
    renderDetailReady(container, makeArticle(), makeSummary(), noop, noop);

    const btn = container.querySelector(
      ".detail-explore-btn",
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("Explore from here");
  });

  it("fires onExploreFromHere when explore button is clicked", () => {
    const onExplore = vi.fn();
    const container = document.createElement("div");
    renderDetailReady(container, makeArticle(), makeSummary(), noop, onExplore);

    const btn = container.querySelector(
      ".detail-explore-btn",
    ) as HTMLButtonElement;
    btn.click();
    expect(onExplore).toHaveBeenCalledOnce();
  });
});

// ── renderDetailError ────────────────────────────────────────

describe("renderDetailError", () => {
  it("renders header with title", () => {
    const container = document.createElement("div");
    renderDetailError(
      container,
      makeArticle(),
      "Failed to load",
      () => {},
      () => {},
    );

    expect(container.querySelector("h1")?.textContent).toBe("Eiffel Tower");
  });

  it("renders error message", () => {
    const container = document.createElement("div");
    renderDetailError(
      container,
      makeArticle(),
      "Network error",
      () => {},
      () => {},
    );

    const msg = container.querySelector(".status-message");
    expect(msg?.textContent).toBe("Network error");
  });

  it("fires onRetry when retry button is clicked", () => {
    const onRetry = vi.fn();
    const container = document.createElement("div");
    renderDetailError(container, makeArticle(), "Failed", () => {}, onRetry);

    const retry = container.querySelector(
      ".status-action",
    ) as HTMLButtonElement;
    retry.click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders fallback Wikipedia link", () => {
    const container = document.createElement("div");
    renderDetailError(
      container,
      makeArticle({ title: "Eiffel Tower" }),
      "Error",
      () => {},
      () => {},
      "en",
    );

    const link = container.querySelector(
      ".detail-wiki-link",
    ) as HTMLAnchorElement;
    expect(link.href).toContain("en.wikipedia.org");
    expect(link.href).toContain("Eiffel_Tower");
    expect(link.target).toBe("_blank");
  });

  it("renders directions link", () => {
    const container = document.createElement("div");
    renderDetailError(
      container,
      makeArticle({ lat: 48.8584, lon: 2.2945 }),
      "Error",
      () => {},
      () => {},
    );

    const link = container.querySelector(
      ".detail-directions-link",
    ) as HTMLAnchorElement;
    expect(link.href).toContain("48.8584");
    expect(link.href).toContain("2.2945");
    expect(link.target).toBe("_blank");
  });

  it("uses correct lang for Wikipedia URL", () => {
    const container = document.createElement("div");
    renderDetailError(
      container,
      makeArticle(),
      "Error",
      () => {},
      () => {},
      "ja",
    );

    const link = container.querySelector(
      ".detail-wiki-link",
    ) as HTMLAnchorElement;
    expect(link.href).toContain("ja.wikipedia.org");
  });
});
