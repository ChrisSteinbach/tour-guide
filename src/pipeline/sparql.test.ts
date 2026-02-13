import { buildQuery, executeSparql, SparqlError } from "./sparql.js";

describe("buildQuery", () => {
  const defaultBounds = { south: 40, north: 50, west: 0, east: 10 };

  it("produces SPARQL with correct LIMIT and OFFSET", () => {
    const query = buildQuery({ limit: 1000, offset: 5000, bounds: defaultBounds });
    expect(query).toContain("LIMIT 1000");
    expect(query).toContain("OFFSET 5000");
  });

  it("uses wikibase:box service with correct corners", () => {
    const query = buildQuery({
      limit: 100,
      offset: 0,
      bounds: { south: 49.44, north: 50.19, west: 5.73, east: 6.53 },
    });
    expect(query).toContain("SERVICE wikibase:box");
    expect(query).toContain("Point(5.73 49.44)");
    expect(query).toContain("Point(6.53 50.19)");
  });

  it("queries English Wikipedia articles with P625 coordinates via label service", () => {
    const query = buildQuery({ limit: 100, offset: 0, bounds: defaultBounds });
    expect(query).toContain("wdt:P625");
    expect(query).toContain("en.wikipedia.org");
    expect(query).toContain("SERVICE wikibase:label");
  });

  it("does not include ORDER BY", () => {
    const query = buildQuery({ limit: 100, offset: 0, bounds: defaultBounds });
    expect(query).not.toContain("ORDER BY");
  });

  it("defaults to English Wikipedia when lang is not specified", () => {
    const query = buildQuery({ limit: 100, offset: 0, bounds: defaultBounds });
    expect(query).toContain("en.wikipedia.org");
    expect(query).toContain('"en"');
  });

  it("uses specified language for Wikipedia and labels", () => {
    const query = buildQuery({ limit: 100, offset: 0, bounds: defaultBounds, lang: "sv" });
    expect(query).toContain("sv.wikipedia.org");
    expect(query).toContain('"sv"');
    expect(query).not.toContain("en.wikipedia.org");
  });

  it("supports Japanese", () => {
    const query = buildQuery({ limit: 100, offset: 0, bounds: defaultBounds, lang: "ja" });
    expect(query).toContain("ja.wikipedia.org");
    expect(query).toContain('"ja"');
  });
});

describe("executeSparql", () => {
  it("sends correct URL, headers, and returns parsed JSON", async () => {
    const mockResponse = {
      results: { bindings: [{ item: { type: "uri", value: "http://example.org/Q123" } }] },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(mockResponse)),
    });

    const result = await executeSparql("SELECT ?x WHERE { }", "https://example.org/sparql", mockFetch);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("https://example.org/sparql?query=");
    expect(url).toContain(encodeURIComponent("SELECT ?x WHERE { }"));
    expect(options.headers.Accept).toBe("application/sparql-results+json");
    expect(options.headers["User-Agent"]).toContain("tour-guide");
    expect(result).toEqual(mockResponse);
  });

  it("throws SparqlError with status on HTTP failure", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: () => Promise.resolve("Access denied"),
    });

    await expect(
      executeSparql("SELECT ?x WHERE { }", "https://example.org/sparql", mockFetch),
    ).rejects.toThrow(SparqlError);

    try {
      await executeSparql("SELECT ?x WHERE { }", "https://example.org/sparql", mockFetch);
    } catch (e) {
      expect(e).toBeInstanceOf(SparqlError);
      expect((e as SparqlError).status).toBe(403);
      expect((e as SparqlError).body).toBe("Access denied");
    }
  });

  it("uses GET method", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ results: { bindings: [] } })),
    });

    await executeSparql("SELECT ?x WHERE { }", "https://example.org/sparql", mockFetch);
    expect(mockFetch.mock.calls[0][1].method).toBe("GET");
  });
});
