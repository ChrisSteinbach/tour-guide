import { summaryUrl, createWikiApi } from "./wiki-api";

describe("summaryUrl", () => {
  it("encodes spaces as underscores", () => {
    expect(summaryUrl("Eiffel Tower")).toBe(
      "https://en.wikipedia.org/api/rest_v1/page/summary/Eiffel_Tower",
    );
  });

  it("encodes special characters", () => {
    expect(summaryUrl("Hôtel de Ville")).toBe(
      "https://en.wikipedia.org/api/rest_v1/page/summary/H%C3%B4tel_de_Ville",
    );
  });

  it("handles titles that are already underscored", () => {
    expect(summaryUrl("Arc_de_Triomphe")).toBe(
      "https://en.wikipedia.org/api/rest_v1/page/summary/Arc_de_Triomphe",
    );
  });

  it("defaults to English Wikipedia", () => {
    expect(summaryUrl("Test")).toContain("en.wikipedia.org");
  });

  it("uses specified language", () => {
    expect(summaryUrl("Eiffel Tower", "sv")).toBe(
      "https://sv.wikipedia.org/api/rest_v1/page/summary/Eiffel_Tower",
    );
  });
});

describe("fetchArticleSummary", () => {
  function mockFetch(response: { status: number; body?: unknown }) {
    return vi.fn().mockResolvedValue({
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: () => Promise.resolve(response.body),
    }) as unknown as typeof globalThis.fetch;
  }

  const fullResponse = {
    title: "Eiffel Tower",
    extract: "The Eiffel Tower is a wrought-iron lattice tower.",
    description: "Iron lattice tower in Paris",
    thumbnail: {
      source: "https://upload.wikimedia.org/thumb.jpg",
      width: 320,
      height: 240,
    },
    content_urls: {
      desktop: { page: "https://en.wikipedia.org/wiki/Eiffel_Tower" },
    },
  };

  it("parses a successful response", async () => {
    const fetch = mockFetch({ status: 200, body: fullResponse });
    const { fetchArticleSummary } = createWikiApi({ fetch });

    const summary = await fetchArticleSummary("Eiffel Tower");

    expect(summary).toEqual({
      title: "Eiffel Tower",
      extract: "The Eiffel Tower is a wrought-iron lattice tower.",
      description: "Iron lattice tower in Paris",
      thumbnailUrl: "https://upload.wikimedia.org/thumb.jpg",
      thumbnailWidth: 320,
      thumbnailHeight: 240,
      pageUrl: "https://en.wikipedia.org/wiki/Eiffel_Tower",
    });
  });

  it("throws on 404", async () => {
    const fetch = mockFetch({ status: 404 });
    const { fetchArticleSummary } = createWikiApi({ fetch });

    await expect(fetchArticleSummary("Nonexistent")).rejects.toThrow(
      "Article not found",
    );
  });

  it("throws on 500", async () => {
    const fetch = mockFetch({ status: 500 });
    const { fetchArticleSummary } = createWikiApi({ fetch });

    await expect(fetchArticleSummary("Anything")).rejects.toThrow(
      "Wikipedia API error: 500",
    );
  });

  it("throws on network failure", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValue(
        new TypeError("Failed to fetch"),
      ) as unknown as typeof globalThis.fetch;
    const { fetchArticleSummary } = createWikiApi({ fetch });

    await expect(fetchArticleSummary("Anything")).rejects.toThrow(
      "Failed to fetch",
    );
  });

  it("handles missing thumbnail gracefully", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { ...fullResponse, thumbnail: undefined },
    });
    const { fetchArticleSummary } = createWikiApi({ fetch });

    const summary = await fetchArticleSummary("No Thumb");

    expect(summary.thumbnailUrl).toBeNull();
    expect(summary.thumbnailWidth).toBeNull();
    expect(summary.thumbnailHeight).toBeNull();
  });

  it("handles missing description gracefully", async () => {
    const fetch = mockFetch({
      status: 200,
      body: { ...fullResponse, description: undefined },
    });
    const { fetchArticleSummary } = createWikiApi({ fetch });

    const summary = await fetchArticleSummary("No Desc");

    expect(summary.description).toBe("");
  });

  it("uses specified language for API URL", async () => {
    const fetch = mockFetch({ status: 200, body: fullResponse });
    const { fetchArticleSummary } = createWikiApi({ fetch });

    await fetchArticleSummary("Test", "sv");

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("sv.wikipedia.org"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "Api-User-Agent": expect.stringContaining("WikiRadar"),
        }),
      }),
    );
  });

  it("caches separately per language for the same title", async () => {
    const fetch = mockFetch({ status: 200, body: fullResponse });
    const { fetchArticleSummary } = createWikiApi({ fetch });

    await fetchArticleSummary("A", "en");
    await fetchArticleSummary("A", "sv");

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("en.wikipedia.org"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "Api-User-Agent": expect.stringContaining("WikiRadar"),
        }),
      }),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("sv.wikipedia.org"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "Api-User-Agent": expect.stringContaining("WikiRadar"),
        }),
      }),
    );
  });
});
