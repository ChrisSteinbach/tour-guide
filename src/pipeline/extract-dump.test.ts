import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isValidCoord,
  isInBounds,
  buildPageMap,
  streamGeoArticles,
  extractDump,
} from "./extract-dump.js";
import type { Article } from "./extract-dump.js";
import { makePageDump, makeGeoDump, gzFile } from "./dump-test-fixtures.js";

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
    expect(map.get(1)).toBe("Eiffel Tower");
    expect(map.get(4)).toBe("Statue of Liberty");
    expect(map.has(2)).toBe(false);
    expect(map.has(3)).toBe(false);
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
      [100, "Eiffel Tower"],
      [200, "Statue of Liberty"],
      // 300 has no page entry — should be skipped
    ]);

    const articles = await collectArticles(streamGeoArticles(geoPath, pages));

    expect(articles).toHaveLength(2);
    expect(articles[0].title).toBe("Eiffel Tower");
    expect(articles[1].title).toBe("Statue of Liberty");
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
      [100, "Paris"],
      [200, "Moon Base"],
      [300, "London"],
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
      [100, "Paris"],
      [200, "NYC"],
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

    const pages = new Map([[100, "Null Island"]]);

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
        { id: 100, title: "Eiffeltornet" },
        { id: 200, title: "Frihetsgudinnan" },
        { id: 300, title: "Redirect_Page", redirect: 1 },
        { id: 400, title: "Liljeholmens_brandstation" },
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

    const liljeholmen = articles.find(
      (a) => a.title === "Liljeholmens brandstation",
    );
    expect(liljeholmen).toBeDefined();
    expect(liljeholmen!.lat).toBeCloseTo(59.308, 2);
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
    });

    expect(result.articleCount).toBe(1);
    const lines = readFileSync(outputPath, "utf8").trim().split("\n");
    const article = JSON.parse(lines[0]) as Article;
    expect(article.title).toBe("Stockholm");
  });

  it("deduplicates by title", async () => {
    const dumpsDir = writeDumps(
      "dumps-dedup",
      [{ id: 100, title: "Same_Place" }],
      [
        { pageId: 100, lat: 48.0, lon: 2.0 },
        { pageId: 100, lat: 49.0, lon: 3.0 },
      ],
    );

    const outputPath = join(testDir, "articles-dedup.json");

    const result = await extractDump({
      lang: "sv",
      skipDownload: true,
      dumpsDir,
      outputPath,
    });

    expect(result.articleCount).toBe(1);
  });
});
