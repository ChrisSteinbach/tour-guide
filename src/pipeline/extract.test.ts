import { parseBinding, isValidCoordinate, deduplicateArticles, extractArticles, subdivideTile, generateTiles } from "./extract.js";
import type { Article, ExtractResult } from "./extract.js";
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

  it("prefers article URL title over Wikidata label", () => {
    const result = parseBinding(
      makeBinding({
        itemLabel: { type: "literal", value: "Östuna church" },
        article: { type: "uri", value: "https://en.wikipedia.org/wiki/%C3%96stuna_Church" },
      }),
    );
    expect(result?.title).toBe("Östuna Church");
  });

  it("falls back to Wikidata label when article URL is missing", () => {
    const binding = makeBinding();
    delete (binding as unknown as Record<string, unknown>).article;
    const result = parseBinding(binding);
    expect(result?.title).toBe("Eiffel Tower");
  });

  it("decodes percent-encoded article URLs", () => {
    const result = parseBinding(
      makeBinding({
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

// ---------- subdivideTile ----------

describe("subdivideTile", () => {
  it("splits a tile into 4 quadrants", () => {
    const tile = { south: 40, north: 50, west: 0, east: 10 };
    const subs = subdivideTile(tile);
    expect(subs).toHaveLength(4);
    expect(subs).toEqual([
      { south: 40, north: 45, west: 0, east: 5 },
      { south: 40, north: 45, west: 5, east: 10 },
      { south: 45, north: 50, west: 0, east: 5 },
      { south: 45, north: 50, west: 5, east: 10 },
    ]);
  });

  it("preserves total area coverage", () => {
    const tile = { south: -10, north: 10, west: 170, east: 180 };
    const subs = subdivideTile(tile);
    const originalArea = (tile.north - tile.south) * (tile.east - tile.west);
    const subArea = subs.reduce((sum, s) => sum + (s.north - s.south) * (s.east - s.west), 0);
    expect(subArea).toBe(originalArea);
  });
});

// ---------- generateTiles ----------

describe("generateTiles", () => {
  it("generates 648 tiles at default 10×10 degree size", () => {
    const tiles = generateTiles();
    // 18 lat bands × 36 lon bands = 648 tiles
    expect(tiles).toHaveLength(648);
  });

  it("covers full globe without gaps", () => {
    const tiles = generateTiles();
    expect(tiles[0].south).toBe(-90);
    expect(tiles[tiles.length - 1].north).toBe(90);
    expect(tiles[0].west).toBe(-180);
    expect(tiles[tiles.length - 1].east).toBe(180);
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

  function mock500() {
    return { ok: false, status: 500, statusText: "Internal Server Error", text: () => Promise.resolve("") };
  }

  it("fetches batches until empty result", async () => {
    const batch1 = [makeBinding(), makeBinding({
      itemLabel: { type: "literal", value: "Louvre" },
      article: { type: "uri", value: "https://en.wikipedia.org/wiki/Louvre" },
    })];
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

    expect(result.articles).toHaveLength(2);
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

    expect(result.articles).toHaveLength(1);
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

    expect(result.articles).toHaveLength(1);
  });

  it("retries on 500 and succeeds", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(mock500())
      .mockResolvedValueOnce(mockOk(makeSparqlResponse([makeBinding()])));

    const result = await extractArticles({
      endpoint: "https://example.org/sparql",
      batchSize: 100,
      bounds: testBounds,
      fetchFn: mockFetch,
      maxRetries: 3,
    });

    expect(result.articles).toHaveLength(1);
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

  it("subdivides a failed tile and retries sub-tiles", async () => {
    // Parent tile (10°×10°) fails, but each 5°×5° sub-tile succeeds
    const binding = makeBinding();
    let callCount = 0;

    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call (parent tile) fails after retries
        return Promise.resolve(mock500());
      }
      // Sub-tile calls succeed with empty results (except one)
      if (callCount === 2) {
        return Promise.resolve(mockOk(makeSparqlResponse([binding])));
      }
      return Promise.resolve(mockOk(makeSparqlResponse([])));
    });

    const result = await extractArticles({
      endpoint: "https://example.org/sparql",
      batchSize: 100,
      bounds: testBounds,
      fetchFn: mockFetch,
      maxRetries: 1, // Fail after 1 attempt to trigger subdivision
      tileDelayMs: 0,
    });

    expect(result.articles).toHaveLength(1);
    expect(result.leafTiles).toHaveLength(4);
    // 1 failed parent + 4 sub-tiles = 5 calls
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it("recursively subdivides through multiple levels", async () => {
    // Use a 1°×1° tile (just above MIN_TILE_DEG of 0.3°)
    // that fails, subdivides to 0.5°×0.5°, those succeed
    const smallBounds = { south: 40, north: 41, west: 0, east: 1 };
    let callCount = 0;

    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Parent 1°×1° fails
        return Promise.resolve(mock500());
      }
      if (callCount === 2) {
        // First 0.5°×0.5° sub-tile also fails
        return Promise.resolve(mock500());
      }
      // All 0.25°×0.25° sub-sub-tiles and remaining 0.5°×0.5° tiles succeed empty
      return Promise.resolve(mockOk(makeSparqlResponse([])));
    });

    const result = await extractArticles({
      endpoint: "https://example.org/sparql",
      batchSize: 100,
      bounds: smallBounds,
      fetchFn: mockFetch,
      maxRetries: 1,
      tileDelayMs: 0,
    });

    // 1 failed parent + (1 failed sub + 4 sub-sub-tiles) + 3 successful sub-tiles = 9
    expect(mockFetch).toHaveBeenCalledTimes(9);
    expect(result.leafTiles).toHaveLength(7); // 4 sub-sub-tiles + 3 sub-tiles
    expect(result.failedTiles).toHaveLength(0); // all succeeded at 0.25° level
  });

  it("reports failed tiles at minimum subdivision size", async () => {
    // Use a 0.5°×0.5° tile — can subdivide once to 0.25° (below MIN_TILE_DEG of 0.3°)
    const tinyBounds = { south: 48, north: 48.5, west: 2, east: 2.5 };

    const mockFetch = vi.fn()
      .mockResolvedValue(mock500());

    const result = await extractArticles({
      endpoint: "https://example.org/sparql",
      batchSize: 100,
      bounds: tinyBounds,
      fetchFn: mockFetch,
      maxRetries: 1,
      tileDelayMs: 0,
    });

    // Parent 0.5° fails → subdivides to 4 × 0.25° → all fail at min size
    expect(result.articles).toHaveLength(0);
    expect(result.leafTiles).toHaveLength(0);
    expect(result.failedTiles).toHaveLength(4);
  });

  it("uses explicit regions when provided", async () => {
    const customRegions = [
      { south: 48, north: 49, west: 2, east: 3 },
      { south: 40, north: 41, west: -74, east: -73 },
    ];

    const mockFetch = vi.fn()
      .mockResolvedValue(mockOk(makeSparqlResponse([])));

    await extractArticles({
      endpoint: "https://example.org/sparql",
      batchSize: 100,
      regions: customRegions,
      fetchFn: mockFetch,
      tileDelayMs: 0,
    });

    // One query per region (both return empty)
    expect(mockFetch).toHaveBeenCalledTimes(2);
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

  it("calls onRegionComplete after each top-level region", async () => {
    const region1 = { south: 48, north: 49, west: 2, east: 3 };
    const region2 = { south: 40, north: 41, west: -74, east: -73 };
    const binding1 = makeBinding();
    const binding2 = makeBinding({
      itemLabel: { type: "literal", value: "Statue of Liberty" },
      article: { type: "uri", value: "https://en.wikipedia.org/wiki/Statue_of_Liberty" },
      lat: { type: "literal", value: "40.6892" },
      lon: { type: "literal", value: "-74.0445" },
    });

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(mockOk(makeSparqlResponse([binding1])))
      .mockResolvedValueOnce(mockOk(makeSparqlResponse([binding2])));

    const calls: { region: typeof region1; articles: Article[]; leafTiles: typeof region1[]; failedTiles: typeof region1[] }[] = [];

    await extractArticles({
      endpoint: "https://example.org/sparql",
      batchSize: 100,
      regions: [region1, region2],
      fetchFn: mockFetch,
      tileDelayMs: 0,
      onRegionComplete: (info) => { calls.push(info); },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].region).toEqual(region1);
    expect(calls[0].articles).toHaveLength(1);
    expect(calls[0].articles[0].title).toBe("Eiffel Tower");
    expect(calls[0].leafTiles).toHaveLength(1);
    expect(calls[1].region).toEqual(region2);
    expect(calls[1].articles).toHaveLength(1);
    expect(calls[1].articles[0].title).toBe("Statue of Liberty");
  });

  it("does not break existing behavior when onRegionComplete is not provided", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(mockOk(makeSparqlResponse([makeBinding()])));

    const result = await extractArticles({
      endpoint: "https://example.org/sparql",
      batchSize: 100,
      bounds: testBounds,
      fetchFn: mockFetch,
    });

    expect(result.articles).toHaveLength(1);
    expect(result.leafTiles).toHaveLength(1);
  });

  it("includes failed tiles in onRegionComplete callback", async () => {
    const tinyBounds = { south: 48, north: 48.5, west: 2, east: 2.5 };

    const mockFetch = vi.fn().mockResolvedValue(mock500());

    const calls: { failedTiles: typeof tinyBounds[] }[] = [];

    await extractArticles({
      endpoint: "https://example.org/sparql",
      batchSize: 100,
      regions: [tinyBounds],
      fetchFn: mockFetch,
      maxRetries: 1,
      tileDelayMs: 0,
      onRegionComplete: (info) => { calls.push({ failedTiles: info.failedTiles }); },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].failedTiles).toHaveLength(4);
  });
});
