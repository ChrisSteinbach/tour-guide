import { buildQuery, executeSparql, SparqlError } from "./sparql.js";

describe("buildQuery", () => {
  it("produces SPARQL with correct LIMIT and OFFSET", () => {
    const query = buildQuery({ limit: 1000, offset: 5000 });
    expect(query).toContain("LIMIT 1000");
    expect(query).toContain("OFFSET 5000");
  });

  it("includes ORDER BY ?item for deterministic pagination", () => {
    const query = buildQuery({ limit: 100, offset: 0 });
    expect(query).toContain("ORDER BY ?item");
  });

  it("omits FILTER clause when no bounds provided", () => {
    const query = buildQuery({ limit: 100, offset: 0 });
    expect(query).not.toMatch(/FILTER\(\?lat/);
  });

  it("adds lat/lon FILTER clause when bounds provided", () => {
    const query = buildQuery({
      limit: 100,
      offset: 0,
      bounds: { south: 49.44, north: 50.19, west: 5.73, east: 6.53 },
    });
    expect(query).toContain("FILTER(?lat >= 49.44 && ?lat <= 50.19");
    expect(query).toContain("?lon >= 5.73 && ?lon <= 6.53)");
  });

  it("queries English Wikipedia articles with P625 coordinates", () => {
    const query = buildQuery({ limit: 100, offset: 0 });
    expect(query).toContain("wdt:P625");
    expect(query).toContain("en.wikipedia.org");
    expect(query).toContain('FILTER(LANG(?itemLabel) = "en")');
  });
});

describe("executeSparql", () => {
  it("sends correct URL, headers, and returns parsed JSON", async () => {
    const mockResponse = {
      results: { bindings: [{ item: { type: "uri", value: "http://example.org/Q123" } }] },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
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
      json: () => Promise.resolve({ results: { bindings: [] } }),
    });

    await executeSparql("SELECT ?x WHERE { }", "https://example.org/sparql", mockFetch);
    expect(mockFetch.mock.calls[0][1].method).toBe("GET");
  });
});
