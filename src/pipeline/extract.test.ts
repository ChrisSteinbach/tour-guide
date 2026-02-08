import { parseBinding, isValidCoordinate, deduplicateArticles, extractArticles } from "./extract.js";
import type { Article } from "./extract.js";
import type { SparqlBinding, SparqlResponse } from "./sparql.js";

// ---------- Helpers ----------

function makeBinding(overrides: Partial<Record<keyof SparqlBinding, { type: string; value: string }>> = {}): SparqlBinding {
  return {
    item: { type: "uri", value: "http://www.wikidata.org/entity/Q243" },
    itemLabel: { type: "literal", value: "Eiffel Tower" },
    lat: { type: "literal", value: "48.8584" },
    lon: { type: "literal", value: "2.2945" },
    article: { type: "uri", value: "https://en.wikipedia.org/wiki/Eiffel_Tower" },
    itemDescription: { type: "literal", value: "iron lattice tower in Paris" },
    ...overrides,
  };
}

// ---------- parseBinding ----------

describe("parseBinding", () => {
  it("parses a valid binding into an Article", () => {
    const result = parseBinding(makeBinding());
    expect(result).toEqual({
      title: "Eiffel Tower",
      lat: 48.8584,
      lon: 2.2945,
      desc: "iron lattice tower in Paris",
    });
  });

  it("falls back to article URL when itemLabel is missing", () => {
    const result = parseBinding(
      makeBinding({
        itemLabel: { type: "literal", value: "" },
        article: { type: "uri", value: "https://en.wikipedia.org/wiki/Statue_of_Liberty" },
      }),
    );
    expect(result?.title).toBe("Statue of Liberty");
  });

  it("decodes percent-encoded article URLs", () => {
    const result = parseBinding(
      makeBinding({
        itemLabel: { type: "literal", value: "" },
        article: { type: "uri", value: "https://en.wikipedia.org/wiki/S%C3%A3o_Paulo" },
      }),
    );
    expect(result?.title).toBe("São Paulo");
  });

  it("returns null for missing coordinates", () => {
    const binding = makeBinding({ lat: { type: "literal", value: "abc" } });
    expect(parseBinding(binding)).toBeNull();
  });

  it("returns null for Null Island (0,0)", () => {
    const binding = makeBinding({
      lat: { type: "literal", value: "0" },
      lon: { type: "literal", value: "0" },
    });
    expect(parseBinding(binding)).toBeNull();
  });

  it("uses empty string when desc is missing", () => {
    const binding = makeBinding();
    delete (binding as unknown as Record<string, unknown>).itemDescription;
    const result = parseBinding(binding);
    expect(result?.desc).toBe("");
  });
});

// ---------- isValidCoordinate ----------

describe("isValidCoordinate", () => {
  it("accepts valid coordinates", () => {
    expect(isValidCoordinate(48.8584, 2.2945)).toBe(true);
    expect(isValidCoordinate(-33.8688, 151.2093)).toBe(true);
    expect(isValidCoordinate(90, 180)).toBe(true);
    expect(isValidCoordinate(-90, -180)).toBe(true);
  });

  it("rejects NaN", () => {
    expect(isValidCoordinate(NaN, 2.0)).toBe(false);
    expect(isValidCoordinate(48.0, NaN)).toBe(false);
  });

  it("rejects out-of-range latitude", () => {
    expect(isValidCoordinate(91, 0)).toBe(false);
    expect(isValidCoordinate(-91, 0)).toBe(false);
  });

  it("rejects out-of-range longitude", () => {
    expect(isValidCoordinate(0, 181)).toBe(false);
    expect(isValidCoordinate(0, -181)).toBe(false);
  });

  it("rejects Null Island (0,0)", () => {
    expect(isValidCoordinate(0, 0)).toBe(false);
  });

  it("accepts coordinates where only one component is zero", () => {
    expect(isValidCoordinate(0, 10)).toBe(true);
    expect(isValidCoordinate(10, 0)).toBe(true);
  });
});

// ---------- deduplicateArticles ----------

describe("deduplicateArticles", () => {
  it("removes duplicate titles, keeping first occurrence", () => {
    const articles: Article[] = [
      { title: "A", lat: 1, lon: 1, desc: "first" },
      { title: "B", lat: 2, lon: 2, desc: "unique" },
      { title: "A", lat: 3, lon: 3, desc: "second" },
    ];
    const result = deduplicateArticles(articles);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ title: "A", lat: 1, lon: 1, desc: "first" });
    expect(result[1]).toEqual({ title: "B", lat: 2, lon: 2, desc: "unique" });
  });

  it("keeps co-located articles with different titles", () => {
    const articles: Article[] = [
      { title: "Museum", lat: 48.86, lon: 2.33, desc: "" },
      { title: "Park", lat: 48.86, lon: 2.33, desc: "" },
    ];
    const result = deduplicateArticles(articles);
    expect(result).toHaveLength(2);
  });

  it("preserves order", () => {
    const articles: Article[] = [
      { title: "C", lat: 1, lon: 1, desc: "" },
      { title: "A", lat: 2, lon: 2, desc: "" },
      { title: "B", lat: 3, lon: 3, desc: "" },
    ];
    const result = deduplicateArticles(articles);
    expect(result.map((a) => a.title)).toEqual(["C", "A", "B"]);
  });

  it("is case-sensitive (matching Wikipedia)", () => {
    const articles: Article[] = [
      { title: "Turkey", lat: 1, lon: 1, desc: "country" },
      { title: "turkey", lat: 2, lon: 2, desc: "bird" },
    ];
    const result = deduplicateArticles(articles);
    expect(result).toHaveLength(2);
  });

  it("returns empty array for empty input", () => {
    expect(deduplicateArticles([])).toEqual([]);
  });
});

// ---------- extractArticles ----------

describe("extractArticles", () => {
  function makeSparqlResponse(bindings: SparqlBinding[]): SparqlResponse {
    return { results: { bindings } };
  }

  // Use explicit bounds so tests exercise single-region pagination, not global tiling
  const testBounds = { south: 40, north: 50, west: 0, east: 10 };

  function mockOk(data: SparqlResponse) {
    return { ok: true, text: () => Promise.resolve(JSON.stringify(data)) };
  }

  it("fetches batches until empty result", async () => {
    const batch1 = [makeBinding(), makeBinding({ itemLabel: { type: "literal", value: "Louvre" } })];
    const batch2: SparqlBinding[] = [];

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(mockOk(makeSparqlResponse(batch1)))
      .mockResolvedValueOnce(mockOk(makeSparqlResponse(batch2)));

    const result = await extractArticles({
      endpoint: "https://example.org/sparql",
      batchSize: 2, // equals batch1.length so the loop continues to fetch batch2
      bounds: testBounds,
      fetchFn: mockFetch,
    });

    expect(result).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("stops early when batch returns fewer results than batchSize", async () => {
    const batch = [makeBinding()];

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(mockOk(makeSparqlResponse(batch)));

    const result = await extractArticles({
      endpoint: "https://example.org/sparql",
      batchSize: 100,
      bounds: testBounds,
      fetchFn: mockFetch,
    });

    expect(result).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("calls onBatch callback with progress info", async () => {
    const batch = [makeBinding()];
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(mockOk(makeSparqlResponse(batch)));

    const batches: { batch: number; articlesInBatch: number; totalSoFar: number }[] = [];

    await extractArticles({
      endpoint: "https://example.org/sparql",
      batchSize: 100,
      bounds: testBounds,
      fetchFn: mockFetch,
      onBatch: (info) => batches.push(info),
    });

    expect(batches).toEqual([{ batch: 1, articlesInBatch: 1, totalSoFar: 1 }]);
  });

  it("deduplicates across batches", async () => {
    // Two batches with the same article title
    const binding = makeBinding();
    const batchSize = 1;

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(mockOk(makeSparqlResponse([binding])))
      .mockResolvedValueOnce(mockOk(makeSparqlResponse([binding])))
      .mockResolvedValueOnce(mockOk(makeSparqlResponse([])));

    const result = await extractArticles({
      endpoint: "https://example.org/sparql",
      batchSize,
      bounds: testBounds,
      fetchFn: mockFetch,
    });

    expect(result).toHaveLength(1);
  });

  it("retries on 500 and succeeds", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: "Internal Server Error", text: () => Promise.resolve("") })
      .mockResolvedValueOnce(mockOk(makeSparqlResponse([makeBinding()])));

    const result = await extractArticles({
      endpoint: "https://example.org/sparql",
      batchSize: 100,
      bounds: testBounds,
      fetchFn: mockFetch,
      maxRetries: 3,
    });

    expect(result).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("fails immediately on 403", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden", text: () => Promise.resolve("Blocked") });

    await expect(
      extractArticles({
        endpoint: "https://example.org/sparql",
        batchSize: 100,
        bounds: testBounds,
        fetchFn: mockFetch,
        maxRetries: 3,
      }),
    ).rejects.toThrow("403");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("tiles the globe into geographic tiles when no bounds provided", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValue(mockOk(makeSparqlResponse([])));

    await extractArticles({
      endpoint: "https://example.org/sparql",
      batchSize: 100,
      fetchFn: mockFetch,
      tileDelayMs: 0,
    });

    // 18 lat bands × 36 lon bands = 648 tiles, each gets one query returning empty
    expect(mockFetch).toHaveBeenCalledTimes(648);
  });
});
