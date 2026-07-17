import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isValidCoord,
  isInBounds,
  parseBounds,
  buildPageMap,
  streamGeoArticles,
  extractDump,
} from "./extract-dump.js";
import type { Article } from "./extract-dump.js";
import {
  makePageDump,
  makeGeoDump,
  makeViewsFile,
  gzFile,
} from "./dump-test-fixtures.js";

// --- Shared test infrastructure ---

const testDir = join(tmpdir(), "extract-dump-test-" + Date.now());

beforeAll(() => mkdirSync(testDir, { recursive: true }));
afterAll(() => rmSync(testDir, { recursive: true, force: true }));

async function collectArticles(
  stream: AsyncGenerator<Article>,
): Promise<Article[]> {
  const articles: Article[] = [];
  for await (const article of stream) articles.push(article);
  return articles;
}

// ---------- Unit: coordinate validation ----------

describe("isValidCoord", () => {
  it("accepts valid coordinates", () => {
    expect(isValidCoord(48.8584, 2.2945)).toBe(true);
    expect(isValidCoord(-33.8688, 151.2093)).toBe(true);
  });

  it("rejects Null Island (0,0)", () => {
    expect(isValidCoord(0, 0)).toBe(false);
  });

  it("rejects NaN", () => {
    expect(isValidCoord(NaN, 2.0)).toBe(false);
    expect(isValidCoord(48.0, NaN)).toBe(false);
  });

  it("rejects out-of-range latitude", () => {
    expect(isValidCoord(91, 0)).toBe(false);
    expect(isValidCoord(-91, 0)).toBe(false);
  });

  it("rejects out-of-range longitude", () => {
    expect(isValidCoord(0.1, 181)).toBe(false);
    expect(isValidCoord(0.1, -181)).toBe(false);
  });

  it("accepts boundary values", () => {
    expect(isValidCoord(90, 180)).toBe(true);
    expect(isValidCoord(-90, -180)).toBe(true);
  });
});

describe("isInBounds", () => {
  const europe = { south: 35, north: 72, west: -25, east: 45 };

  it("returns true for coordinates inside bounds", () => {
    expect(isInBounds(48.8584, 2.2945, europe)).toBe(true);
  });

  it("returns false for coordinates outside bounds", () => {
    expect(isInBounds(40.7128, -74.006, europe)).toBe(false);
  });

  it("includes coordinates on the boundary", () => {
    expect(isInBounds(35, -25, europe)).toBe(true);
    expect(isInBounds(72, 45, europe)).toBe(true);
  });
});

// ---------- Unit: parseBounds ----------

describe("parseBounds", () => {
  it("parses valid west,south,east,north string", () => {
    expect(parseBounds("5.73,49.44,6.53,50.19")).toEqual({
      south: 49.44,
      north: 50.19,
      west: 5.73,
      east: 6.53,
    });
  });

  it("rejects non-numeric values", () => {
    expect(() => parseBounds("a,b,c,d")).toThrow("Invalid bounds");
  });

  it("rejects wrong number of parts", () => {
    expect(() => parseBounds("1,2,3")).toThrow("Invalid bounds");
    expect(() => parseBounds("1,2,3,4,5")).toThrow("Invalid bounds");
  });

  it("rejects NaN and Infinity", () => {
    expect(() => parseBounds("NaN,1,2,3")).toThrow("Invalid bounds");
    expect(() => parseBounds("1,Infinity,2,3")).toThrow("Invalid bounds");
  });
});

// ---------- Unit: buildPageMap ----------

describe("buildPageMap", () => {
  it("keeps articles, filters redirects and non-article namespaces", async () => {
    const path = gzFile(
      testDir,
      "page.sql.gz",
      makePageDump([
        { id: 1, title: "Eiffel_Tower" },
        { id: 2, title: "Tour_Eiffel", redirect: 1 },
        { id: 3, title: "Category:Towers", ns: 14 },
        { id: 4, title: "Statue_of_Liberty" },
      ]),
    );

    const map = await buildPageMap(path);

    expect(map.size).toBe(2);
    expect(map.get(1)?.title).toBe("Eiffel Tower");
    expect(map.get(4)?.title).toBe("Statue of Liberty");
    expect(map.has(2)).toBe(false);
    expect(map.has(3)).toBe(false);
  });

  it("ignores the page_len column present in real dumps", async () => {
    const path = gzFile(
      testDir,
      "page-len-present.sql.gz",
      makePageDump([{ id: 1, title: "Eiffel_Tower", len: 2048 }]),
    );

    const map = await buildPageMap(path);

    expect(map.get(1)).toEqual({ title: "Eiffel Tower" });
  });
});

// ---------- Unit: streamGeoArticles ----------

describe("streamGeoArticles", () => {
  it("joins geo_tags with page map", async () => {
    const geoPath = gzFile(
      testDir,
      "geo_tags.sql.gz",
      makeGeoDump([
        { pageId: 100, lat: 48.8584, lon: 2.2945 },
        { pageId: 200, lat: 40.7128, lon: -74.006 },
        { pageId: 300, lat: 51.5074, lon: -0.1278 },
      ]),
    );

    const pages = new Map([
      [100, { title: "Eiffel Tower" }],
      [200, { title: "Statue of Liberty" }],
      // 300 has no page entry — should be skipped
    ]);

    const articles = await collectArticles(streamGeoArticles(geoPath, pages));

    expect(articles).toHaveLength(2);
    expect(articles[0].title).toBe("Eiffel Tower");
    expect(articles[1].title).toBe("Statue of Liberty");
  });

  it("carries page views onto joined articles and omits it when unknown", async () => {
    const geoPath = gzFile(
      testDir,
      "geo_tags_views.sql.gz",
      makeGeoDump([
        { pageId: 100, lat: 48.8584, lon: 2.2945 },
        { pageId: 200, lat: 40.7128, lon: -74.006 },
      ]),
    );

    const pages = new Map([
      [100, { title: "Eiffel Tower", views: 512345 }],
      [200, { title: "Statue of Liberty" }], // no pageviews joined
    ]);

    const articles = await collectArticles(streamGeoArticles(geoPath, pages));

    expect(articles[0].views).toBe(512345);
    expect(articles[1]).not.toHaveProperty("views");
  });

  it("filters non-earth globes and non-primary tags", async () => {
    const geoPath = gzFile(
      testDir,
      "geo_tags_filter.sql.gz",
      makeGeoDump([
        { pageId: 100, lat: 48.8584, lon: 2.2945 },
        { pageId: 200, lat: 10.0, lon: 20.0, globe: "moon" },
        { pageId: 300, lat: 51.5074, lon: -0.1278, primary: 0 },
      ]),
    );

    const pages = new Map([
      [100, { title: "Paris" }],
      [200, { title: "Moon Base" }],
      [300, { title: "London" }],
    ]);

    const articles = await collectArticles(streamGeoArticles(geoPath, pages));

    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("Paris");
  });

  it("filters by bounds", async () => {
    const geoPath = gzFile(
      testDir,
      "geo_tags_bounds.sql.gz",
      makeGeoDump([
        { pageId: 100, lat: 48.8584, lon: 2.2945 },
        { pageId: 200, lat: 40.7128, lon: -74.006 },
      ]),
    );

    const pages = new Map([
      [100, { title: "Paris" }],
      [200, { title: "NYC" }],
    ]);

    const articles = await collectArticles(
      streamGeoArticles(geoPath, pages, {
        bounds: { south: 45, north: 55, west: -5, east: 10 },
      }),
    );

    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("Paris");
  });

  it("rejects Null Island coordinates", async () => {
    const geoPath = gzFile(
      testDir,
      "geo_tags_null_island.sql.gz",
      makeGeoDump([{ pageId: 100, lat: 0, lon: 0 }]),
    );

    const pages = new Map([[100, { title: "Null Island" }]]);

    const articles = await collectArticles(streamGeoArticles(geoPath, pages));

    expect(articles).toHaveLength(0);
  });
});

// ---------- Integration: extractDump ----------

describe("extractDump", () => {
  function writeDumps(
    subdir: string,
    pages: Parameters<typeof makePageDump>[0],
    geos: Parameters<typeof makeGeoDump>[0],
  ): string {
    const dumpsDir = join(testDir, subdir);
    mkdirSync(dumpsDir, { recursive: true });
    gzFile(dumpsDir, "svwiki-latest-page.sql.gz", makePageDump(pages));
    gzFile(dumpsDir, "svwiki-latest-geo_tags.sql.gz", makeGeoDump(geos));
    return dumpsDir;
  }

  it("runs full extraction pipeline with fixture dumps", async () => {
    const dumpsDir = writeDumps(
      "dumps",
      [
        { id: 100, title: "Eiffeltornet", len: 2048 },
        { id: 200, title: "Frihetsgudinnan" },
        { id: 300, title: "Redirect_Page", redirect: 1 },
        { id: 400, title: "Liljeholmens_brandstation", len: "garbage" },
      ],
      [
        { pageId: 100, lat: 48.8584, lon: 2.2945 },
        { pageId: 200, lat: 40.7128, lon: -74.006 },
        { pageId: 300, lat: 51.5, lon: -0.1 },
        { pageId: 400, lat: 59.308, lon: 18.028 },
        { pageId: 999, lat: 0, lon: 0 },
      ],
    );

    const outputPath = join(testDir, "articles-sv.json");

    const result = await extractDump({
      lang: "sv",
      skipDownload: true,
      dumpsDir,
      outputPath,
      pageviews: false,
    });

    expect(result.articleCount).toBe(3);
    expect(result.outputPath).toBe(outputPath);

    const articles = readFileSync(outputPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Article);

    expect(articles).toHaveLength(3);

    const eiffel = articles.find((a) => a.title === "Eiffeltornet");
    expect(eiffel).toBeDefined();
    expect(eiffel!.lat).toBeCloseTo(48.8584, 3);
    expect(eiffel).not.toHaveProperty("len");

    const liljeholmen = articles.find(
      (a) => a.title === "Liljeholmens brandstation",
    );
    expect(liljeholmen).toBeDefined();
    expect(liljeholmen!.lat).toBeCloseTo(59.308, 2);
    expect(liljeholmen).not.toHaveProperty("len");
  });

  it("respects bounds filtering", async () => {
    const dumpsDir = writeDumps(
      "dumps-bounds",
      [
        { id: 100, title: "Paris" },
        { id: 200, title: "Stockholm" },
      ],
      [
        { pageId: 100, lat: 48.8584, lon: 2.2945 },
        { pageId: 200, lat: 59.33, lon: 18.07 },
      ],
    );

    const outputPath = join(testDir, "articles-bounds.json");

    const result = await extractDump({
      lang: "sv",
      bounds: { south: 55, north: 65, west: 10, east: 25 },
      skipDownload: true,
      dumpsDir,
      outputPath,
      pageviews: false,
    });

    expect(result.articleCount).toBe(1);
    const lines = readFileSync(outputPath, "utf8").trim().split("\n");
    const article = JSON.parse(lines[0]) as Article;
    expect(article.title).toBe("Stockholm");
  });

  it("deduplicates by title", async () => {
    const dumpsDir = writeDumps(
      "dumps-dedup",
      [
        { id: 100, title: "Same_Place" },
        { id: 200, title: "Eiffeltornet" },
      ],
      [
        { pageId: 100, lat: 48.0, lon: 2.0 },
        { pageId: 100, lat: 49.0, lon: 3.0 },
        { pageId: 200, lat: 48.8584, lon: 2.2945 },
      ],
    );

    const outputPath = join(testDir, "articles-dedup.json");

    const result = await extractDump({
      lang: "sv",
      skipDownload: true,
      dumpsDir,
      outputPath,
      pageviews: false,
    });

    // Same_Place deduped to 1, plus Eiffeltornet (canary landmark)
    expect(result.articleCount).toBe(2);
  });

  describe("pageviews join", () => {
    it("joins views onto matching articles by page_id and leaves the rest unset", async () => {
      const dumpsDir = writeDumps(
        "dumps-views",
        [
          { id: 100, title: "Eiffeltornet" },
          { id: 200, title: "Frihetsgudinnan" },
        ],
        [
          { pageId: 100, lat: 48.8584, lon: 2.2945 },
          { pageId: 200, lat: 40.7128, lon: -74.006 },
        ],
      );

      const pageviewsDir = join(testDir, "views-basic");
      mkdirSync(pageviewsDir, { recursive: true });
      makeViewsFile(pageviewsDir, "sv", "2026-06", [
        { pageId: 100, views: 512345 },
      ]);

      const outputPath = join(testDir, "articles-views-basic.json");
      await extractDump({
        lang: "sv",
        skipDownload: true,
        dumpsDir,
        outputPath,
        pageviewsDir,
      });

      const articles = readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Article);

      const eiffel = articles.find((a) => a.title === "Eiffeltornet");
      const statue = articles.find((a) => a.title === "Frihetsgudinnan");

      expect(eiffel!.views).toBe(512345);
      expect(statue).not.toHaveProperty("views");
      expect(eiffel).not.toHaveProperty("len");
    });

    it("sums duplicate view rows for the same page_id", async () => {
      const dumpsDir = writeDumps(
        "dumps-views-dup",
        [{ id: 100, title: "Eiffeltornet" }],
        [{ pageId: 100, lat: 48.8584, lon: 2.2945 }],
      );

      const pageviewsDir = join(testDir, "views-dup");
      mkdirSync(pageviewsDir, { recursive: true });
      makeViewsFile(pageviewsDir, "sv", "2026-06", [
        { pageId: 100, views: 300 },
        { pageId: 100, views: 200 },
      ]);

      const outputPath = join(testDir, "articles-views-dup.json");
      await extractDump({
        lang: "sv",
        skipDownload: true,
        dumpsDir,
        outputPath,
        pageviewsDir,
      });

      const [article] = readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Article);

      expect(article.views).toBe(500);
    });

    it("emits no views and does not throw when pageviews is disabled", async () => {
      const dumpsDir = writeDumps(
        "dumps-views-disabled",
        [{ id: 100, title: "Eiffeltornet" }],
        [{ pageId: 100, lat: 48.8584, lon: 2.2945 }],
      );

      const outputPath = join(testDir, "articles-views-disabled.json");
      const result = await extractDump({
        lang: "sv",
        skipDownload: true,
        dumpsDir,
        outputPath,
        pageviews: false,
      });

      expect(result.articleCount).toBe(1);
      const [article] = readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Article);
      expect(article).not.toHaveProperty("views");
    });

    it("rejects with an actionable message when skipDownload is set and no views file exists", async () => {
      const dumpsDir = writeDumps(
        "dumps-views-missing",
        [{ id: 100, title: "Eiffeltornet" }],
        [{ pageId: 100, lat: 48.8584, lon: 2.2945 }],
      );

      await expect(
        extractDump({
          lang: "sv",
          skipDownload: true,
          dumpsDir,
          outputPath: join(testDir, "articles-views-missing.json"),
          pageviewsDir: join(testDir, "views-nonexistent"),
        }),
      ).rejects.toThrow(/--no-pageviews/);
    });

    it("joins from an existing views file under skipDownload without downloading", async () => {
      const dumpsDir = writeDumps(
        "dumps-views-offline",
        [{ id: 100, title: "Eiffeltornet" }],
        [{ pageId: 100, lat: 48.8584, lon: 2.2945 }],
      );

      const pageviewsDir = join(testDir, "views-offline");
      mkdirSync(pageviewsDir, { recursive: true });
      makeViewsFile(pageviewsDir, "sv", "2026-06", [
        { pageId: 100, views: 42 },
      ]);

      const outputPath = join(testDir, "articles-views-offline.json");
      const fetchFn = (async () => {
        throw new Error(
          "fetchFn should not be called when a views file already exists",
        );
      }) as unknown as typeof fetch;

      await extractDump({
        lang: "sv",
        skipDownload: true,
        dumpsDir,
        outputPath,
        pageviewsDir,
        fetchFn,
      });

      const [article] = readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Article);
      expect(article.views).toBe(42);
    });

    it("honors an explicit pageviews month under skipDownload instead of the newest file", async () => {
      const dumpsDir = writeDumps(
        "dumps-views-month",
        [{ id: 100, title: "Eiffeltornet" }],
        [{ pageId: 100, lat: 48.8584, lon: 2.2945 }],
      );

      const pageviewsDir = join(testDir, "views-month");
      mkdirSync(pageviewsDir, { recursive: true });
      makeViewsFile(pageviewsDir, "sv", "2026-05", [
        { pageId: 100, views: 111 },
      ]);
      makeViewsFile(pageviewsDir, "sv", "2026-06", [
        { pageId: 100, views: 999 },
      ]);

      const outputPath = join(testDir, "articles-views-month.json");
      await extractDump({
        lang: "sv",
        skipDownload: true,
        dumpsDir,
        outputPath,
        pageviewsDir,
        pageviewsMonth: "2026-05",
      });

      const [article] = readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Article);
      expect(article.views).toBe(111);
    });

    it("rejects when the requested pageviews month has no file under skipDownload", async () => {
      const dumpsDir = writeDumps(
        "dumps-views-month-missing",
        [{ id: 100, title: "Eiffeltornet" }],
        [{ pageId: 100, lat: 48.8584, lon: 2.2945 }],
      );

      const pageviewsDir = join(testDir, "views-month-missing");
      mkdirSync(pageviewsDir, { recursive: true });
      makeViewsFile(pageviewsDir, "sv", "2026-06", [
        { pageId: 100, views: 999 },
      ]);

      await expect(
        extractDump({
          lang: "sv",
          skipDownload: true,
          dumpsDir,
          outputPath: join(testDir, "articles-views-month-missing.json"),
          pageviewsDir,
          pageviewsMonth: "2026-04",
        }),
      ).rejects.toThrow(/2026-04/);
    });
  });
});
