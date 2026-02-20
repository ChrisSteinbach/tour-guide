import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildPageMap,
  streamGeoArticles,
  extractDump,
} from "./extract-dump.js";
import type { Article } from "./extract-dump.js";

// ---------- Fixture helpers ----------

function gzFile(dir: string, name: string, sql: string): string {
  const path = join(dir, name);
  writeFileSync(path, gzipSync(Buffer.from(sql, "utf8")));
  return path;
}

const PAGE_SCHEMA = [
  "CREATE TABLE `page` (",
  "  `page_id` int(8) unsigned NOT NULL AUTO_INCREMENT,",
  "  `page_namespace` int(11) NOT NULL DEFAULT '0',",
  "  `page_title` varbinary(255) NOT NULL DEFAULT '',",
  "  `page_is_redirect` tinyint(1) unsigned NOT NULL DEFAULT '0',",
  "  `page_is_new` tinyint(1) unsigned NOT NULL DEFAULT '0',",
  "  `page_random` double unsigned NOT NULL DEFAULT '0',",
  "  `page_touched` varbinary(14) NOT NULL DEFAULT '',",
  "  `page_links_updated` varbinary(14) DEFAULT NULL,",
  "  `page_latest` int(8) unsigned NOT NULL DEFAULT '0',",
  "  `page_len` int(8) unsigned NOT NULL DEFAULT '0',",
  "  `page_content_model` varbinary(32) DEFAULT NULL,",
  "  `page_lang` varbinary(35) DEFAULT NULL,",
  "  PRIMARY KEY (`page_id`)",
  ") ENGINE=InnoDB;",
].join("\n");

const GEO_SCHEMA = [
  "CREATE TABLE `geo_tags` (",
  "  `gt_id` int(10) unsigned NOT NULL AUTO_INCREMENT,",
  "  `gt_page_id` int(10) unsigned NOT NULL DEFAULT '0',",
  "  `gt_globe` varbinary(32) NOT NULL DEFAULT 'earth',",
  "  `gt_primary` tinyint(4) NOT NULL DEFAULT '0',",
  "  `gt_lat` float DEFAULT NULL,",
  "  `gt_lon` float DEFAULT NULL,",
  "  `gt_dim` int(11) DEFAULT NULL,",
  "  `gt_type` varbinary(32) DEFAULT NULL,",
  "  `gt_name` varbinary(255) DEFAULT NULL,",
  "  `gt_country` varbinary(2) DEFAULT NULL,",
  "  `gt_region` varbinary(10) DEFAULT NULL,",
  "  `gt_lat_int` smallint(6) DEFAULT NULL,",
  "  `gt_lon_int` smallint(6) DEFAULT NULL,",
  "  PRIMARY KEY (`gt_id`)",
  ") ENGINE=InnoDB;",
].join("\n");

function makePageDump(
  rows: Array<{ id: number; ns: number; title: string; redirect: number }>,
): string {
  const values = rows
    .map(
      (r) =>
        `(${r.id},${r.ns},'${r.title}',${r.redirect},0,0.5,'20260101000000',NULL,1,100,'wikitext',NULL)`,
    )
    .join(",");
  return `${PAGE_SCHEMA}\n\nINSERT INTO \`page\` VALUES ${values};`;
}

function makeGeoDump(
  rows: Array<{
    id: number;
    pageId: number;
    globe: string;
    primary: number;
    lat: number;
    lon: number;
  }>,
): string {
  const values = rows
    .map(
      (r) =>
        `(${r.id},${r.pageId},'${r.globe}',${r.primary},${r.lat},${r.lon},10000,'landmark','',NULL,NULL,0,NULL)`,
    )
    .join(",");
  return `${GEO_SCHEMA}\n\nINSERT INTO \`geo_tags\` VALUES ${values};`;
}

// ---------- Tests ----------

describe("buildPageMap", () => {
  const testDir = join(tmpdir(), "extract-dump-page-" + Date.now());

  beforeAll(() => mkdirSync(testDir, { recursive: true }));
  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  it("builds map of article pages, filtering redirects and non-zero namespaces", async () => {
    const sql = makePageDump([
      { id: 1, ns: 0, title: "Eiffel_Tower", redirect: 0 },
      { id: 2, ns: 0, title: "Tour_Eiffel", redirect: 1 }, // redirect
      { id: 3, ns: 14, title: "Category:Towers", redirect: 0 }, // non-article namespace
      { id: 4, ns: 0, title: "Statue_of_Liberty", redirect: 0 },
    ]);

    const path = gzFile(testDir, "page.sql.gz", sql);
    const map = await buildPageMap(path);

    expect(map.size).toBe(2);
    expect(map.get(1)).toBe("Eiffel Tower"); // underscores converted to spaces
    expect(map.get(4)).toBe("Statue of Liberty");
    expect(map.has(2)).toBe(false); // redirect
    expect(map.has(3)).toBe(false); // wrong namespace
  });
});

describe("streamGeoArticles", () => {
  const testDir = join(tmpdir(), "extract-dump-geo-" + Date.now());

  beforeAll(() => mkdirSync(testDir, { recursive: true }));
  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  it("joins geo_tags with page map", async () => {
    const geoSql = makeGeoDump([
      {
        id: 1,
        pageId: 100,
        globe: "earth",
        primary: 1,
        lat: 48.8584,
        lon: 2.2945,
      },
      {
        id: 2,
        pageId: 200,
        globe: "earth",
        primary: 1,
        lat: 40.7128,
        lon: -74.006,
      },
      {
        id: 3,
        pageId: 300,
        globe: "earth",
        primary: 1,
        lat: 51.5074,
        lon: -0.1278,
      }, // no page entry
    ]);

    const geoPath = gzFile(testDir, "geo_tags.sql.gz", geoSql);

    const pages = new Map<number, string>([
      [100, "Eiffel Tower"],
      [200, "Statue of Liberty"],
    ]);

    const articles: Article[] = [];
    for await (const article of streamGeoArticles(geoPath, pages)) {
      articles.push(article);
    }

    expect(articles).toHaveLength(2);
    expect(articles[0].title).toBe("Eiffel Tower");
    expect(articles[1].title).toBe("Statue of Liberty");
  });

  it("filters non-earth globes and non-primary tags", async () => {
    const geoSql = makeGeoDump([
      {
        id: 1,
        pageId: 100,
        globe: "earth",
        primary: 1,
        lat: 48.8584,
        lon: 2.2945,
      },
      { id: 2, pageId: 200, globe: "moon", primary: 1, lat: 10.0, lon: 20.0 },
      {
        id: 3,
        pageId: 300,
        globe: "earth",
        primary: 0,
        lat: 51.5074,
        lon: -0.1278,
      },
    ]);

    const geoPath = gzFile(testDir, "geo_tags_filter.sql.gz", geoSql);

    const pages = new Map<number, string>([
      [100, "Paris"],
      [200, "Moon Base"],
      [300, "London"],
    ]);

    const articles: Article[] = [];
    for await (const article of streamGeoArticles(geoPath, pages)) {
      articles.push(article);
    }

    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("Paris");
  });

  it("filters by bounds", async () => {
    const geoSql = makeGeoDump([
      {
        id: 1,
        pageId: 100,
        globe: "earth",
        primary: 1,
        lat: 48.8584,
        lon: 2.2945,
      }, // Paris
      {
        id: 2,
        pageId: 200,
        globe: "earth",
        primary: 1,
        lat: 40.7128,
        lon: -74.006,
      }, // NYC
    ]);

    const geoPath = gzFile(testDir, "geo_tags_bounds.sql.gz", geoSql);

    const pages = new Map<number, string>([
      [100, "Paris"],
      [200, "NYC"],
    ]);

    const articles: Article[] = [];
    for await (const article of streamGeoArticles(geoPath, pages, {
      bounds: { south: 45, north: 55, west: -5, east: 10 },
    })) {
      articles.push(article);
    }

    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("Paris");
  });

  it("rejects Null Island coordinates", async () => {
    const geoSql = makeGeoDump([
      { id: 1, pageId: 100, globe: "earth", primary: 1, lat: 0, lon: 0 },
    ]);

    const geoPath = gzFile(testDir, "geo_tags_null_island.sql.gz", geoSql);

    const pages = new Map<number, string>([[100, "Null Island"]]);

    const articles: Article[] = [];
    for await (const article of streamGeoArticles(geoPath, pages)) {
      articles.push(article);
    }

    expect(articles).toHaveLength(0);
  });
});

describe("extractDump (integration)", () => {
  const testDir = join(tmpdir(), "extract-dump-integration-" + Date.now());

  beforeAll(() => mkdirSync(testDir, { recursive: true }));
  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  it("runs full extraction pipeline with fixture dumps", async () => {
    const dumpsDir = join(testDir, "dumps");
    mkdirSync(dumpsDir, { recursive: true });

    // Create fixture dumps
    gzFile(
      dumpsDir,
      "svwiki-latest-page.sql.gz",
      makePageDump([
        { id: 100, ns: 0, title: "Eiffeltornet", redirect: 0 },
        { id: 200, ns: 0, title: "Frihetsgudinnan", redirect: 0 },
        { id: 300, ns: 0, title: "Redirect_Page", redirect: 1 },
        { id: 400, ns: 0, title: "Liljeholmens_brandstation", redirect: 0 },
      ]),
    );

    gzFile(
      dumpsDir,
      "svwiki-latest-geo_tags.sql.gz",
      makeGeoDump([
        {
          id: 1,
          pageId: 100,
          globe: "earth",
          primary: 1,
          lat: 48.8584,
          lon: 2.2945,
        },
        {
          id: 2,
          pageId: 200,
          globe: "earth",
          primary: 1,
          lat: 40.7128,
          lon: -74.006,
        },
        {
          id: 3,
          pageId: 300,
          globe: "earth",
          primary: 1,
          lat: 51.5,
          lon: -0.1,
        }, // redirect
        {
          id: 4,
          pageId: 400,
          globe: "earth",
          primary: 1,
          lat: 59.308,
          lon: 18.028,
        },
        { id: 5, pageId: 999, globe: "earth", primary: 1, lat: 0, lon: 0 }, // no page entry
      ]),
    );

    const outputPath = join(testDir, "articles-sv.json");

    const result = await extractDump({
      lang: "sv",
      skipDownload: true,
      dumpsDir,
      outputPath,
    });

    expect(result.articleCount).toBe(3); // Eiffeltornet, Frihetsgudinnan, Liljeholmens
    expect(result.outputPath).toBe(outputPath);

    // Verify NDJSON output
    const lines = readFileSync(outputPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);

    const articles = lines.map((l) => JSON.parse(l) as Article);

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
    const dumpsDir = join(testDir, "dumps-bounds");
    mkdirSync(dumpsDir, { recursive: true });

    gzFile(
      dumpsDir,
      "svwiki-latest-page.sql.gz",
      makePageDump([
        { id: 100, ns: 0, title: "Paris", redirect: 0 },
        { id: 200, ns: 0, title: "Stockholm", redirect: 0 },
      ]),
    );

    gzFile(
      dumpsDir,
      "svwiki-latest-geo_tags.sql.gz",
      makeGeoDump([
        {
          id: 1,
          pageId: 100,
          globe: "earth",
          primary: 1,
          lat: 48.8584,
          lon: 2.2945,
        },
        {
          id: 2,
          pageId: 200,
          globe: "earth",
          primary: 1,
          lat: 59.33,
          lon: 18.07,
        },
      ]),
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
    const dumpsDir = join(testDir, "dumps-dedup");
    mkdirSync(dumpsDir, { recursive: true });

    gzFile(
      dumpsDir,
      "svwiki-latest-page.sql.gz",
      makePageDump([{ id: 100, ns: 0, title: "Same_Place", redirect: 0 }]),
    );

    // Two geo_tags for the same page (different gt_ids, both primary)
    gzFile(
      dumpsDir,
      "svwiki-latest-geo_tags.sql.gz",
      makeGeoDump([
        { id: 1, pageId: 100, globe: "earth", primary: 1, lat: 48.0, lon: 2.0 },
        { id: 2, pageId: 100, globe: "earth", primary: 1, lat: 49.0, lon: 3.0 },
      ]),
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
